const crypto = require("crypto");
const { WebSocket, WebSocketServer } = require("ws");
const {
  ALLOWED_ORIGINS,
  AUDIT_ACTIONS,
  MONITOR_COOKIE,
  PROTOCOL_VERSION,
  SESSION_COOKIE,
  WS_DEAD_CLIENT_MS,
  WS_HANDSHAKE_TIMEOUT_MS,
  WS_MAX_BUFFERED_BYTES,
  WS_MAX_CONNECTIONS,
  WS_MAX_CONNECTIONS_PER_IP,
  WS_MAX_INFLIGHT,
  WS_MAX_PAYLOAD_BYTES,
  WS_MAX_SUBSCRIPTIONS,
  WS_PING_INTERVAL_MS,
  WS_REQUEST_BURST,
  WS_REQUEST_RATE,
} = require("./config.js");
const dataStore = require("./dataStore.js");
const dataPoller = require("./dataPoller.js");
const stateStore = require("./stateStore.js");
const courtPoller = require("./courtPoller.js");
const { AppError, errorData } = require("./errors.js");
const { validateEndpointRequest, validateEndpointResponse } = require("./contracts.js");
const { TokenBucketLimiter, assertAllowedOrigin, getRequestIp, parseCookies } = require("./security.js");
const { analyzeMatchRules, matchCompletionFingerprint, parseMatchDate, parseParticipant } = require("./matchRules.js");
const { parseParticipantId } = require("./matchResultRules.js");
const { projectPeopleNormalization } = require("./peopleNormalization.js");
const { projectPeopleReconciliation } = require("./memberReconciliation.js");
const { inspectMatchtypDisplayRules, projectScoreboardScores } = require("./scoreboardDisplay.js");
const { headerIndex, headerOf } = require("./tableUtils.js");
const logger = require("./logger.js");
const metrics = require("./metrics.js");
const {
  booleanValue,
  idValue,
  integerValue,
  operationId,
  requireObject,
  stringValue,
} = require("./validators.js");

let wss = null;
let upgradeHandler = null;
let pingTimer = null;
let dependencies = null;
let shuttingDown = false;
const clients = new Map();
const connectionsByIp = new Map();
const upgradeLimiter = new TokenBucketLimiter({ rate: 2, burst: 10 });
const writeLimiter = new TokenBucketLimiter({ rate: 0.2, burst: 6, idleMs: 900000 });
const unsubscribeCallbacks = [];
const activeHandlers = new Set();
const REQUEST_HISTORY_LIMIT = 20;
const PUBLIC_TOPICS = new Set(["scores", "scoreboard-state", "matches", "players", "bewerbe", "bewerbsart", "matchtyp", "entryList", "ranking"]);
const PUBLIC_COLUMNS = {
  bewerbe: ["id", "bezeichnung", "bewerbsartid", "geschlecht", "entrystart", "entrydeadline", "bewerbsbeginn", "bewerbsende", "sortorder"],
  bewerbsart: ["id", "bezeichnung", "entrylistavailable", "roundrobin", "rasterfunktion", "spezifikum"],
  matches1: ["ignore", "id", "matchdate", "matchende", "forderungdate", "bewerbid", "bewerbrunde", "spieler1id", "spieler2id", "spieler3id", "spieler4id", "ergebnis"],
  rlPlatzierung: ["id", "bewerbid", "personid", "rang"],
  entryList: ["id", "bewerbid", "personenid", "entrydate"],
};

function shouldAudit(action) {
  return AUDIT_ACTIONS.has("*") || AUDIT_ACTIONS.has(action);
}

function cachedMatchCompetitionId(matchId) {
  try {
    const values = dataStore.get("matches1");
    const header = headerOf(values);
    const idIndex = headerIndex(header, "id");
    const competitionIndex = headerIndex(header, "bewerbid");
    const row = values.slice(1).find((entry) => String(entry[idIndex] || "").trim() === String(matchId));
    return row ? String(row[competitionIndex] || "").trim() : "";
  } catch {
    return "";
  }
}

function auditProjection(endpoint, params, result = {}, internal = null) {
  switch (endpoint) {
    case "addMatch":
      return {
        targetType: "person",
        targetId: params.opponentId,
        targetName: personDisplayName(params.opponentId),
        before: { bewerbId: params.bewerbId, opponentId: params.opponentId },
        after: { matchId: result.newMatchId || "", bewerbId: params.bewerbId, opponentId: params.opponentId },
      };
    case "setRankingMatchDate":
      return {
        targetType: "match",
        targetId: params.matchId,
        before: internal?.before || { matchId: params.matchId, matchDate: "" },
        after: internal?.after || { matchId: params.matchId, matchDate: params.matchDate },
      };
    case "adminDeleteRankingChallenge":
      return {
        targetType: "match",
        targetId: params.matchId,
        before: internal?.before || { matchId: params.matchId, reasonRecorded: true },
        after: internal?.after || (result.success ? { deleted: true, reasonRecorded: true } : null),
      };
    case "adminSetRankingChallengeDate":
      return {
        targetType: "match",
        targetId: params.matchId,
        before: internal?.before || { matchId: params.matchId, reasonRecorded: true },
        after: internal?.after || { matchId: params.matchId, challengeDate: params.challengeDate, reasonRecorded: true },
      };
    case "adminSetRankingMatchDate":
      return {
        targetType: "match",
        targetId: params.matchId,
        before: internal?.before || { matchId: params.matchId, reasonRecorded: true },
        after: internal?.after || { matchId: params.matchId, matchDate: params.matchDate, reasonRecorded: true },
      };
    case "setMatchResult":
      return {
        targetType: "match",
        targetId: params.matchId,
        before: internal?.before || { matchId: params.matchId, competitionId: cachedMatchCompetitionId(params.matchId) },
        after: internal?.after || null,
      };
    case "adminCorrectRankingResult":
    case "adminSetMatchEnd":
    case "adminClearMatchResult":
      return {
        targetType: "match",
        targetId: params.matchId,
        before: internal?.before || { matchId: params.matchId, competitionId: cachedMatchCompetitionId(params.matchId), reasonRecorded: true },
        after: internal?.after || null,
      };
    case "acknowledgeMessage":
      return {
        targetType: "message",
        targetId: params.messageId,
        before: result.success ? { acknowledged: !result.changed } : null,
        after: result.success ? { acknowledged: true } : null,
      };
    case "addEntryList":
      return { targetType: "entry", targetId: result.entryId || "", after: { entryId: result.entryId || "", bewerbId: params.bewerbId, alreadyPresent: !!result.alreadyPresent } };
    case "removeEntryList":
      return { targetType: "entry", targetId: internal?.before?.recordId || "", before: internal?.before || null, after: internal?.after || null };
    case "withdrawFromRanking":
      return { targetType: "ranking", targetId: params.bewerbId, before: internal?.before || { bewerbId: params.bewerbId, rank: params.rank }, after: internal?.after || null };
    case "courtAssign":
    case "courtSetActive":
      return {
        targetType: "court",
        targetId: params.court,
        before: { expectedRevision: params.expectedRevision },
        after: result.court ? { matchId: result.court.matchId || "", aktiv: result.court.aktiv, revision: result.court.revision } : null,
      };
    case "monitorNavigate":
      return { targetType: "monitor", targetId: params.monitorId, after: { commandId: result.commandId || "", path: params.path, delivery: result.delivery || "" } };
    case "monitorScroll":
      return { targetType: "monitor", targetId: params.monitorId, after: { commandId: result.commandId || "", direction: params.direction, sequence: result.seq || 0 } };
    case "monitorProvision":
      return { targetType: "monitor", targetId: result.monitor?.monitorId || "", after: { monitorId: result.monitor?.monitorId || "", label: result.monitor?.label || params.label } };
    case "monitorRotate":
    case "monitorRevoke":
      return { targetType: "monitor", targetId: params.monitorId, after: { monitorId: params.monitorId } };
    case "normalizePerson":
      return {
        targetType: "person",
        targetId: params.personId,
        targetName: internal?.targetName || personDisplayName(params.personId),
        before: internal?.before || null,
        after: internal?.after || null,
      };
    case "reconcilePerson": {
      const targetId = result.personId || params.personId || params.externalId;
      return {
        targetType: "person",
        targetId,
        targetName: internal?.targetName || personDisplayName(targetId),
        before: internal?.before || null,
        after: internal?.after || null,
      };
    }
    case "refreshSheetData":
      return {
        targetType: "sheet-cache",
        targetId: "all",
        before: null,
        after: internal?.after || (result.success ? {
          tableCount: result.tableCount || 0,
          changedTableCount: Array.isArray(result.changedTables) ? result.changedTables.length : 0,
          refreshedAt: result.refreshedAt || null,
        } : null),
      };
    default:
      return { targetType: "", targetId: "", before: null, after: null };
  }
}

function personDisplayName(personId) {
  const values = dataStore.get("players");
  const header = headerOf(values);
  const idIndex = headerIndex(header, "id");
  const firstNameIndex = headerIndex(header, "vorname");
  const lastNameIndex = headerIndex(header, "nachname");
  const row = values.slice(1).find((entry) => String(entry[idIndex] || "").trim() === String(personId || "").trim());
  if (!row) return "";
  return [row[firstNameIndex], row[lastNameIndex]].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
}

function profileRankings(personId, principal = null) {
  requireCurrentTables("bewerbe", "matches1", "players", "rlPlatzierung");
  const competitions = dataStore.get("bewerbe");
  const competitionHeader = headerOf(competitions);
  const competitionIndexes = {
    id: headerIndex(competitionHeader, "id"),
    name: headerIndex(competitionHeader, "bezeichnung"),
    type: headerIndex(competitionHeader, "bewerbsartid"),
    sortOrder: headerIndex(competitionHeader, "sortorder"),
  };
  const rankingCompetitions = new Map(competitions.slice(1)
    .filter((row) => String(row[competitionIndexes.type] || "").trim() === "2")
    .map((row) => {
      const id = String(row[competitionIndexes.id] || "").trim();
      return [id, {
        competitionId: id,
        competitionName: String(row[competitionIndexes.name] || "").trim(),
        sortOrder: competitionIndexes.sortOrder < 0 || String(row[competitionIndexes.sortOrder] || "").trim() === ""
          ? Number.POSITIVE_INFINITY
          : Number(row[competitionIndexes.sortOrder]),
      }];
    })
    .filter(([id]) => id));
  const rankings = dataStore.get("rlPlatzierung");
  const rankingHeader = headerOf(rankings);
  const rankingIndexes = {
    competition: headerIndex(rankingHeader, "bewerbid"),
    person: headerIndex(rankingHeader, "personid"),
    rank: headerIndex(rankingHeader, "rang"),
    withdrawnAt: headerIndex(rankingHeader, "rausgehangenam"),
    previousRank: headerIndex(rankingHeader, "rausgehangenletzteplatzierung"),
    reason: headerIndex(rankingHeader, "rausgehangengrund"),
  };
  const activeRanks = new Map(rankings.slice(1).flatMap((row) => {
    const competitionId = String(row[rankingIndexes.competition] || "").trim();
    const rankedPersonId = String(row[rankingIndexes.person] || "").trim();
    const rank = Number(row[rankingIndexes.rank]);
    return competitionId && rankedPersonId && Number.isInteger(rank) && rank > 0
      ? [[`${competitionId}\0${rankedPersonId}`, rank]]
      : [];
  }));
  const matches = dataStore.get("matches1");
  const matchHeader = headerOf(matches);
  const matchIndexes = {
    ignore: headerIndex(matchHeader, "ignore"),
    id: headerIndex(matchHeader, "id"),
    competition: headerIndex(matchHeader, "bewerbid"),
    matchDate: headerIndex(matchHeader, "matchdate"),
    challengedAt: headerIndex(matchHeader, "forderungdate"),
    result: headerIndex(matchHeader, "ergebnis"),
    p1: headerIndex(matchHeader, "spieler1id"),
    p2: headerIndex(matchHeader, "spieler2id"),
    p3: headerIndex(matchHeader, "spieler3id"),
    p4: headerIndex(matchHeader, "spieler4id"),
  };
  const names = playerNameMap();
  const openChallenge = (competitionId) => {
    const row = matches.slice(1).find((entry) => {
      if (matchIndexes.ignore >= 0 && String(entry[matchIndexes.ignore] || "").trim() === "1") return false;
      if (String(entry[matchIndexes.competition] || "").trim() !== competitionId) return false;
      if (!String(entry[matchIndexes.challengedAt] || "").trim()) return false;
      if (String(entry[matchIndexes.result] || "").trim()) return false;
      const participants = [matchIndexes.p1, matchIndexes.p2, matchIndexes.p3, matchIndexes.p4]
        .filter((index) => index >= 0)
        .map((index) => parseParticipant(entry[index]));
      const challengerId = parseParticipant(entry[matchIndexes.p1]).id;
      const challengedId = parseParticipant(entry[matchIndexes.p3]).id;
      return participants.every((participant) => !participant.retired)
        && challengerId
        && challengedId
        && challengerId !== challengedId
        && [challengerId, challengedId].includes(String(personId));
    });
    if (!row) return null;
    const challengerId = parseParticipant(row[matchIndexes.p1]).id;
    const challengedId = parseParticipant(row[matchIndexes.p3]).id;
    const direction = challengerId === String(personId) ? "challenger" : "challenged";
    const opponentId = direction === "challenger" ? challengedId : challengerId;
    return {
      matchId: String(row[matchIndexes.id] || "").trim(),
      direction,
      opponentId,
      opponentName: names.get(opponentId) || "Unbekannter Spieler",
      opponentRank: activeRanks.get(`${competitionId}\0${opponentId}`) || null,
      challengedAt: String(row[matchIndexes.challengedAt] || "").trim(),
      ...(String(row[matchIndexes.matchDate] || "").trim() ? {
        matchDate: String(row[matchIndexes.matchDate] || "").trim(),
      } : {}),
    };
  };
  const projected = rankings.slice(1).flatMap((row) => {
    if (String(row[rankingIndexes.person] || "").trim() !== String(personId)) return [];
    const competition = rankingCompetitions.get(String(row[rankingIndexes.competition] || "").trim());
    if (!competition) return [];
    const rank = Number(row[rankingIndexes.rank]);
    const withdrawn = rank === 0;
    const withdrawnAt = String(row[rankingIndexes.withdrawnAt] || "").trim();
    const returnExpiresAt = parseMatchDate(withdrawnAt);
    if (returnExpiresAt) returnExpiresAt.setFullYear(returnExpiresAt.getFullYear() + 1);
    const ownReturnAvailable = withdrawn
      && principal?.type === "user"
      && String(principal.id || "") === String(personId)
      && returnExpiresAt
      && new Date() <= returnExpiresAt;
    const challenge = openChallenge(competition.competitionId);
    const canChallenge = !withdrawn
      && principal?.type === "user"
      && String(principal.id || "") !== String(personId)
      && dependencies.sheetService.challengeEligibility(principal, competition.competitionId, String(personId)).allowed;
    return [{
      competitionId: competition.competitionId,
      competitionName: competition.competitionName,
      rank,
      status: withdrawn ? "withdrawn" : "active",
      canChallenge,
      canWithdraw: !withdrawn && principal?.type === "user" && String(principal.id || "") === String(personId) && !challenge,
      openChallenge: challenge,
      ...(withdrawn && principal?.type === "user" ? {
        withdrawal: {
          withdrawnAt,
          reason: String(row[rankingIndexes.reason] || "").trim(),
          ...(ownReturnAvailable ? {
            previousRank: Number(row[rankingIndexes.previousRank]),
          } : {}),
        },
      } : {}),
      sortOrder: competition.sortOrder,
    }];
  });
  const projectedCompetitionIds = new Set(projected.map(({ competitionId }) => competitionId));
  for (const competition of rankingCompetitions.values()) {
    if (projectedCompetitionIds.has(competition.competitionId)) continue;
    const challenge = openChallenge(competition.competitionId);
    if (!challenge) continue;
    projected.push({
      competitionId: competition.competitionId,
      competitionName: competition.competitionName,
      rank: null,
      status: "active",
      canChallenge: false,
      canWithdraw: false,
      openChallenge: challenge,
      sortOrder: competition.sortOrder,
    });
  }
  return projected.sort((left, right) => (
    left.sortOrder - right.sortOrder
    || left.competitionName.localeCompare(right.competitionName, "de")
    || left.competitionId.localeCompare(right.competitionId, "de")
  )).map(({ sortOrder, ...ranking }) => ranking);
}

function profileCompetitionEnd(raw) {
  const value = String(raw || "").trim();
  const match = value.match(/^(\d{2}|\d{4})(\d{2})(\d{2})(?:-(\d{2})(\d{2}))?$/);
  if (!match) return null;
  const [, yearValue, month, day, hour, minute] = match;
  const year = yearValue.length === 2
    ? (Number(yearValue) >= 50 ? 1900 + Number(yearValue) : 2000 + Number(yearValue))
    : Number(yearValue);
  const date = new Date(
    year,
    Number(month) - 1,
    Number(day),
    hour === undefined ? 23 : Number(hour),
    minute === undefined ? 59 : Number(minute),
    hour === undefined ? 59 : 0,
  );
  return date.getFullYear() === year
    && date.getMonth() === Number(month) - 1
    && date.getDate() === Number(day)
    && date.getHours() === (hour === undefined ? 23 : Number(hour))
    && date.getMinutes() === (minute === undefined ? 59 : Number(minute))
    ? date
    : null;
}

function profileCompetitions(personId, principal = null) {
  requireCurrentTables("bewerbe", "bewerbsart", "matches1", "players", "rlPlatzierung");
  const competitions = dataStore.get("bewerbe");
  const competitionHeader = headerOf(competitions);
  const competitionIndexes = {
    id: headerIndex(competitionHeader, "id"),
    name: headerIndex(competitionHeader, "bezeichnung"),
    type: headerIndex(competitionHeader, "bewerbsartid"),
    end: headerIndex(competitionHeader, "bewerbsende"),
    sortOrder: headerIndex(competitionHeader, "sortorder"),
  };
  const types = dataStore.get("bewerbsart");
  const typeHeader = headerOf(types);
  const typeIds = new Set(types.slice(1).map((row) => String(row[headerIndex(typeHeader, "id")] || "").trim()).filter(Boolean));
  const competitionById = new Map(competitions.slice(1).flatMap((row) => {
    const competitionId = String(row[competitionIndexes.id] || "").trim();
    const typeId = String(row[competitionIndexes.type] || "").trim();
    if (!competitionId || !typeIds.has(typeId)) return [];
    const rawSortOrder = competitionIndexes.sortOrder < 0 ? "" : String(row[competitionIndexes.sortOrder] || "").trim();
    return [[competitionId, {
      competitionId,
      competitionName: String(row[competitionIndexes.name] || "").trim() || competitionId,
      competitionEnd: competitionIndexes.end < 0 ? null : profileCompetitionEnd(row[competitionIndexes.end]),
      ranking: typeId === "2",
      sortOrder: rawSortOrder === "" || !Number.isFinite(Number(rawSortOrder)) ? Number.POSITIVE_INFINITY : Number(rawSortOrder),
      matches: [],
    }]];
  }));
  const names = playerNameMap();
  const personIds = new Set(names.keys());
  const rankings = dataStore.get("rlPlatzierung");
  const rankingHeader = headerOf(rankings);
  const rankingIndexes = {
    competition: headerIndex(rankingHeader, "bewerbid"),
    person: headerIndex(rankingHeader, "personid"),
    rank: headerIndex(rankingHeader, "rang"),
  };
  const rankByCompetitionAndPerson = new Map(rankings.slice(1).map((row) => [
    `${String(row[rankingIndexes.competition] || "").trim()}\0${String(row[rankingIndexes.person] || "").trim()}`,
    Number(row[rankingIndexes.rank]),
  ]));
  const role = String(principal?.role || "").toLowerCase();
  const actorId = String(principal?.id || "");
  const admin = role === "admin";
  const participantRole = ["player", "player a", "player b"].includes(role);
  if (admin) {
    for (const competition of competitionById.values()) {
      if (!competition.ranking) continue;
      competition.rankingMembers = rankings.slice(1).flatMap((row) => {
        if (String(row[rankingIndexes.competition] || "").trim() !== competition.competitionId) return [];
        const memberId = String(row[rankingIndexes.person] || "").trim();
        return [{ personId: memberId, name: names.get(memberId) || "Unbekannter Spieler", rank: Number(row[rankingIndexes.rank]) }];
      });
    }
  }
  const matches = dataStore.get("matches1");
  const matchHeader = headerOf(matches);
  const indexes = {
    ignore: headerIndex(matchHeader, "ignore", "ignorieren"),
    id: headerIndex(matchHeader, "id"),
    competition: headerIndex(matchHeader, "bewerbid"),
    round: headerIndex(matchHeader, "bewerbrunde"),
    matchDate: headerIndex(matchHeader, "matchdate"),
    matchEnd: headerIndex(matchHeader, "matchende"),
    result: headerIndex(matchHeader, "ergebnis"),
    participants: ["spieler1id", "spieler2id", "spieler3id", "spieler4id"].map((name) => headerIndex(matchHeader, name)),
  };
  for (const row of matches.slice(1)) {
    if (indexes.ignore >= 0 && String(row[indexes.ignore] || "").trim() === "1") continue;
    const competition = competitionById.get(String(row[indexes.competition] || "").trim());
    if (!competition) continue;
    const participants = indexes.participants.map((index) => index < 0 ? { id: "", marker: null } : parseParticipantId(row[index]));
    if (!participants.some(({ id }) => id === String(personId))) continue;
    if (!participants[0].id || !participants[2].id
      || participants.some(({ id, marker }) => id && (marker && !["wo", "ret"].includes(marker) || !personIds.has(id)))) continue;
    const marker = participants.find((participant) => participant.marker)?.marker || null;
    const result = String(row[indexes.result] || "").trim();
    const completed = Boolean(result || marker);
    const cleanIds = participants.map(({ id }) => id).filter(Boolean);
    const defenderRank = rankByCompetitionAndPerson.get(`${competition.competitionId}\0${participants[2].id}`);
    const correctionBlockReason = competition.ranking && (!Number.isInteger(defenderRank) || defenderRank <= 0)
      ? "RANKING_REPAIR_REQUIRED"
      : null;
    competition.matches.push({
      matchId: String(row[indexes.id] || "").trim(),
      round: String(row[indexes.round] || "").trim(),
      matchDate: String(row[indexes.matchDate] || "").trim(),
      matchEnd: String(row[indexes.matchEnd] || "").trim(),
      result,
      completionType: marker === "wo" ? "walkover" : marker === "ret" ? "retirement" : "regular",
      teams: [participants.slice(0, 2), participants.slice(2, 4)].map((team) => ({
        ids: team.map(({ id }) => id).filter(Boolean),
        names: team.map(({ id }) => names.get(id)).filter(Boolean),
      })),
      status: completed ? "completed" : "open",
      fingerprint: matchCompletionFingerprint(row, matchHeader),
      canSetResult: admin || participantRole && cleanIds.includes(actorId),
      canAdminSetMatchEnd: admin && completed,
      canAdminClear: admin && completed,
      ...(correctionBlockReason ? { correctionBlockReason } : {}),
    });
  }

  const now = new Date();
  return [...competitionById.values()].flatMap((competition) => {
    const hasOpen = competition.matches.some((match) => match.status === "open");
    const completedVisible = competition.competitionEnd ? now <= competition.competitionEnd : hasOpen;
    const visibleMatches = competition.matches.filter((match) => match.status === "open" || completedVisible);
    if (!visibleMatches.length) return [];
    visibleMatches.sort((left, right) => (
      (left.status === "open" ? 0 : 1) - (right.status === "open" ? 0 : 1)
      || left.matchDate.localeCompare(right.matchDate, "de")
      || left.round.localeCompare(right.round, "de")
      || left.matchId.localeCompare(right.matchId, "de")
    ));
    return [{
      competitionId: competition.competitionId,
      competitionName: competition.competitionName,
      ranking: competition.ranking,
      ...(admin && competition.ranking ? { rankingMembers: competition.rankingMembers } : {}),
      matches: visibleMatches,
      sortOrder: competition.sortOrder,
    }];
  }).sort((left, right) => (
    left.sortOrder - right.sortOrder
    || left.competitionName.localeCompare(right.competitionName, "de")
    || left.competitionId.localeCompare(right.competitionId, "de")
  )).map(({ sortOrder, ...competition }) => competition);
}

function withdrawnRankingPlayers(competitionId) {
  requireCurrentTables("bewerbe", "matches1", "players", "rlPlatzierung");
  const competitions = dataStore.get("bewerbe");
  const competitionHeader = headerOf(competitions);
  const competitionRow = competitions.slice(1).find((row) => String(row[headerIndex(competitionHeader, "id")] || "").trim() === competitionId);
  if (!competitionRow || String(competitionRow[headerIndex(competitionHeader, "bewerbsartid")] || "").trim() !== "2") {
    throw new AppError("RANKING_REQUIRED", "Bewerb ist keine Rangliste", 409);
  }
  const values = dataStore.get("rlPlatzierung");
  const header = headerOf(values);
  const indexes = {
    competition: headerIndex(header, "bewerbid"),
    person: headerIndex(header, "personid"),
    rank: headerIndex(header, "rang"),
    withdrawnAt: headerIndex(header, "rausgehangenam"),
    previousRank: headerIndex(header, "rausgehangenletzteplatzierung"),
    reason: headerIndex(header, "rausgehangengrund"),
  };
  const names = playerNameMap();
  const activeRanks = new Map(values.slice(1).flatMap((row) => {
    if (String(row[indexes.competition] || "").trim() !== competitionId) return [];
    const rank = Number(row[indexes.rank]);
    const personId = String(row[indexes.person] || "").trim();
    return personId && Number.isInteger(rank) && rank > 0 ? [[personId, rank]] : [];
  }));
  const matches = dataStore.get("matches1");
  const matchHeader = headerOf(matches);
  const matchIndexes = {
    ignore: headerIndex(matchHeader, "ignore"),
    competition: headerIndex(matchHeader, "bewerbid"),
    challengedAt: headerIndex(matchHeader, "forderungdate"),
    challenger: headerIndex(matchHeader, "spieler1id"),
    opponent: headerIndex(matchHeader, "spieler3id"),
  };
  const returnChallenge = (personId, withdrawnAt) => {
    const withdrawnTime = parseMatchDate(withdrawnAt)?.getTime();
    const match = matches.slice(1).filter((row) => {
      if (matchIndexes.ignore >= 0 && String(row[matchIndexes.ignore] || "").trim() === "1") return false;
      if (String(row[matchIndexes.competition] || "").trim() !== competitionId) return false;
      if (parseParticipant(row[matchIndexes.challenger]).id !== personId) return false;
      const challengedTime = parseMatchDate(row[matchIndexes.challengedAt])?.getTime();
      return Number.isFinite(challengedTime) && Number.isFinite(withdrawnTime) && challengedTime > withdrawnTime;
    }).sort((left, right) => (
      String(right[matchIndexes.challengedAt] || "").localeCompare(String(left[matchIndexes.challengedAt] || ""))
    ))[0];
    if (!match) return null;
    const opponentId = parseParticipant(match[matchIndexes.opponent]).id;
    return {
      challengedAt: String(match[matchIndexes.challengedAt] || "").trim(),
      opponentId,
      opponentName: names.get(opponentId) || "Unbekannter Spieler",
      opponentRank: activeRanks.get(opponentId) || null,
    };
  };
  const players = values.slice(1).flatMap((row) => {
    if (String(row[indexes.competition] || "").trim() !== competitionId || Number(row[indexes.rank]) !== 0) return [];
    const personId = String(row[indexes.person] || "").trim();
    return [{
      personId,
      name: names.get(personId) || "Unbekannter Spieler",
      withdrawnAt: String(row[indexes.withdrawnAt] || "").trim(),
      previousRank: Number(row[indexes.previousRank]),
      reason: String(row[indexes.reason] || "").trim(),
      returnChallenge: returnChallenge(personId, String(row[indexes.withdrawnAt] || "").trim()),
    }];
  }).sort((left, right) => right.withdrawnAt.localeCompare(left.withdrawnAt) || left.name.localeCompare(right.name, "de"));
  return {
    competitionId,
    competitionName: String(competitionRow[headerIndex(competitionHeader, "bezeichnung")] || "").trim(),
    players,
  };
}

function writeAudit({ eventId, principal, endpoint, params, result = {}, internal = null, outcome, error = null }) {
  if (!dependencies.auditLogRepository || !shouldAudit(endpoint)) return;
  const projection = auditProjection(endpoint, params, result, internal);
  dependencies.auditLogRepository.record({
    eventId,
    actorType: principal.type,
    actorId: principal.id,
    actorName: principal.name || "",
    role: principal.role,
    action: endpoint,
    targetType: projection.targetType,
    targetId: projection.targetId,
    targetName: projection.targetName || "",
    requestId: eventId,
    operationId: params.operationId || "",
    result: outcome,
    before: projection.before,
    after: outcome === "success" ? projection.after : null,
    errorCode: error?.code || null,
  });
}

function requireCurrentTables(...tableNames) {
  for (const tableName of tableNames) {
    if (!dataStore.isTableCurrent(tableName)) {
      throw new AppError("DATA_NOT_READY", `Tabelle ${tableName} ist nicht aktuell`, 503);
    }
  }
}

function publicTable(tableName, values = dataStore.get(tableName)) {
  if (!Array.isArray(values) || !values.length) return [];
  const allowed = new Set(PUBLIC_COLUMNS[tableName] || []);
  const indexes = headerOf(values)
    .map((name, index) => (allowed.has(name) ? index : -1))
    .filter((index) => index >= 0);
  return values.map((row) => indexes.map((index) => row[index]));
}

function matchRowContext(matchId) {
  requireCurrentTables("matches1");
  const values = dataStore.get("matches1");
  const header = headerOf(values);
  const idIndex = headerIndex(header, "id");
  const row = values.slice(1).find((entry) => String(entry[idIndex] || "").trim() === matchId);
  if (!row) throw new AppError("MATCH_NOT_FOUND", "Match wurde nicht gefunden", 404);
  const participantIds = ["spieler1id", "spieler2id", "spieler3id", "spieler4id"]
    .map((name) => headerIndex(header, name))
    .filter((index) => index >= 0)
    .map((index) => parseParticipantId(row[index]).id)
    .filter(Boolean);
  return { header, row, participantIds };
}

function resultSuggestion(params, principal) {
  const context = matchRowContext(params.matchId);
  if (principal.role !== "admin" && !context.participantIds.includes(String(principal.id))) {
    throw new AppError("MATCH_PARTICIPANT_REQUIRED", "Nur Beteiligte duerfen einen Ergebnisvorschlag lesen", 403);
  }
  const state = stateStore.getCourt(params.court);
  let score = null;
  let source = { type: "none", court: params.court };
  if (String(state.matchId || "") === params.matchId) {
    const snapshot = courtPoller.getLastData();
    const live = snapshot.courts.find((entry) => String(entry.platz) === params.court);
    if (live) {
      score = [live.satz1home, live.satz1gast, live.satz2home, live.satz2gast, live.satz3home, live.satz3gast];
      source = { type: "court", court: params.court, revision: snapshot.revision };
    }
  } else {
    const logged = dependencies.scoreLogRepository?.getLatestByMatchIdAndCourt(params.matchId, params.court) || null;
    if (logged) {
      score = logged.score.split("/").slice(0, 3).flatMap((set) => set.split("-"));
      source = { type: "scoreLog", court: params.court, sequence: logged.sequence, occurredAt: logged.occurredAt };
    }
  }
  const sets = score ? [0, 2, 4].map((index) => `${Number(score[index]) || 0}-${Number(score[index + 1]) || 0}`) : [];
  while (sets.at(-1) === "0-0") sets.pop();
  return {
    success: true,
    matchId: params.matchId,
    court: params.court,
    suggestion: { result: sets.join("/"), sets },
    source,
    expectedFingerprint: matchCompletionFingerprint(context.row, context.header),
  };
}

function filterIgnored(values) {
  if (!Array.isArray(values) || values.length < 2) return values || [];
  const header = headerOf(values);
  const ignoreIndex = headerIndex(header, "ignore", "ignorieren");
  if (ignoreIndex < 0) return values;
  return [values[0], ...values.slice(1).filter((row) => String(row[ignoreIndex] || "").trim() !== "1")];
}

function filterByField(values, fieldName, fieldValue) {
  if (!fieldValue || !Array.isArray(values) || values.length < 2) return values || [];
  const header = headerOf(values);
  const index = headerIndex(header, fieldName);
  if (index < 0) throw new AppError("SHEET_SCHEMA", `Filterspalte ${fieldName} fehlt`, 503);
  return [values[0], ...values.slice(1).filter((row) => String(row[index] || "").trim() === String(fieldValue).trim())];
}

function playerNameMap() {
  return new Map(dependencies.authService.parsePeople().map((person) => [person.id, [person.firstName, person.lastName].filter(Boolean).join(" ")]));
}

function parsePlayerId(raw) {
  const value = String(raw || "").trim();
  const markerLength = value.endsWith("[wo]") ? 4 : value.endsWith("[ret]") ? 5 : 0;
  const withoutMarker = markerLength ? value.slice(0, -markerLength).trim() : value;
  return withoutMarker.replace(/\[gesetzt\]/gi, "").trim();
}

function readMatchRestrictions(params) {
  const competitionId = params?.bewerbId ? idValue(params.bewerbId, "bewerbId") : null;
  const rules = analyzeMatchRules(dataStore.get("matches1"), competitionId);
  const rankings = dataStore.get("rlPlatzierung");
  const rankingHeader = headerOf(rankings);
  const rankingIndexes = {
    competition: headerIndex(rankingHeader, "bewerbid"),
    person: headerIndex(rankingHeader, "personid"),
    withdrawnAt: headerIndex(rankingHeader, "rausgehangenam"),
  };
  const withdrawalByPerson = new Map(rankings.slice(1).flatMap((row) => {
    if (competitionId && String(row[rankingIndexes.competition] || "").trim() !== competitionId) return [];
    const at = parseMatchDate(row[rankingIndexes.withdrawnAt]);
    return at ? [[String(row[rankingIndexes.person] || "").trim(), at]] : [];
  }));
  const protection = [...rules.protection.entries()].filter(([id, until]) => {
    const withdrawnAt = withdrawalByPerson.get(id);
    return !withdrawnAt || new Date(until.getTime() - (7 * 24 * 60 * 60 * 1000)) > withdrawnAt;
  });
  const entry = ([id, until]) => ({ id, until: until.toISOString() });
  return {
    success: true,
    complete: true,
    schonzeit: protection.map(entry),
    sperrzeit: [...rules.blocked.entries()].map(entry),
  };
}

function compileNavigator(params) {
  const profile = params?.profil ? stringValue(params.profil, "profil", { max: 32 }) : "1";
  const values = dataStore.get("navigator");
  if (values.length < 2) return { success: true, items: [] };
  const header = headerOf(values);
  const idIndex = headerIndex(header, "id");
  const nameIndex = headerIndex(header, "name");
  const targetIndex = headerIndex(header, "ziel");
  const profileIndex = headerIndex(header, "profil");
  if (nameIndex < 0 || targetIndex < 0) throw new AppError("SHEET_SCHEMA", "Navigator-Spalten fehlen", 503);
  const items = [];
  for (const [offset, row] of values.slice(1).entries()) {
    const rowProfile = profileIndex < 0 ? "1" : String(row[profileIndex] || "1").trim();
    if (rowProfile !== profile) continue;
    const label = String(row[nameIndex] || "").trim();
    const target = String(row[targetIndex] || "").trim();
    if (!label) continue;
    let action;
    if (/^OL-Platz-[12]$/i.test(target)) {
      action = { kind: "court.assign", court: target.slice(-1) };
    } else if (/^OL-Platzaktivierung$/i.test(target)) {
      action = { kind: "court.activation" };
    } else {
      try {
        action = { kind: "navigate", path: dependencies.canonicalizeMonitorPath(target, dataStore) };
      } catch (error) {
        action = { kind: "disabled", error: error.code || "TARGET_INVALID" };
      }
    }
    items.push({ id: idIndex < 0 ? `row-${offset + 2}` : String(row[idIndex] || `row-${offset + 2}`), label, action });
  }
  return { success: true, items };
}

function scoreboardScores(scoreSnapshot = courtPoller.getLastData()) {
  return projectScoreboardScores(scoreSnapshot, {
    courts: stateStore.getScoreboardCourts(),
  });
}

function scoreboardSnapshot() {
  for (const table of ["players", "bewerbe", "matches1"]) {
    if (!dataStore.isTableCurrent(table)) throw new AppError("DATA_NOT_READY", "Scoreboard-Daten sind nicht aktuell", 503);
  }
  return {
    success: true,
    playersValues: dependencies.authService.publicPlayersTable(),
    bewerbValues: publicTable("bewerbe"),
    matchesValues: publicTable("matches1", filterIgnored(dataStore.get("matches1"))),
    courts: stateStore.getScoreboardCourts(),
    scores: scoreboardScores(),
    revisions: {
      players: dataStore.getMeta("players")?.revision || 0,
      bewerbe: dataStore.getMeta("bewerbe")?.revision || 0,
      matchtyp: dataStore.getMeta("matchtyp")?.revision || 0,
      matches1: dataStore.getMeta("matches1")?.revision || 0,
    },
  };
}

function resolveCourtAssignment(params) {
  const court = idValue(params.court, "court");
  if (!['1', '2'].includes(court)) throw new AppError("COURT_INVALID", "Court muss 1 oder 2 sein");
  if (params.empty === true) {
    return {
      court,
      data: {
        matchId: "",
        bewerbId: "",
        matchtypId: "",
        displayRules: null,
        bewerb: "",
        homePlayerIds: [],
        guestPlayerIds: [],
        homePlayer: "",
        guestPlayer: "",
        dateTime: "",
        runde: "",
      },
    };
  }
  const names = playerNameMap();
  if (params.matchId) {
    const matchId = idValue(params.matchId, "matchId");
    const matches = dataStore.get("matches1");
    const header = headerOf(matches);
    const indexes = {
      id: headerIndex(header, "id"),
      p1: headerIndex(header, "spieler1id"),
      p2: headerIndex(header, "spieler2id"),
      p3: headerIndex(header, "spieler3id"),
      p4: headerIndex(header, "spieler4id"),
      competition: headerIndex(header, "bewerbid"),
      date: headerIndex(header, "matchdate"),
      round: headerIndex(header, "bewerbrunde"),
      matchtyp: headerIndex(header, "matchtypid"),
    };
    if ([indexes.id, indexes.p1, indexes.p3, indexes.competition, indexes.date, indexes.round].includes(-1)) {
      throw new AppError("SHEET_SCHEMA", "Match-Spalten fuer Court-Zuweisung fehlen", 503);
    }
    const row = matches.slice(1).find((entry) => String(entry[indexes.id] || "").trim() === matchId);
    if (!row) throw new AppError("MATCH_NOT_FOUND", "Match wurde nicht gefunden", 404);
    const homeIds = [row[indexes.p1], row[indexes.p2]].map(parsePlayerId).filter(Boolean);
    const guestIds = [row[indexes.p3], row[indexes.p4]].map(parsePlayerId).filter(Boolean);
    const competitionId = String(row[indexes.competition] || "").trim();
    const competitions = dataStore.get("bewerbe");
    const competitionHeader = headerOf(competitions);
    const competitionIdIndex = headerIndex(competitionHeader, "id");
    const competitionNameIndex = headerIndex(competitionHeader, "bezeichnung");
    const competitionMatchtypIndex = headerIndex(competitionHeader, "matchtypid standard");
    if (competitionIdIndex < 0 || competitionNameIndex < 0) {
      throw new AppError("SHEET_SCHEMA", "Bewerb-Spalten fuer Court-Zuweisung fehlen", 503);
    }
    const competition = competitions.slice(1).find((entry) => String(entry[competitionIdIndex] || "").trim() === competitionId);
    const matchtypId = String(
      (indexes.matchtyp >= 0 ? row[indexes.matchtyp] : "")
      || (competition && competitionMatchtypIndex >= 0 ? competition[competitionMatchtypIndex] : "")
      || "",
    ).trim();
    const inspectedRules = inspectMatchtypDisplayRules(dataStore.get("matchtyp"), matchtypId);
    if (matchtypId && !inspectedRules.rules) {
      throw new AppError("SHEET_SCHEMA", "Zugeordneter Matchtyp fehlt oder besitzt ungueltige Anzeigeregeln", 503);
    }
    return {
      court,
      data: {
        matchId,
        bewerbId: competitionId,
        matchtypId,
        displayRules: inspectedRules.rules,
        bewerb: competition ? String(competition[competitionNameIndex] || "").trim() : "",
        homePlayerIds: homeIds,
        guestPlayerIds: guestIds,
        homePlayer: homeIds.map((id) => names.get(id) || id).join(" / "),
        guestPlayer: guestIds.map((id) => names.get(id) || id).join(" / "),
        dateTime: String(row[indexes.date] || "").trim(),
        runde: String(row[indexes.round] || "").trim(),
      },
    };
  }
  const homeIds = Array.isArray(params.homePlayerIds) ? params.homePlayerIds.map((id) => idValue(id, "homePlayerId")) : [];
  const guestIds = Array.isArray(params.guestPlayerIds) ? params.guestPlayerIds.map((id) => idValue(id, "guestPlayerId")) : [];
  if (homeIds.length < 1 || homeIds.length > 2 || guestIds.length < 1 || guestIds.length > 2) {
    throw new AppError("VALIDATION_ERROR", "Individual-Zuweisung benoetigt je ein bis zwei Spieler");
  }
  if (new Set([...homeIds, ...guestIds]).size !== homeIds.length + guestIds.length) {
    throw new AppError("VALIDATION_ERROR", "Jeder Spieler darf nur einmal zugewiesen werden");
  }
  for (const id of [...homeIds, ...guestIds]) {
    if (!names.has(id)) throw new AppError("PLAYER_NOT_FOUND", "Spieler wurde nicht gefunden", 404);
  }
  return {
    court,
    data: {
      matchId: "",
      bewerbId: "",
      matchtypId: "",
      displayRules: null,
      bewerb: "Individual",
      homePlayerIds: homeIds,
      guestPlayerIds: guestIds,
      homePlayer: homeIds.map((id) => names.get(id)).join(" / "),
      guestPlayer: guestIds.map((id) => names.get(id)).join(" / "),
      dateTime: new Intl.DateTimeFormat("de-AT", { timeZone: "Europe/Vienna", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date()),
      runde: "",
    },
  };
}

const endpoints = {
  players: {
    access: "public",
    handler: () => {
      requireCurrentTables("players");
      return { success: true, values: dependencies.authService.publicPlayersTable() };
    },
  },
  publicProfile: {
    access: "public",
    handler: (params, context) => {
      requireCurrentTables("players");
      const id = idValue(params?.id, "id");
      const profile = context.auth
        ? dependencies.authService.memberProfile(id, { includeAdminFields: context.principal.role === "admin" })
        : dependencies.authService.publicProfile(id);
      return { success: true, profile: {
        ...profile,
        rankings: profileRankings(id, context.principal),
        competitions: profileCompetitions(id, context.principal),
      } };
    },
  },
  bewerbe: {
    access: "public",
    handler: () => {
      requireCurrentTables("bewerbe", "bewerbsart");
      return { success: true, values: publicTable("bewerbe"), bewerbsartValues: publicTable("bewerbsart") };
    },
  },
  bewerbsart: {
    access: "public",
    handler: () => {
      requireCurrentTables("bewerbsart");
      return { success: true, values: publicTable("bewerbsart") };
    },
  },
  matches1: {
    access: "public",
    handler: (params) => {
      requireCurrentTables("matches1", "rlPlatzierung");
      let values = filterIgnored(dataStore.get("matches1"));
      if (params?.bewerbId) values = filterByField(values, "bewerbid", idValue(params.bewerbId, "bewerbId"));
      return { success: true, values: publicTable("matches1", values) };
    },
  },
  preMatches: { access: "public", handler: (params) => endpoints.matches1.handler(params) },
  matches: { access: "public", handler: (params) => endpoints.matches1.handler(params) },
  rlPlatzierung: {
    access: "public",
    handler: (params) => {
      requireCurrentTables("rlPlatzierung");
      const values = params?.bewerbId
        ? filterByField(dataStore.get("rlPlatzierung"), "bewerbid", idValue(params.bewerbId, "bewerbId"))
        : dataStore.get("rlPlatzierung");
      return { success: true, values: publicTable("rlPlatzierung", values) };
    },
  },
  entryList: {
    access: "public",
    handler: (params) => {
      requireCurrentTables("entryList", "players");
      const values = params?.bewerbId
        ? filterByField(dataStore.get("entryList"), "bewerbid", idValue(params.bewerbId, "bewerbId"))
        : dataStore.get("entryList");
      return { success: true, values: publicTable("entryList", values), playerMap: Object.fromEntries(playerNameMap()) };
    },
  },
  readMatchRestrictions: {
    access: "public",
    handler: (params) => {
      requireCurrentTables("matches1");
      return readMatchRestrictions(params);
    },
  },
  withdrawnRankingPlayers: {
    access: "authenticated",
    handler: (params) => ({ success: true, ...withdrawnRankingPlayers(idValue(params.bewerbId, "bewerbId")) }),
  },
  getScoreboardCourts: { access: "public", handler: () => ({ success: true, courts: stateStore.getScoreboardCourts() }) },
  courtScores: { access: "public", handler: () => ({ success: true, data: courtPoller.getLastData() }) },
  scoreboardSnapshot: { access: "public", handler: scoreboardSnapshot },

  memberDirectory: {
    access: "authenticated",
    handler: () => ({ success: true, values: dependencies.authService.memberDirectoryTable() }),
  },
  adminPeopleNormalization: {
    access: ["admin"],
    handler: () => {
      requireCurrentTables("players");
      return { success: true, ...projectPeopleNormalization(dataStore.get("players")) };
    },
  },
  adminMemberReconciliation: {
    access: ["admin"],
    handler: () => {
      requireCurrentTables("players");
      return { success: true, ...projectPeopleReconciliation(dataStore.get("players")) };
    },
  },
  sheetDataStatus: {
    access: ["admin"],
    handler: () => {
      const status = dataPoller.getStatus();
      return {
        success: true,
        lastSuccessfulRefreshAt: status.lastSuccessfulRefreshAt,
        dataAgeMs: status.dataAgeMs,
        inProgress: status.inProgress,
        bootstrapRecoveryActive: status.bootstrapRecoveryActive,
        lastControlledFailure: status.lastControlledFailure,
        tables: Object.fromEntries(Object.entries(status.tables).map(([table, value]) => [table, {
          lastAttempt: value.lastAttempt || null,
          lastUpdate: value.lastUpdate || null,
          revision: value.revision,
          rowCount: value.rowCount,
          loadCount: value.loadCount,
          consecutiveErrors: value.consecutiveErrors,
          lastErrorCode: value.lastError?.code || null,
        }])),
      };
    },
  },
  refreshSheetData: {
    access: ["admin"],
    write: true,
    writeCost: 0.1,
    handler: (params, context) => dependencies.sheetService.refreshSheetData(context.principal, params),
  },
  myProfile: {
    access: "authenticated",
    handler: (_params, context) => ({
      success: true,
      profile: {
        ...context.auth.user,
        rankings: profileRankings(context.principal.id, context.principal),
        competitions: profileCompetitions(context.principal.id, context.principal),
      },
    }),
  },
  myMessageSummary: {
    access: "authenticated",
    handler: (_params, context) => dependencies.messagingService.summary(context.principal),
  },
  myMessages: {
    access: "authenticated",
    handler: (params, context) => dependencies.messagingService.messages(context.principal, {
      cursor: params.cursor || null,
      limit: params.limit || 20,
    }),
  },
  myMessage: {
    access: "authenticated",
    handler: (params, context) => dependencies.messagingService.message(context.principal, params.messageId),
  },
  acknowledgeMessage: {
    access: "authenticated",
    write: true,
    handler: (params, context) => dependencies.messagingService.acknowledge(context.principal, params),
  },
  competitionHistory: {
    access: "authenticated",
    handler: (params, context) => dependencies.messagingService.competitionHistory(context.principal, {
      bewerbId: params.bewerbId,
      cursor: params.cursor || null,
      limit: params.limit || 50,
    }),
  },
  rankingChallengeState: {
    access: "authenticated",
    handler: (params, context) => dependencies.sheetService.rankingChallengeState(
      context.principal,
      idValue(params.bewerbId, "bewerbId"),
    ),
  },
  operationStatus: {
    access: "authenticated",
    handler: (params, context) => ({
      success: true,
      operation: dependencies.repository.getOperationStatus(
        `${context.principal.type}:${context.principal.id}`,
        params.operationId,
      ),
    }),
  },
  normalizePerson: {
    access: ["admin"],
    write: true,
    writeCost: 0.1,
    handler: (params, context) => dependencies.sheetService.normalizePerson(context.principal, params),
  },
  reconcilePerson: {
    access: ["admin"],
    write: true,
    writeCost: 0.1,
    handler: (params, context) => dependencies.sheetService.reconcilePerson(context.principal, params),
  },
  addMatch: {
    access: "authenticated",
    write: true,
    handler: (params, context) => dependencies.sheetService.addMatch(context.principal, {
      operationId: operationId(params?.operationId),
      bewerbId: idValue(params?.bewerbId, "bewerbId"),
      opponentId: idValue(params?.opponentId, "opponentId"),
    }),
  },
  setRankingMatchDate: {
    access: "authenticated",
    write: true,
    handler: (params, context) => dependencies.sheetService.setRankingMatchDate(context.principal, {
      operationId: operationId(params?.operationId),
      matchId: idValue(params?.matchId, "matchId"),
      matchDate: stringValue(params?.matchDate, "matchDate", { min: 11, max: 11, pattern: /^\d{6}-\d{4}$/ }),
    }),
  },
  matchResultSuggestion: {
    access: ["player", "player a", "player b", "admin"],
    handler: (params, context) => resultSuggestion(params, context.principal),
  },
  setMatchResult: {
    access: ["player", "player a", "player b", "admin"],
    write: true,
    handler: (params, context) => dependencies.sheetService.setMatchResult(context.principal, params),
  },
  adminSetMatchEnd: {
    access: ["admin"],
    write: true,
    handler: (params, context) => dependencies.sheetService.adminSetMatchEnd(context.principal, params),
  },
  adminClearMatchResult: {
    access: ["admin"],
    write: true,
    handler: (params, context) => dependencies.sheetService.adminClearMatchResult(context.principal, params),
  },
  adminCorrectRankingResult: {
    access: ["admin"],
    write: true,
    handler: (params, context) => dependencies.sheetService.adminCorrectRankingResult(context.principal, params),
  },
  adminDeleteRankingChallenge: {
    access: ["admin"],
    write: true,
    handler: (params, context) => dependencies.sheetService.adminDeleteRankingChallenge(context.principal, params),
  },
  adminSetRankingChallengeDate: {
    access: ["admin"],
    write: true,
    handler: (params, context) => dependencies.sheetService.adminSetRankingChallengeDate(context.principal, params),
  },
  adminSetRankingMatchDate: {
    access: ["admin"],
    write: true,
    handler: (params, context) => dependencies.sheetService.adminSetRankingMatchDate(context.principal, params),
  },
  addEntryList: {
    access: "authenticated",
    write: true,
    handler: (params, context) => dependencies.sheetService.addEntry(context.principal, {
      operationId: operationId(params?.operationId),
      bewerbId: idValue(params?.bewerbId, "bewerbId"),
    }),
  },
  removeEntryList: {
    access: "authenticated",
    write: true,
    handler: (params, context) => dependencies.sheetService.removeEntry(context.principal, {
      operationId: operationId(params?.operationId),
      bewerbId: idValue(params?.bewerbId, "bewerbId"),
    }),
  },
  withdrawFromRanking: {
    access: "authenticated",
    write: true,
    handler: (params, context) => dependencies.sheetService.withdrawFromRanking(context.principal, {
      operationId: operationId(params?.operationId),
      bewerbId: idValue(params?.bewerbId, "bewerbId"),
      rank: integerValue(params?.rank, "rank", { min: 1, max: 10000 }),
      reason: stringValue(params?.reason, "reason", { min: 3, max: 500 }),
    }),
  },

  navigator: {
    access: ["operator", "admin"],
    handler: (params) => {
      requireCurrentTables("navigator", "bewerbe");
      return compileNavigator(params);
    },
  },
  courtAssign: {
    access: ["operator", "admin"],
    write: true,
    handler: (rawParams, context) => {
      const params = requireObject(rawParams);
      const opId = operationId(params.operationId);
      const court = idValue(params.court, "court");
      if (!['1', '2'].includes(court)) throw new AppError("COURT_INVALID", "Court muss 1 oder 2 sein");
      const expectedRevision = integerValue(params.expectedRevision, "expectedRevision", { min: 1 });
      let request;
      if (params.empty === true) {
        request = { court, empty: true };
      } else if (params.matchId) {
        request = { court, matchId: idValue(params.matchId, "matchId") };
      } else {
        request = {
          court,
          homePlayerIds: (Array.isArray(params.homePlayerIds) ? params.homePlayerIds : []).map((id) => idValue(id, "homePlayerId")),
          guestPlayerIds: (Array.isArray(params.guestPlayerIds) ? params.guestPlayerIds : []).map((id) => idValue(id, "guestPlayerId")),
        };
      }
      const payload = { ...request, expectedRevision };
      return stateStore.applyCourtOperation(court, {
        principal: context.principal,
        operationId: opId,
        endpoint: "courtAssign",
        payload,
        expectedRevision,
      }, (current) => {
        if (!request.empty) requireCurrentTables("players", "bewerbe", "matchtyp", "matches1");
        const assignment = resolveCourtAssignment(request);
        return { ...assignment.data, aktiv: current.aktiv };
      }, () => courtPoller.resetCourtScore(court, { reason: "assignment" }));
    },
  },
  courtSetActive: {
    access: ["operator", "admin"],
    write: true,
    handler: (rawParams, context) => {
      const params = requireObject(rawParams);
      const court = idValue(params.court, "court");
      if (!['1', '2'].includes(court)) throw new AppError("COURT_INVALID", "Court muss 1 oder 2 sein");
      const active = booleanValue(params.active, "active");
      const opId = operationId(params.operationId);
      const expectedRevision = integerValue(params.expectedRevision, "expectedRevision", { min: 1 });
      const payload = { court, active, expectedRevision };
      const result = stateStore.applyCourtOperation(court, {
        principal: context.principal,
        operationId: opId,
        endpoint: "courtSetActive",
        payload,
        expectedRevision,
      }, () => ({ aktiv: active ? 1 : 0 }));
      const courts = stateStore.getScoreboardCourts();
      courtPoller.setCourtActive({ "1": courts["1"].aktiv === 1, "2": courts["2"].aktiv === 1 });
      return result;
    },
  },
  monitorList: { access: ["operator", "admin"], handler: () => ({ success: true, monitors: dependencies.monitorBroker.listMonitors() }) },
  monitorNavigate: {
    access: ["operator", "admin"],
    write: true,
    handler: (params, context) => {
      requireCurrentTables("bewerbe");
      return dependencies.monitorBroker.navigate(context.principal, params);
    },
  },
  monitorScroll: {
    access: ["operator", "admin"],
    write: true,
    handler: (params, context) => dependencies.monitorBroker.scroll(context.principal, params),
  },
  monitorProvision: {
    access: ["admin"],
    write: true,
    handler: (params, context) => dependencies.monitorBroker.provision(context.principal, params),
  },
  monitorRotate: {
    access: ["admin"],
    write: true,
    handler: (params, context) => dependencies.monitorBroker.rotate(context.principal, params),
  },
  monitorRevoke: {
    access: ["admin"],
    write: true,
    handler: (params, context) => dependencies.monitorBroker.revoke(context.principal, params),
  },
  monitorTarget: {
    access: "device",
    handler: (_params, context) => ({ success: true, target: stateStore.getNavigatorTarget(context.principal.id) }),
  },
  monitorAck: {
    access: "device",
    handler: (params, context) => dependencies.monitorBroker.acknowledge(context.principal, params),
  },
};

function refreshPrincipal(info) {
  if (info.principal?.type === "device") {
    const device = dependencies.repository.authenticateMonitor(info.monitorToken);
    if (!device) throw new AppError("DEVICE_REVOKED", "Monitor-Geraet ist nicht mehr gueltig", 401);
    info.principal = { type: "device", id: device.monitorId, role: "device", name: device.label };
    info.user = null;
    return { principal: info.principal, auth: null };
  }
  if (info.sessionToken) {
    const auth = dependencies.authService.getUserForToken(info.sessionToken);
    if (auth) {
      info.principal = auth.principal;
      info.user = auth.user;
      return { principal: auth.principal, auth };
    }
  }
  info.principal = { type: "anonymous", id: info.id, role: "anonymous", name: "" };
  info.user = null;
  return { principal: info.principal, auth: null };
}

function authorize(endpoint, context) {
  const access = endpoint.access;
  if (access === "public") return;
  if (access === "authenticated" && context.principal.type === "user") return;
  if (access === "device" && context.principal.type === "device") return;
  if (Array.isArray(access) && context.principal.type === "user" && access.includes(context.principal.role)) return;
  if (context.principal.type === "anonymous") throw new AppError("AUTH_REQUIRED", "Anmeldung erforderlich", 401);
  throw new AppError("FORBIDDEN", "Berechtigung fehlt", 403);
}

function canSubscribe(info, topic) {
  if (PUBLIC_TOPICS.has(topic)) return true;
  if (topic === "navigator") {
    return info.principal.type === "user" && ["operator", "admin"].includes(info.principal.role);
  }
  if (topic === "monitors") {
    return info.principal.type === "user" && ["operator", "admin"].includes(info.principal.role);
  }
  if (topic === "monitor-command") return info.principal.type === "device";
  if (topic.startsWith("messages:")) {
    return info.principal.type === "user" && topic === `messages:${info.principal.id}`;
  }
  if (topic.startsWith("monitor-status:")) {
    return info.principal.type === "user" && ["operator", "admin"].includes(info.principal.role);
  }
  return false;
}

function send(info, message) {
  const ws = info.ws;
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
    ws.close(1013, "Client zu langsam");
    return false;
  }
  try {
    ws.send(JSON.stringify({ ...message, v: PROTOCOL_VERSION }), (error) => {
      if (error && ws.readyState !== WebSocket.CLOSED) ws.terminate();
    });
    return true;
  } catch {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    return false;
  }
}

function completeRequest(info, {
  supportId,
  clientRequestId,
  endpoint,
  startedAt,
  error = null,
}) {
  const code = error?.code || (error ? "INTERNAL_ERROR" : null);
  const rawClientRequestId = String(clientRequestId || "").slice(0, 128);
  const safeClientRequestId = /^[A-Za-z0-9_.:-]{1,128}$/.test(rawClientRequestId) ? rawClientRequestId : "invalid";
  const result = !error ? "success" : (error.status || 500) < 500 ? "rejected" : "failed";
  const record = Object.freeze({
    endpoint: String(endpoint || "").slice(0, 64),
    at: startedAt,
    durationMs: Math.max(0, Date.now() - startedAt),
    success: !error,
    ...(code ? { code } : {}),
    supportId,
    clientRequestId: safeClientRequestId,
  });
  info.requestHistory.push(record);
  if (info.requestHistory.length > REQUEST_HISTORY_LIMIT) info.requestHistory.shift();
  info.lastRequest = record;
  logger.log(error && (!(error instanceof AppError) || (error.status || 500) >= 500) ? "warn" : "info", "ws_request_completed", {
    supportId,
    connectionId: info.id,
    requestId: record.clientRequestId,
    endpoint: record.endpoint,
    durationMs: record.durationMs,
    result,
    errorCode: code,
  });
  metrics.recordWsRequest({ endpoint: record.endpoint, knownEndpoint: Object.hasOwn(endpoints, record.endpoint), result, durationMs: record.durationMs });
  return record;
}

function publish(topic, data) {
  for (const info of clients.values()) {
    if (!info.handshake || !info.subscriptions.has(topic)) continue;
    try {
      if (!PUBLIC_TOPICS.has(topic)) refreshPrincipal(info);
      if (!canSubscribe(info, topic)) {
        info.subscriptions.delete(topic);
        continue;
      }
      send(info, { type: "event", topic, data });
    } catch (error) {
      if (error.code === "DEVICE_REVOKED") {
        info.subscriptions.delete(topic);
        info.ws.close(4003, "Geraetetoken widerrufen");
      }
    }
  }
}

function sendSubscriptionSnapshot(info, topic) {
  if (topic === "scores") send(info, { type: "event", topic, data: scoreboardScores() });
  if (topic === "scoreboard-state") send(info, { type: "event", topic, data: { courts: stateStore.getScoreboardCourts() } });
  if (topic === "monitors") send(info, { type: "event", topic, data: { monitors: dependencies.monitorBroker.listMonitors() } });
  if (topic.startsWith("messages:") && canSubscribe(info, topic)) {
    const { revision, unreadCount } = dependencies.messagingService.summary(info.principal);
    send(info, { type: "event", topic, data: { revision, unreadCount } });
  }
  const tableTopics = { matches: "matches1", players: "players", bewerbe: "bewerbe", bewerbsart: "bewerbsart", matchtyp: "matchtyp", entryList: "entryList", ranking: "rlPlatzierung", navigator: "navigator" };
  if (tableTopics[topic]) send(info, { type: "event", topic, data: { table: tableTopics[topic], ...dataStore.getMeta(tableTopics[topic]) } });
  if (topic.startsWith("monitor-status:")) {
    const monitorId = topic.slice("monitor-status:".length);
    const monitor = dependencies.monitorBroker.listMonitors().find((entry) => entry.monitorId === monitorId);
    if (monitor) send(info, { type: "event", topic, data: monitor });
  }
}

async function handleRequest(info, message, supportId) {
  if (shuttingDown) throw new AppError("SHUTTING_DOWN", "Server wird beendet", 503);
  const endpoint = endpoints[message.endpoint];
  if (!endpoint || !Object.hasOwn(endpoints, message.endpoint)) throw new AppError("ENDPOINT_NOT_FOUND", "Unbekannter Endpoint", 404);
  if (info.inflight >= WS_MAX_INFLIGHT) throw new AppError("TOO_MANY_REQUESTS", "Zu viele parallele Requests", 429);
  const authContext = refreshPrincipal(info);
  authorize(endpoint, authContext);
  const params = validateEndpointRequest(message.endpoint, message.params);
  if (endpoint.write) {
    const principalKey = `principal:${authContext.principal.type}:${authContext.principal.id}`;
    const ipKey = `ip:${info.ip}`;
    const writeCost = endpoint.writeCost || 1;
    if (!writeLimiter.take(principalKey, writeCost) || !writeLimiter.take(ipKey, writeCost)) {
      throw new AppError("WRITE_RATE_LIMIT", "Zu viele Schreiboperationen", 429);
    }
  }
  if (endpoint.write) {
    writeAudit({ eventId: supportId, principal: authContext.principal, endpoint: message.endpoint, params, outcome: "started" });
  }
  info.inflight++;
  let actionCompleted = false;
  try {
    const rawData = await endpoint.handler(params, { ...authContext, info });
    actionCompleted = true;
    const internal = rawData?._audit || null;
    const publicData = rawData && typeof rawData === "object" ? { ...rawData } : rawData;
    if (publicData && typeof publicData === "object") delete publicData._audit;
    const data = validateEndpointResponse(message.endpoint, publicData);
    if (endpoint.write) {
      writeAudit({ eventId: supportId, principal: authContext.principal, endpoint: message.endpoint, params, result: data, internal, outcome: "success" });
    }
    return data;
  } catch (error) {
    let responseError = error;
    if (endpoint.write) {
      try {
        writeAudit({
          eventId: supportId,
          principal: authContext.principal,
          endpoint: message.endpoint,
          params,
          internal: error.details?.tombstone ? { before: error.details.tombstone, after: null } : null,
          outcome: actionCompleted || error.code === "WRITE_OUTCOME_UNKNOWN" ? "unknown" : "failed",
          error,
        });
      } catch (auditError) {
        logger.log("error", "audit_record_failed", { supportId, action: message.endpoint, error: auditError });
      }
      if (actionCompleted && error.code !== "WRITE_OUTCOME_UNKNOWN") {
        responseError = new AppError("WRITE_OUTCOME_UNKNOWN", "Aenderung ausgefuehrt, Auditabschluss ist unklar", 503);
      }
    }
    throw responseError;
  } finally {
    info.inflight--;
  }
}

async function handleMessage(info, raw) {
  info.lastMessageAt = Date.now();
  if (!info.rateLimiter.take("messages")) {
    info.ws.close(1008, "Nachrichtenrate ueberschritten");
    return;
  }
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    send(info, { type: "error", error: { code: "INVALID_JSON", message: "Ungueltiges JSON" } });
    return;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    send(info, { type: "error", error: { code: "INVALID_MESSAGE", message: "Nachricht muss ein Objekt sein" } });
    return;
  }
  if (!info.handshake) {
    if (message.type !== "hello" || message.protocol !== PROTOCOL_VERSION || message.v !== PROTOCOL_VERSION) {
      info.ws.close(4406, "Protokollversion inkompatibel");
      return;
    }
    const clientId = stringValue(message.clientId, "clientId", { max: 64 });
    const deviceId = stringValue(message.deviceId, "deviceId", { max: 64 });
    const pageType = stringValue(message.pageType, "pageType", { max: 64 });
    if (typeof message.appVersion !== "string" || message.appVersion.length === 0 || message.appVersion.length > 64) {
      info.ws.close(4406, "App-Version ungueltig");
      return;
    }
    const appVersion = message.appVersion;
    if (appVersion !== dependencies.appVersion) {
      info.ws.close(4406, `App-Version inkompatibel (${appVersion} != ${dependencies.appVersion})`);
      return;
    }
    if (pageType === "monitor" && info.monitorToken) {
      const device = dependencies.repository.authenticateMonitor(info.monitorToken);
      if (device) info.principal = { type: "device", id: device.monitorId, role: "device", name: device.label };
    }
    const context = refreshPrincipal(info);
    clearTimeout(info.handshakeTimer);
    info.handshake = true;
    info.clientId = clientId;
    info.deviceId = deviceId;
    info.pageType = pageType;
    info.appVersion = appVersion;
    send(info, {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      connectionId: info.id,
      serverVersion: dependencies.appVersion,
      timing: {
        pingIntervalMs: WS_PING_INTERVAL_MS,
        staleAfterMs: Math.max(70000, WS_PING_INTERVAL_MS * 2 + 5000),
      },
      principal: {
        type: context.principal.type,
        role: context.principal.role,
        ...(context.auth ? { user: context.auth.user } : {}),
        ...(context.principal.type === "device" ? { monitor: { id: context.principal.id, label: context.principal.name } } : {}),
      },
    });
    if (context.principal.type === "device") dependencies.monitorBroker.register(info);
    return;
  }
  if (message.v !== PROTOCOL_VERSION) {
    send(info, { type: "error", error: { code: "PROTOCOL_MISMATCH", message: "Protokollversion inkompatibel" } });
    return;
  }
  if (message.type === "pong") {
    info.lastPong = Date.now();
    return;
  }
  if (message.type === "subscribe") {
    const topics = Array.isArray(message.topics) ? message.topics : [];
    const accepted = [];
    refreshPrincipal(info);
    for (const rawTopic of topics.slice(0, 20)) {
      const topic = stringValue(rawTopic, "topic", { max: 100 });
      if (!canSubscribe(info, topic)) continue;
      if (!info.subscriptions.has(topic) && info.subscriptions.size >= WS_MAX_SUBSCRIPTIONS) break;
      info.subscriptions.add(topic);
      accepted.push(topic);
      sendSubscriptionSnapshot(info, topic);
    }
    send(info, { type: "subscribed", topics: accepted });
    return;
  }
  if (message.type === "unsubscribe") {
    for (const topic of Array.isArray(message.topics) ? message.topics : []) info.subscriptions.delete(String(topic));
    return;
  }
  if (message.type !== "request" || typeof message.id !== "string" || typeof message.endpoint !== "string") {
    if (message.type === "request" && typeof message.id === "string") {
      const startedAt = Date.now();
      const id = String(message.id).slice(0, 128);
      const endpoint = typeof message.endpoint === "string" ? String(message.endpoint).slice(0, 64) : "";
      const supportId = crypto.randomUUID();
      const error = new AppError("INVALID_MESSAGE", "Request ist ungueltig");
      send(info, {
        type: "response",
        id,
        endpoint,
        data: errorData(error),
        supportId,
      });
      completeRequest(info, { supportId, clientRequestId: id, endpoint, startedAt, error });
    } else {
      send(info, { type: "error", error: { code: "INVALID_MESSAGE", message: "Request ist ungueltig" } });
    }
    return;
  }
  const startedAt = Date.now();
  const clientRequestId = String(message.id).slice(0, 128);
  const supportId = crypto.randomUUID();
  try {
    message.id = stringValue(message.id, "requestId", { max: 128, pattern: /^[A-Za-z0-9_.:-]+$/ });
    message.endpoint = stringValue(message.endpoint, "endpoint", { max: 64, pattern: /^[A-Za-z][A-Za-z0-9]*$/ });
    message.params = message.params === undefined ? {} : requireObject(message.params);
  } catch (error) {
    send(info, { type: "response", id: String(message.id).slice(0, 128), endpoint: String(message.endpoint).slice(0, 64), data: errorData(error), supportId });
    completeRequest(info, {
      supportId,
      clientRequestId,
      endpoint: String(message.endpoint).slice(0, 64),
      startedAt,
      error,
    });
    return;
  }
  try {
    const data = await handleRequest(info, message, supportId);
    send(info, { type: "response", id: message.id, endpoint: message.endpoint, data, supportId });
    completeRequest(info, { supportId, clientRequestId: message.id, endpoint: message.endpoint, startedAt });
  } catch (error) {
    if (!(error instanceof AppError) || (error.status || 500) >= 500) {
      logger.log(error instanceof AppError ? "warn" : "error", "ws_request_failed", {
        supportId,
        connectionId: info.id,
        requestId: message.id,
        endpoint: message.endpoint,
        durationMs: Date.now() - startedAt,
        error,
      });
    }
    send(info, { type: "response", id: message.id, endpoint: message.endpoint, data: errorData(error), supportId });
    completeRequest(info, { supportId, clientRequestId: message.id, endpoint: message.endpoint, startedAt, error });
  }
}

function rejectUpgrade(socket, status, message) {
  if (!socket.writable) return socket.destroy();
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
}

function init(server, options) {
  dependencies = { ...options, canonicalizeMonitorPath: options.canonicalizeMonitorPath };
  shuttingDown = false;
  wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES, perMessageDeflate: false });

  dependencies.monitorBroker.setTransport({
    send,
    publish,
    close: (info, code, reason) => info.ws.close(code, reason),
  });

  upgradeHandler = (request, socket, head) => {
    try {
      if (shuttingDown) throw new AppError("SHUTTING_DOWN", "Server wird beendet", 503);
      const pathname = new URL(request.url, "http://backend.invalid").pathname;
      if (pathname !== "/ws") throw new AppError("NOT_FOUND", "WebSocket-Pfad nicht gefunden", 404);
      assertAllowedOrigin(request, ALLOWED_ORIGINS);
      const ip = getRequestIp(request);
      if (!upgradeLimiter.take(ip)) throw new AppError("RATE_LIMIT", "Zu viele Verbindungsversuche", 429);
      if (clients.size >= WS_MAX_CONNECTIONS) throw new AppError("CAPACITY", "Zu viele Verbindungen", 503);
      if ((connectionsByIp.get(ip) || 0) >= WS_MAX_CONNECTIONS_PER_IP) throw new AppError("IP_CAPACITY", "Zu viele Verbindungen dieser Adresse", 429);
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    } catch (error) {
      rejectUpgrade(socket, error.status || 403, error.message || "Forbidden");
    }
  };
  server.on("upgrade", upgradeHandler);

  wss.on("connection", (ws, request) => {
    const cookies = parseCookies(request.headers.cookie);
    const ip = getRequestIp(request);
    const info = {
      ws,
      id: crypto.randomUUID(),
      connectedAt: Date.now(),
      lastMessageAt: Date.now(),
      lastPong: Date.now(),
      lastRequest: null,
      requestHistory: [],
      ip,
      origin: request.headers.origin,
      handshake: false,
      subscriptions: new Set(),
      inflight: 0,
      rateLimiter: new TokenBucketLimiter({ rate: WS_REQUEST_RATE, burst: WS_REQUEST_BURST }),
      principal: { type: "anonymous", id: "", role: "anonymous", name: "" },
      user: null,
      sessionToken: cookies[SESSION_COOKIE] || "",
      monitorToken: cookies[MONITOR_COOKIE] || "",
    };
    info.principal.id = info.id;
    info.handshakeTimer = setTimeout(() => ws.close(4408, "Handshake Timeout"), WS_HANDSHAKE_TIMEOUT_MS);
    clients.set(ws, info);
    connectionsByIp.set(ip, (connectionsByIp.get(ip) || 0) + 1);
    ws.on("message", (raw) => {
      const operation = handleMessage(info, raw).catch((error) => {
        if (!(error instanceof AppError)) logger.log("error", "ws_message_handler_failed", { connectionId: info.id, handshakeComplete: info.handshake, pageType: info.pageType || null, error });
        send(info, { type: "error", error: errorData(error).error });
        if (!info.handshake) ws.close(error.status === 503 ? 1013 : 4406, "Handshake fehlgeschlagen");
      });
      activeHandlers.add(operation);
      operation.finally(() => activeHandlers.delete(operation));
    });
    ws.on("close", (code, reason) => {
      clearTimeout(info.handshakeTimer);
      dependencies.monitorBroker.unregister(info);
      clients.delete(ws);
      const count = Math.max(0, (connectionsByIp.get(ip) || 1) - 1);
      if (count) connectionsByIp.set(ip, count); else connectionsByIp.delete(ip);
      logger.log(code === 1000 ? "debug" : "info", "ws_connection_closed", {
        connectionId: info.id,
        pageType: info.pageType || null,
        closeCode: code,
        durationMs: Date.now() - info.connectedAt,
        handshakeComplete: info.handshake,
      });
    });
    ws.on("error", (error) => logger.log("error", "ws_socket_error", { connectionId: info.id, pageType: info.pageType || null, error }));
  });

  pingTimer = setInterval(() => {
    const now = Date.now();
    for (const info of clients.values()) {
      if (now - info.lastPong > WS_DEAD_CLIENT_MS) {
        info.ws.terminate();
      } else {
        send(info, { type: "ping", ts: now });
      }
    }
  }, WS_PING_INTERVAL_MS);
  pingTimer.unref?.();

  courtPoller.setOnUpdate((scoreSnapshot) => publish("scores", scoreboardScores(scoreSnapshot)));
  unsubscribeCallbacks.push(stateStore.onChange((event) => {
    if (event.type === "court") publish("scoreboard-state", { courts: stateStore.getScoreboardCourts() });
  }));
  unsubscribeCallbacks.push(dataStore.onChange((event) => {
    if (event.table === "matchtyp" && event.current) {
      const migration = stateStore.migrateLegacyCourtDisplayRules(dataStore.get("matchtyp"));
      if (migration.migratedCourts.length) {
        publish("scoreboard-state", { courts: stateStore.getScoreboardCourts() });
        publish("scores", scoreboardScores());
      }
    }
    const topicByTable = { matches1: "matches", players: "players", bewerbe: "bewerbe", bewerbsart: "bewerbsart", matchtyp: "matchtyp", entryList: "entryList", rlPlatzierung: "ranking", navigator: "navigator" };
    const topic = topicByTable[event.table];
    if (topic) publish(topic, event);
  }));
}

function getStatus() {
  return {
    clientCount: clients.size,
    clientCapacity: {
      current: clients.size,
      max: WS_MAX_CONNECTIONS,
      text: `${clients.size}/${WS_MAX_CONNECTIONS}`,
    },
    connectionsByIp: [...connectionsByIp.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([ip, current]) => ({
        ip,
        current,
        max: WS_MAX_CONNECTIONS_PER_IP,
        text: `${current}/${WS_MAX_CONNECTIONS_PER_IP}`,
      })),
    clients: [...clients.values()].map((info) => ({
      id: info.id,
      ip: info.ip,
      connectedAt: info.connectedAt,
      lastMessageAt: info.lastMessageAt,
      lastPong: info.lastPong,
      lastRequest: info.lastRequest,
      requestHistory: [...info.requestHistory],
      pageType: info.pageType || null,
      appVersion: info.appVersion || null,
      clientId: info.clientId || null,
      deviceId: info.deviceId || null,
      principalType: info.principal.type,
      role: info.principal.role,
      userId: info.principal.type === "user" ? info.principal.id : null,
      userName: info.user ? [info.user.lastName, info.user.firstName].filter(Boolean).join(" / ") : null,
      subscriptions: [...info.subscriptions],
      bufferedAmount: info.ws.bufferedAmount,
    })),
  };
}

function getMetricsStatus() {
  const connections = { pending: 0, anonymous: 0, user: 0, device: 0 };
  let activeRequests = 0;
  for (const info of clients.values()) {
    activeRequests += Math.max(0, Number(info.inflight) || 0);
    const state = !info.handshake ? "pending" : info.principal.type === "user" ? "user" : info.principal.type === "device" ? "device" : "anonymous";
    connections[state]++;
  }
  return { connections, activeRequests };
}

async function shutdown(server) {
  shuttingDown = true;
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  if (upgradeHandler) server.off("upgrade", upgradeHandler);
  upgradeHandler = null;
  dependencies.monitorBroker.shutdown();
  for (const info of clients.values()) info.ws.close(1012, "Service restart");
  await new Promise((resolve) => {
    if (!wss) return resolve();
    const timeout = setTimeout(resolve, 2000);
    wss.close(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
  for (const info of clients.values()) info.ws.terminate();
  clients.clear();
  await Promise.allSettled([...activeHandlers]);
  for (const unsubscribe of unsubscribeCallbacks.splice(0)) unsubscribe();
  wss = null;
}

module.exports = { getMetricsStatus, getStatus, init, matchCompletionFingerprint, publish, shutdown };
