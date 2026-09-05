const crypto = require("crypto");
const { google } = require("googleapis");
const { GOOGLE_REQUEST_TIMEOUT_MS, SHEET_ID, TABLE_CONFIG } = require("./config.js");
const dataStore = require("./dataStore.js");
const dataPoller = require("./dataPoller.js");
const { AppError } = require("./errors.js");
const { analyzeMatchRules, matchCompletionFingerprint, parseMatchDate, parseParticipant } = require("./matchRules.js");
const {
  MatchResultRuleError,
  encodeCompletion,
  koRoundSuccessor,
  parseMatchTypeTable,
  parseParticipantId,
  resolveMatchType,
  validateCompletion,
} = require("./matchResultRules.js");
const {
  FIELD_DEFINITIONS,
  fieldIndexes,
  personFingerprint,
  projectPeopleNormalization,
  rawPersonValues,
  validateChanges,
} = require("./peopleNormalization.js");
const {
  assertUniqueExternalId,
  assertUpdateCandidate,
  projectPeopleReconciliation,
  reconciliationFingerprint,
  validateReconciliationRequest,
} = require("./memberReconciliation.js");
const { columnName, headerIndex, headerOf } = require("./tableUtils.js");
const { assertPlayerLoginConflictsNotWorsened, validateTableValues } = require("./tableSchemas.js");
const logger = require("./logger.js");
const metrics = require("./metrics.js");
const { acquireSheetTableActivity, executeSheetRead, getSheetReadStatus, rateLimitError } = require("./sheetsReadCoordinator.js");

const RECORD_METADATA_KEY = "epiberRecord";
const WRITE_REFRESH_DELAY_MS = 1000;

function withAudit(result, audit) {
  Object.defineProperty(result, "_audit", { value: audit, enumerable: false });
  return result;
}

function reconciliationAuditValues(fields, values, marker) {
  return Object.fromEntries(fields.map((field) => [
    field,
    ["active", "role"].includes(field) ? String(values[field] ?? "") : marker,
  ]));
}

function viennaTimestamp(includeSeconds = false, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: includeSeconds ? "2-digit" : undefined,
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}-${values.hour}${values.minute}${includeSeconds ? `-${values.second}` : ""}`;
}

function viennaYear(date) {
  return Number(new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Vienna",
    year: "numeric",
  }).format(date));
}

function birthYear(value) {
  const text = String(value || "").trim();
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  const dotted = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  const year = Number(compact?.[1] || dotted?.[3]);
  const month = Number(compact?.[2] || dotted?.[2]);
  const day = Number(compact?.[3] || dotted?.[1]);
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? year
    : null;
}

function stableRecordId(prefix, principal, operationId) {
  const digest = crypto.createHash("sha256").update(`${principal.type}:${principal.id}:${operationId}`).digest("hex").slice(0, 32);
  return `${prefix}-${digest}`;
}

function resultMembershipId(matchId, competitionId, personId) {
  return `result-${crypto.createHash("sha256").update(`ranking:${matchId}:${competitionId}:${personId}`).digest("hex").slice(0, 32)}`;
}

function rowForHeader(header, valuesByName) {
  const row = Array(header.length).fill("");
  for (const [name, value] of Object.entries(valuesByName)) {
    const index = headerIndex(header, name);
    if (index < 0) throw new AppError("SHEET_SCHEMA", `Spalte ${name} fehlt`, 503);
    row[index] = value;
  }
  return row;
}

function requireCurrentData(...tableNames) {
  for (const tableName of tableNames) {
    if (!dataStore.isTableCurrent(tableName)) {
      throw new AppError("DATA_NOT_READY", `Tabelle ${tableName} ist nicht aktuell`, 503);
    }
  }
}

function parseCompetitionDate(raw, endOfDay) {
  const value = String(raw || "").trim();
  if (!value) return null;
  const match = value.match(/^(\d{2}|\d{4})(\d{2})(\d{2})(?:-(\d{2})(\d{2}))?$/);
  if (!match) throw new AppError("COMPETITION_DATE_INVALID", "Bewerbszeitraum ist ungueltig", 503);
  const [, yearValue, month, day, hour, minute] = match;
  const year = yearValue.length === 2
    ? (Number(yearValue) >= 50 ? 1900 + Number(yearValue) : 2000 + Number(yearValue))
    : Number(yearValue);
  const date = new Date(
    year,
    Number(month) - 1,
    Number(day),
    hour === undefined ? (endOfDay ? 23 : 0) : Number(hour),
    minute === undefined ? (endOfDay ? 59 : 0) : Number(minute),
    endOfDay && hour === undefined ? 59 : 0,
  );
  if (date.getFullYear() !== year || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) {
    throw new AppError("COMPETITION_DATE_INVALID", "Bewerbszeitraum ist ungueltig", 503);
  }
  return date;
}

function validCompactDateTime(value) {
  const match = String(value || "").match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!match || Number(match[4]) > 23 || Number(match[5]) > 59) return false;
  const year = Number(match[1]) >= 50 ? 1900 + Number(match[1]) : 2000 + Number(match[1]);
  const date = new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function rowObject(header, row) {
  return Object.fromEntries(header.map((name, index) => [name, row[index] ?? ""]));
}

function completionState(row, header) {
  const resultIndex = headerIndex(header, "ergebnis");
  const endIndex = headerIndex(header, "matchende");
  const participants = ["spieler1id", "spieler2id", "spieler3id", "spieler4id"].map((name) => {
    const index = headerIndex(header, name);
    return index < 0 ? { id: "", marker: null } : parseParticipantId(row[index]);
  });
  const marker = participants.find((participant) => participant.marker)?.marker || null;
  return {
    closed: Boolean(String(row[resultIndex] || "").trim() || marker),
    result: String(row[resultIndex] || "").trim(),
    matchEnd: String(row[endIndex] || "").trim(),
    participants,
    kind: marker === "wo" ? "walkover" : marker === "ret" ? "retirement" : "regular",
  };
}

function appResultRuleError(error) {
  if (!(error instanceof MatchResultRuleError)) return error;
  return new AppError(error.code || "MATCH_RESULT_INVALID", error.message || "Matchergebnis ist ungueltig", 409);
}

function assertMatchEnd(matchDateValue, matchEndValue, now) {
  const matchDate = parseMatchDate(matchDateValue);
  const matchEnd = parseMatchDate(matchEndValue);
  if (!matchDate || !matchEnd) throw new AppError("MATCH_END_INVALID", "Matchzeitpunkte sind ungueltig", 409);
  if (matchEnd <= matchDate) throw new AppError("MATCH_END_BEFORE_START", "Matchende muss nach dem Matchbeginn liegen", 409);
  if (matchEnd.getTime() > matchDate.getTime() + 6 * 60 * 60 * 1000) {
    throw new AppError("MATCH_END_AFTER_LIMIT", "Matchende darf hoechstens sechs Stunden nach Matchbeginn liegen", 409);
  }
  if (matchEnd.getTime() > now) throw new AppError("MATCH_END_FUTURE", "Matchende darf nicht in der Zukunft liegen", 409);
  return matchEnd;
}

function resultRecoveryError(message, params, recoveryDetails) {
  const error = new AppError("WRITE_OUTCOME_UNKNOWN", message, 503, {
    operationId: params.operationId,
    matchId: params.matchId,
    phase: "match-result",
  });
  Object.defineProperty(error, "_recoveryDetails", { value: recoveryDetails, enumerable: false });
  return error;
}

function changedCells(header, beforeRow, afterRow, names) {
  return names.flatMap((name) => {
    const index = headerIndex(header, name);
    if (index < 0) return [];
    const before = beforeRow[index] ?? "";
    const after = afterRow[index] ?? "";
    return String(before) === String(after) ? [] : [{ index, name, before, after }];
  });
}

function resultUpdateMatches(update, row, side) {
  if (!row) return false;
  return (update.identity || []).every(({ index, value }) => String(row[index] ?? "") === String(value))
    && update.changes.every((change) => String(row[change.index] ?? "") === String(change[side] ?? ""));
}

function sparseResultRow(update) {
  const maxIndex = Math.max(-1, ...update.changes.map(({ index }) => index));
  const values = Array(maxIndex + 1).fill(null);
  for (const { index, after } of update.changes) values[index] = after;
  return values;
}

function assertRemovableInsertedRankingRow(update, row, header) {
  const controlled = new Set(["id", "bewerbid", "personid", "rang"].map((name) => headerIndex(header, name)));
  if (row.some((value, index) => !controlled.has(index) && String(value ?? "").trim())) {
    throw new AppError("RANKING_REPAIR_REQUIRED", "Eingefuegte Ranglistenzeile enthaelt nicht kontrollierte Daten", 409);
  }
}

function completionWinnerSide(state) {
  const markedSide = state.participants[0].marker || state.participants[1].marker ? 1
    : state.participants[2].marker || state.participants[3].marker ? 2 : 0;
  if (markedSide) return 3 - markedSide;
  let side1 = 0;
  let side2 = 0;
  for (const token of state.result.split("/").filter(Boolean)) {
    const scores = token.replace(/\(\d+\)$/, "").split("-").map(Number);
    if (scores[0] > scores[1]) side1++;
    if (scores[1] > scores[0]) side2++;
  }
  return side1 > side2 ? 1 : side2 > side1 ? 2 : 0;
}

class SheetService {
  constructor({ repository, messagingService = null, clientFactory = null, now = Date.now, refreshDelayMs = process.env.NODE_ENV === "test" ? 60000 : WRITE_REFRESH_DELAY_MS } = {}) {
    this.repository = repository;
    this.clientFactory = clientFactory;
    this.client = null;
    this.queues = new Map();
    this.active = new Set();
    this.stopping = false;
    this.now = now;
    this.refreshDelayMs = refreshDelayMs;
    this.sheetIds = new Map();
    this.sheetIdsLoad = null;
    this.recordMetadata = new Map();
    this.recordMetadataScanned = false;
    this.recordMetadataLoad = null;
    this.recordMetadataUnresolved = new Set();
    this.refreshTimers = new Map();
    this.messagingService = messagingService;
  }

  async ensureChallengeMessage(principal, params, matchId, matchRow, matchHeader) {
    if (!this.messagingService) throw new AppError("MESSAGING_UNAVAILABLE", "Nachrichtendienst ist nicht verfuegbar", 503);
    const matchIndexes = {
      competition: headerIndex(matchHeader, "bewerbid"),
      challengedAt: headerIndex(matchHeader, "forderungdate"),
      challenger: headerIndex(matchHeader, "spieler1id"),
      opponent: headerIndex(matchHeader, "spieler3id"),
    };
    if (
      String(matchRow[matchIndexes.competition] || "").trim() !== params.bewerbId
      || parseParticipant(matchRow[matchIndexes.challenger]).id !== principal.id
      || parseParticipant(matchRow[matchIndexes.opponent]).id !== params.opponentId
    ) {
      throw new AppError("OPERATION_ID_CONFLICT", "operationId wurde bereits fuer eine andere Forderung verwendet", 409);
    }
    const challengedAt = parseMatchDate(matchRow[matchIndexes.challengedAt]);
    const competition = this.competition(params.bewerbId);
    const competitionName = String(competition.row[headerIndex(competition.header, "bezeichnung")] || "").trim();
    const players = dataStore.get("players");
    const playerHeader = headerOf(players);
    const idIndex = headerIndex(playerHeader, "id");
    const firstNameIndex = headerIndex(playerHeader, "vorname");
    const lastNameIndex = headerIndex(playerHeader, "nachname");
    const challenger = players.slice(1).find((row) => String(row[idIndex] || "").trim() === principal.id);
    const opponent = players.slice(1).find((row) => String(row[idIndex] || "").trim() === params.opponentId);
    const challengerName = challenger
      ? [challenger[firstNameIndex], challenger[lastNameIndex]].map((value) => String(value || "").trim()).filter(Boolean).join(" ")
      : principal.id;
    const opponentName = opponent
      ? [opponent[firstNameIndex], opponent[lastNameIndex]].map((value) => String(value || "").trim()).filter(Boolean).join(" ")
      : params.opponentId;
    const rankings = dataStore.get("rlPlatzierung");
    const rankingHeader = headerOf(rankings);
    const rankingCompetitionIndex = headerIndex(rankingHeader, "bewerbid");
    const rankingPersonIndex = headerIndex(rankingHeader, "personid");
    const rankingRankIndex = headerIndex(rankingHeader, "rang");
    const rankOf = (personId) => {
      const ranking = rankings.slice(1).find((row) => (
        String(row[rankingCompetitionIndex] || "").trim() === params.bewerbId
        && String(row[rankingPersonIndex] || "").trim() === personId
      ));
      const rank = ranking ? Number(ranking[rankingRankIndex]) : NaN;
      return Number.isInteger(rank) && rank >= 0 ? rank : null;
    };
    try {
      await this.messagingService.ensureChallengeMessages({
        matchId,
        recipientId: params.opponentId,
        competitionId: params.bewerbId,
        competitionName,
        challengerId: principal.id,
        challengerName,
        challengerRank: rankOf(principal.id),
        opponentId: params.opponentId,
        opponentName,
        opponentRank: rankOf(params.opponentId),
        createdAt: challengedAt?.getTime() || this.now(),
      });
    } catch (error) {
      logger.log("error", "challenge_messages_persistence_failed", {
        matchId,
        challengerId: principal.id,
        opponentId: params.opponentId,
        errorCode: error.code || "MESSAGING_WRITE_FAILED",
      });
      throw new AppError("WRITE_OUTCOME_UNKNOWN", "Forderung ist angelegt, Nachrichten konnten nicht bestaetigt werden", 503, {
        operationId: params.operationId,
        recordId: matchId,
      });
    }
  }

  async ensureRankingWithdrawalEvent(principal, params, plan) {
    if (!this.messagingService) throw new AppError("MESSAGING_UNAVAILABLE", "Nachrichtendienst ist nicht verfuegbar", 503);
    const competition = this.competition(params.bewerbId);
    const competitionName = String(competition.row[headerIndex(competition.header, "bezeichnung")] || "").trim();
    try {
      await this.messagingService.ensureRankingWithdrawalEvent({
        competitionId: params.bewerbId,
        competitionName,
        participantId: principal.id,
        participantName: principal.name || principal.id,
        actorId: principal.id,
        actorName: principal.name || principal.id,
        operationId: params.operationId,
        reason: params.reason,
        createdAt: parseMatchDate(plan.withdrawnAt)?.getTime() || this.now(),
      });
    } catch (error) {
      logger.log("error", "ranking_withdrawal_event_persistence_failed", {
        competitionId: params.bewerbId,
        participantId: principal.id,
        errorCode: error.code || "MESSAGING_WRITE_FAILED",
      });
      throw new AppError("WRITE_OUTCOME_UNKNOWN", "Spieler ist rausgehaengt, Meldung konnte nicht bestaetigt werden", 503, {
        operationId: params.operationId,
        phase: "ranking-withdrawal-event",
        ...plan,
      });
    }
  }

  async ensureRankingMatchDateEvent(principal, params, row, header, previousDate = "") {
    if (!this.messagingService) throw new AppError("MESSAGING_UNAVAILABLE", "Nachrichtendienst ist nicht verfuegbar", 503);
    const competitionId = String(row[headerIndex(header, "bewerbid")] || "").trim();
    const challengerId = parseParticipant(row[headerIndex(header, "spieler1id")]).id;
    const opponentId = parseParticipant(row[headerIndex(header, "spieler3id")]).id;
    const competition = this.competition(competitionId);
    const competitionName = String(competition.row[headerIndex(competition.header, "bezeichnung")] || "").trim();
    const players = dataStore.get("players");
    const playerHeader = headerOf(players);
    const playerIdIndex = headerIndex(playerHeader, "id");
    const firstNameIndex = headerIndex(playerHeader, "vorname");
    const lastNameIndex = headerIndex(playerHeader, "nachname");
    const nameOf = (personId) => {
      const person = players.slice(1).find((entry) => String(entry[playerIdIndex] || "").trim() === personId);
      return person
        ? [person[firstNameIndex], person[lastNameIndex]].map((value) => String(value || "").trim()).filter(Boolean).join(" ") || personId
        : personId;
    };
    try {
      await this.messagingService.ensureMatchAppointmentEvent({
        operationId: params.operationId,
        matchId: params.matchId,
        matchDate: params.matchDate,
        previousDate,
        competitionId,
        competitionName,
        challengerId,
        challengerName: nameOf(challengerId),
        opponentId,
        opponentName: nameOf(opponentId),
        actorId: principal.id,
        actorName: principal.name || nameOf(principal.id),
        createdAt: this.now(),
      });
    } catch (error) {
      logger.log("error", "ranking_match_date_event_persistence_failed", {
        matchId: params.matchId,
        competitionId,
        actorId: principal.id,
        errorCode: error.code || "MESSAGING_WRITE_FAILED",
      });
      throw new AppError("WRITE_OUTCOME_UNKNOWN", "Spieltermin ist eingetragen, Meldungen konnten nicht bestaetigt werden", 503, {
        operationId: params.operationId,
        matchId: params.matchId,
        matchDate: params.matchDate,
        previousDate,
        phase: "appointment-event",
      });
    }
    return { competitionId };
  }

  personName(personId) {
    const players = dataStore.get("players");
    const header = headerOf(players);
    const idIndex = headerIndex(header, "id");
    const firstNameIndex = headerIndex(header, "vorname");
    const lastNameIndex = headerIndex(header, "nachname");
    const row = players.slice(1).find((entry) => String(entry[idIndex] || "").trim() === String(personId));
    return row
      ? [row[firstNameIndex], row[lastNameIndex]].map((value) => String(value || "").trim()).filter(Boolean).join(" ") || String(personId)
      : String(personId);
  }

  adminRankingChallengeContext(row, header) {
    const indexes = {
      ignore: headerIndex(header, "ignore"),
      id: headerIndex(header, "id"),
      matchDate: headerIndex(header, "matchdate"),
      challengeDate: headerIndex(header, "forderungdate"),
      competition: headerIndex(header, "bewerbid"),
      challenger: headerIndex(header, "spieler1id"),
      opponent: headerIndex(header, "spieler3id"),
      result: headerIndex(header, "ergebnis"),
    };
    if ([indexes.id, indexes.matchDate, indexes.challengeDate, indexes.competition, indexes.challenger, indexes.opponent, indexes.result].some((index) => index < 0)) {
      throw new AppError("SHEET_SCHEMA", "Matches1-Spalten fuer administrative Forderungskorrekturen fehlen", 503);
    }
    const competitionId = String(row[indexes.competition] || "").trim();
    const competition = this.competition(competitionId);
    const competitionTypeIndex = headerIndex(competition.header, "bewerbsartid");
    if (competitionTypeIndex < 0) throw new AppError("SHEET_SCHEMA", "Bewerbsart-Spalte fehlt", 503);
    if (String(competition.row[competitionTypeIndex] || "").trim() !== "2") {
      throw new AppError("RANKING_MATCH_REQUIRED", "Die administrative Korrektur ist nur fuer Ranglistenforderungen erlaubt", 409);
    }
    const challenger = parseParticipant(row[indexes.challenger]);
    const opponent = parseParticipant(row[indexes.opponent]);
    if ((indexes.ignore >= 0 && String(row[indexes.ignore] || "").trim() === "1")
      || !String(row[indexes.challengeDate] || "").trim()
      || String(row[indexes.result] || "").trim()
      || !challenger.id
      || !opponent.id
      || challenger.id === opponent.id
      || challenger.retired
      || opponent.retired) {
      throw new AppError("RANKING_CHALLENGE_CLOSED", "Die Forderung ist nicht mehr offen", 409);
    }
    return {
      indexes,
      matchId: String(row[indexes.id] || "").trim(),
      competitionId,
      challengeDate: String(row[indexes.challengeDate] || "").trim(),
      matchDate: String(row[indexes.matchDate] || "").trim(),
      challengerId: challenger.id,
      opponentId: opponent.id,
    };
  }

  async ensureAdminRankingChallengeEvent(principal, params, plan) {
    if (!this.messagingService) throw new AppError("MESSAGING_UNAVAILABLE", "Nachrichtendienst ist nicht verfuegbar", 503);
    const competition = this.competition(plan.competitionId);
    const competitionName = String(competition.row[headerIndex(competition.header, "bezeichnung")] || "").trim();
    try {
      await this.messagingService.ensureAdminRankingChallengeEvent({
        action: plan.action,
        operationId: params.operationId,
        matchId: params.matchId,
        competitionId: plan.competitionId,
        competitionName,
        challengerId: plan.challengerId,
        challengerName: this.personName(plan.challengerId),
        opponentId: plan.opponentId,
        opponentName: this.personName(plan.opponentId),
        actorId: principal.id,
        actorName: principal.name || this.personName(principal.id),
        reason: params.reason,
        previousDate: plan.previousDate || "",
        nextDate: plan.nextDate || "",
        createdAt: plan.occurredAt,
      });
    } catch (error) {
      logger.log("error", "ranking_admin_event_persistence_failed", {
        action: plan.action,
        matchId: params.matchId,
        competitionId: plan.competitionId,
        actorId: principal.id,
        errorCode: error.code || "MESSAGING_WRITE_FAILED",
      });
      throw new AppError("WRITE_OUTCOME_UNKNOWN", "Aenderung ist ausgefuehrt, Meldungen konnten nicht bestaetigt werden", 503, plan);
    }
  }

  competition(competitionId) {
    const values = dataStore.get("bewerbe");
    const header = headerOf(values);
    const idIndex = headerIndex(header, "id");
    const row = values.slice(1).find((entry) => String(entry[idIndex] || "").trim() === competitionId);
    if (!row) throw new AppError("COMPETITION_NOT_FOUND", "Bewerb wurde nicht gefunden", 404);
    return { header, row };
  }

  assertEntryWindow(competitionId, personId) {
    requireCurrentData("bewerbe", "players");
    const players = dataStore.get("players");
    const playerHeader = headerOf(players);
    const playerIdIndex = headerIndex(playerHeader, "id");
    const activeIndex = headerIndex(playerHeader, "aktiv");
    const person = players.slice(1).find((row) => String(row[playerIdIndex] || "").trim() === personId);
    if (!person || (activeIndex >= 0 && String(person[activeIndex] || "").trim() !== "1")) {
      throw new AppError("PLAYER_NOT_ACTIVE", "Spieler ist nicht aktiv", 409);
    }
    const { header, row } = this.competition(competitionId);
    const startIndex = headerIndex(header, "entrystart");
    const deadlineIndex = headerIndex(header, "entrydeadline");
    const start = startIndex < 0 ? null : parseCompetitionDate(row[startIndex], false);
    const deadline = deadlineIndex < 0 ? null : parseCompetitionDate(row[deadlineIndex], true);
    const now = new Date(this.now());
    if (start && now < start) throw new AppError("ENTRY_NOT_OPEN", "Eintragungsfrist hat noch nicht begonnen", 409);
    if (deadline && now > deadline) throw new AppError("ENTRY_CLOSED", "Eintragungsfrist ist abgelaufen", 409);
  }

  assertChallengeAllowed(principal, competitionId, opponentId, matches = dataStore.get("matches1")) {
    requireCurrentData("players", "bewerbe", "matches1", "rlPlatzierung");
    const context = this.rankingChallengeContext(principal, competitionId);
    const players = dataStore.get("players");
    const playerHeader = headerOf(players);
    const playerIdIndex = headerIndex(playerHeader, "id");
    const activeIndex = headerIndex(playerHeader, "aktiv");
    const activePlayers = new Set(players.slice(1)
      .filter((row) => activeIndex < 0 || String(row[activeIndex] || "").trim() === "1")
      .map((row) => String(row[playerIdIndex] || "").trim()));
    if (!activePlayers.has(opponentId)) {
      throw new AppError("PLAYER_NOT_ACTIVE", "Spieler ist nicht aktiv", 409);
    }
    const opponentIndex = context.entries.findIndex((entry) => entry.id === opponentId);
    if (opponentIndex < 0) throw new AppError("RANKING_MEMBERSHIP_REQUIRED", "Gegner muss in der Rangliste gereiht sein", 409);

    if (context.mode === "returning") {
      if (context.entries[opponentIndex].rank < context.returnFromRank) {
        throw new AppError("CHALLENGE_NOT_ALLOWED", "Dieser Spieler kann nicht gefordert werden", 409);
      }
    } else if (context.mode === "ranked") {
      const rows = [];
      for (let index = 0, size = 1; index < context.entries.length; size++) {
        rows.push(context.entries.slice(index, index + size));
        index += size;
      }
      let myRow = -1;
      let myColumn = -1;
      for (const [rowIndex, row] of rows.entries()) {
        const column = row.findIndex((entry) => entry.id === principal.id);
        if (column >= 0) {
          myRow = rowIndex;
          myColumn = column;
          break;
        }
      }
      const allowed = new Set();
      for (let index = 0; index < myColumn; index++) allowed.add(rows[myRow][index].id);
      const rowAbove = rows[myRow - 1] || [];
      for (let index = myColumn; index < rowAbove.length; index++) allowed.add(rowAbove[index].id);
      if (context.rank === 3) {
        const first = context.entries.find((entry) => entry.rank === 1);
        if (first) allowed.add(first.id);
      }
      if (!allowed.has(opponentId)) throw new AppError("CHALLENGE_NOT_ALLOWED", "Dieser Spieler kann nicht gefordert werden", 409);
    }

    const rules = analyzeMatchRules(matches, competitionId, new Date(this.now()));
    if (rules.busyIds.has(principal.id) || rules.busyIds.has(opponentId)) {
      throw new AppError("PLAYER_BUSY", "Mindestens ein Spieler hat bereits eine offene Forderung", 409);
    }
    if (rules.blocked.has(principal.id)) throw new AppError("PLAYER_BLOCKED", "Eigene Sperrzeit ist noch aktiv", 409);
    if (rules.protection.has(opponentId)) throw new AppError("OPPONENT_PROTECTED", "Gegnerische Schonzeit ist noch aktiv", 409);
  }

  rankingChallengeContext(principal, competitionId) {
    requireCurrentData("players", "bewerbe", "rlPlatzierung");
    const { header: competitionHeader, row: competition } = this.competition(competitionId);
    if (String(competition[headerIndex(competitionHeader, "bewerbsartid")] || "").trim() !== "2") {
      throw new AppError("RANKING_REQUIRED", "Bewerb ist keine Rangliste", 409);
    }

    const players = dataStore.get("players");
    const playerHeader = headerOf(players);
    const playerIdIndex = headerIndex(playerHeader, "id");
    const activeIndex = headerIndex(playerHeader, "aktiv");
    const person = players.slice(1).find((row) => String(row[playerIdIndex] || "").trim() === String(principal?.id || ""));
    if (!person || (activeIndex >= 0 && String(person[activeIndex] || "").trim() !== "1")) {
      throw new AppError("PLAYER_NOT_ACTIVE", "Spieler ist nicht aktiv", 409);
    }

    const rankings = dataStore.get("rlPlatzierung");
    const rankingHeader = headerOf(rankings);
    const competitionIndex = headerIndex(rankingHeader, "bewerbid");
    const personIndex = headerIndex(rankingHeader, "personid");
    const rankIndex = headerIndex(rankingHeader, "rang");
    const previousRankIndex = headerIndex(rankingHeader, "rausgehangenletzteplatzierung");
    const withdrawnAtIndex = headerIndex(rankingHeader, "rausgehangenam");
    const competitionEntries = rankings.slice(1)
      .filter((row) => String(row[competitionIndex] || "").trim() === competitionId)
      .map((row) => ({
        id: String(row[personIndex] || "").trim(),
        rank: Number(row[rankIndex]),
        previousRank: Number(row[previousRankIndex]),
        withdrawnAt: String(row[withdrawnAtIndex] || "").trim(),
      }));
    const entries = competitionEntries
      .filter((entry) => entry.id && Number.isInteger(entry.rank) && entry.rank > 0)
      .sort((left, right) => left.rank - right.rank);
    const membership = competitionEntries.find((entry) => entry.id === principal.id);
    if (membership && Number.isInteger(membership.rank) && membership.rank > 0) {
      return { mode: "ranked", rank: membership.rank, returnFromRank: null, entries };
    }
    if (membership?.rank === 0) {
      if (!Number.isInteger(membership.previousRank) || membership.previousRank < 1) {
        throw new AppError("RANKING_RETURN_INVALID", "Gespeicherter Rueckkehrrang ist ungueltig", 409);
      }
      const withdrawnAt = parseMatchDate(membership.withdrawnAt);
      if (!withdrawnAt) throw new AppError("RANKING_RETURN_INVALID", "Raushaengezeitpunkt ist ungueltig", 409);
      const expiresAt = new Date(withdrawnAt);
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      if (new Date(this.now()) <= expiresAt) {
        return { mode: "returning", rank: null, returnFromRank: membership.previousRank, entries };
      }
    } else if (membership) {
      throw new AppError("RANKING_MEMBERSHIP_REQUIRED", "Ranglistenmitgliedschaft ist ungueltig", 409);
    }

    this.assertNewcomerEligible({ competitionHeader, competition, playerHeader, person });
    return { mode: "newcomer", rank: null, returnFromRank: null, entries };
  }

  assertNewcomerEligible({ competitionHeader, competition, playerHeader, person }) {
    const genderIndex = headerIndex(competitionHeader, "geschlecht");
    const allowedGenderText = genderIndex < 0 ? "" : String(competition[genderIndex] || "").trim();
    if (allowedGenderText) {
      const allowedGenders = allowedGenderText.split(",").map((value) => value.trim());
      if (allowedGenders.some((value) => !["1", "2", "3"].includes(value)) || new Set(allowedGenders).size !== allowedGenders.length) {
        throw new AppError("SHEET_SCHEMA", "Geschlecht des Ranglistenbewerbs ist ungueltig", 503);
      }
      const genderIdIndex = headerIndex(playerHeader, "geschlechtid");
      const personGenderIndex = genderIdIndex >= 0 ? genderIdIndex : headerIndex(playerHeader, "geschlecht");
      const personGender = personGenderIndex < 0 ? "" : String(person[personGenderIndex] || "").trim();
      if (!allowedGenders.includes(personGender)) {
        throw new AppError("RANKING_ENTRY_NOT_ELIGIBLE", "Geschlecht passt nicht zum Ranglistenbewerb", 409);
      }
    }

    const ageIndex = headerIndex(competitionHeader, "alterskategorie");
    const ageText = ageIndex < 0 ? "" : String(competition[ageIndex] || "").trim();
    if (!ageText || ageText === "0+") return;
    const ageRule = ageText.match(/^(\d{1,3})([+-])$/);
    if (!ageRule) throw new AppError("SHEET_SCHEMA", "Alterskategorie des Ranglistenbewerbs ist ungueltig", 503);
    const personBirthDateIndex = headerIndex(playerHeader, "geburtsdatum");
    const year = birthYear(personBirthDateIndex < 0 ? "" : person[personBirthDateIndex]);
    if (!year) throw new AppError("RANKING_ENTRY_NOT_ELIGIBLE", "Geburtsdatum fuer die Alterspruefung fehlt", 409);
    const age = viennaYear(new Date(this.now())) - year;
    if (age < 0) throw new AppError("RANKING_ENTRY_NOT_ELIGIBLE", "Geburtsdatum fuer die Alterspruefung ist ungueltig", 409);
    const limit = Number(ageRule[1]);
    const eligible = ageRule[2] === "+" ? age >= limit : age <= limit;
    if (!eligible) throw new AppError("RANKING_ENTRY_NOT_ELIGIBLE", "Alter passt nicht zum Ranglistenbewerb", 409);
  }

  rankingChallengeState(principal, competitionId) {
    try {
      const { mode, rank, returnFromRank } = this.rankingChallengeContext(principal, competitionId);
      return { success: true, mode, rank, returnFromRank };
    } catch (error) {
      if (error?.code === "RANKING_ENTRY_NOT_ELIGIBLE") {
        return { success: true, mode: "ineligible", rank: null, returnFromRank: null };
      }
      throw error;
    }
  }

  challengeEligibility(principal, competitionId, opponentId) {
    if (String(principal?.id || "") === String(opponentId || "")) return { allowed: false, code: "MATCH_SELF" };
    try {
      this.assertChallengeAllowed(principal, competitionId, opponentId);
      return { allowed: true, code: "" };
    } catch (error) {
      if (error instanceof AppError) return { allowed: false, code: error.code };
      throw error;
    }
  }

  assertRankingMembership(principal, competitionId, rank) {
    requireCurrentData("rlPlatzierung");
    const values = dataStore.get("rlPlatzierung");
    const header = headerOf(values);
    const competitionIndex = headerIndex(header, "bewerbid");
    const personIndex = headerIndex(header, "personid");
    const rankIndex = headerIndex(header, "rang");
    const row = values.slice(1).find((entry) => (
      String(entry[competitionIndex] || "").trim() === competitionId
      && String(entry[personIndex] || "").trim() === principal.id
    ));
    if (!row) throw new AppError("RANKING_MEMBERSHIP_REQUIRED", "Spieler ist nicht in dieser Rangliste", 409);
    if (Number(row[rankIndex]) !== rank) throw new AppError("RANK_CONFLICT", "Rang wurde zwischenzeitlich geaendert", 409);
  }

  async getClient() {
    if (this.client) return this.client;
    if (this.clientFactory) {
      this.client = await this.clientFactory();
      return this.client;
    }
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.client = google.sheets({ version: "v4", auth });
    return this.client;
  }

  enqueue(key, callback) {
    if (this.stopping) return Promise.reject(new AppError("SHUTTING_DOWN", "Server wird beendet", 503));
    if (this.active.size >= 1000) return Promise.reject(new AppError("WRITE_QUEUE_FULL", "Schreibwarteschlange ist voll", 503));
    const previous = this.queues.get(key) || Promise.resolve();
    const activity = Object.hasOwn(TABLE_CONFIG, key) ? acquireSheetTableActivity(key) : Promise.resolve(null);
    const operation = Promise.all([previous.catch(() => {}), activity]).then(async ([, release]) => {
      try {
        return await callback();
      } finally {
        release?.();
      }
    });
    this.queues.set(key, operation);
    this.active.add(operation);
    operation.finally(() => {
      this.active.delete(operation);
      if (this.queues.get(key) === operation) this.queues.delete(key);
    }).catch(() => {});
    return operation;
  }

  async readTable(tableName, purpose = "write_precondition") {
    const config = TABLE_CONFIG[tableName];
    if (!config) throw new AppError("TABLE_UNKNOWN", `Tabelle ${tableName} ist unbekannt`, 500);
    const sheets = await this.getClient();
    const response = await executeSheetRead({
      method: "values_get",
      purpose,
      call: (options) => sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: config.range }, options),
    });
    return validateTableValues(tableName, response.data.values || []);
  }

  async getSheetId(sheets, tableName) {
    if (this.sheetIds.has(tableName)) return this.sheetIds.get(tableName);
    const title = TABLE_CONFIG[tableName].range;
    if (!this.sheetIdsLoad) {
      this.sheetIdsLoad = (async () => {
        const spreadsheet = await executeSheetRead({
          method: "spreadsheet_get",
          purpose: "sheet_properties",
          call: (options) => sheets.spreadsheets.get({
            spreadsheetId: SHEET_ID,
            fields: "sheets.properties(sheetId,title)",
          }, options),
        });
        const tableByTitle = new Map(Object.entries(TABLE_CONFIG).map(([name, config]) => [config.range, name]));
        for (const sheet of spreadsheet.data.sheets || []) {
          const knownTable = tableByTitle.get(sheet.properties?.title);
          if (knownTable) this.sheetIds.set(knownTable, sheet.properties.sheetId);
        }
      })().finally(() => { this.sheetIdsLoad = null; });
    }
    await this.sheetIdsLoad;
    if (!this.sheetIds.has(tableName)) throw new AppError("SHEET_SCHEMA", `${title}-Tab fehlt`, 503);
    return this.sheetIds.get(tableName);
  }

  async loadRecordMetadata(sheets) {
    if (this.recordMetadataScanned) return;
    if (!this.recordMetadataLoad) {
      this.recordMetadataLoad = (async () => {
        const response = await executeSheetRead({
          method: "metadata_search",
          purpose: "metadata_search",
          call: (options) => sheets.spreadsheets.developerMetadata.search({
            spreadsheetId: SHEET_ID,
            requestBody: {
              dataFilters: [{ developerMetadataLookup: {
                metadataKey: RECORD_METADATA_KEY,
                visibility: "DOCUMENT",
                locationType: "ROW",
              } }],
            },
          }, options),
        });
        const grouped = new Map();
        for (const match of response.data.matchedDeveloperMetadata || []) {
          const metadata = match.developerMetadata;
          const cacheKey = String(metadata?.metadataValue || "");
          if (!metadata || !Object.keys(TABLE_CONFIG).some((name) => cacheKey.startsWith(`${name}:`))) continue;
          if (!grouped.has(cacheKey)) grouped.set(cacheKey, []);
          grouped.get(cacheKey).push(metadata);
        }
        for (const [cacheKey, matches] of grouped) {
          if (matches.length === 1) this.recordMetadata.set(cacheKey, matches[0]);
          else this.recordMetadataUnresolved.add(cacheKey);
        }
        this.recordMetadataScanned = true;
      })().finally(() => { this.recordMetadataLoad = null; });
    }
    await this.recordMetadataLoad;
  }

  async findRecordMetadata(sheets, tableName, recordId) {
    const cacheKey = `${tableName}:${recordId}`;
    const previouslyScanned = this.recordMetadataScanned;
    await this.loadRecordMetadata(sheets);
    if (this.recordMetadata.has(cacheKey)) {
      const metadata = this.recordMetadata.get(cacheKey);
      this.confirmRecordMetadataIntent(cacheKey, metadata);
      return metadata;
    }
    if (!previouslyScanned && !this.recordMetadataUnresolved.has(cacheKey)) return null;
    const response = await executeSheetRead({
      method: "metadata_search",
      purpose: "metadata_search",
      call: (options) => sheets.spreadsheets.developerMetadata.search({
        spreadsheetId: SHEET_ID,
        requestBody: {
          dataFilters: [{ developerMetadataLookup: {
            metadataKey: RECORD_METADATA_KEY,
            metadataValue: cacheKey,
            visibility: "DOCUMENT",
            locationType: "ROW",
          } }],
        },
      }, options),
    });
    let matches = (response.data.matchedDeveloperMetadata || []).map((entry) => entry.developerMetadata).filter(Boolean);
    if (matches.length > 1) {
      const locationKey = (metadata) => {
        const range = metadata.location?.dimensionRange;
        return range ? `${range.sheetId}:${range.startIndex}:${range.endIndex}` : null;
      };
      const locations = matches.map(locationKey);
      if (locations.some((location) => !location) || new Set(locations).size !== 1) {
        throw new AppError("SHEET_SCHEMA", `Metadaten fuer ${cacheKey} sind nicht eindeutig`, 503);
      }
      matches.sort((left, right) => Number(left.metadataId) - Number(right.metadataId));
      const [keep, ...duplicates] = matches;
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: {
            requests: duplicates.map((metadata) => ({
              deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataId: metadata.metadataId } } },
            })),
          },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
      } catch (error) {
        logger.log("warn", "sheet_metadata_duplicate_cleanup_failed", { table: tableName, recordId, duplicateCount: duplicates.length, error });
      }
      matches = [keep];
    }
    const metadata = matches[0] || null;
    if (metadata) {
      this.recordMetadata.set(cacheKey, metadata);
      this.recordMetadataUnresolved.delete(cacheKey);
      this.confirmRecordMetadataIntent(cacheKey, metadata);
    }
    return metadata;
  }

  confirmRecordMetadataIntent(cacheKey, metadata) {
    const intentKey = `record-metadata-intent:${cacheKey}`;
    const intent = this.repository.getState(intentKey, { status: "none" });
    if (["none", "confirmed"].includes(intent.value.status)) return;
    this.repository.setState(intentKey, { status: "confirmed", metadataId: metadata.metadataId, at: this.now() }, intent.revision);
  }

  async createRecordMetadata(sheets, tableName, recordId, rowIndex) {
    const cacheKey = `${tableName}:${recordId}`;
    const sheetId = await this.getSheetId(sheets, tableName);
    const intentKey = `record-metadata-intent:${cacheKey}`;
    const intent = this.repository.getState(intentKey, { status: "none" });
    if (intent.value.status === "pending") {
      throw new AppError("WRITE_OUTCOME_UNKNOWN", "Zeilenmetadaten werden noch bestaetigt", 503, { tableName, recordId });
    }
    this.repository.setState(intentKey, { status: "pending", at: this.now() }, intent.revision);
    let metadata;
    try {
      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: [{ createDeveloperMetadata: { developerMetadata: {
            metadataKey: RECORD_METADATA_KEY,
            metadataValue: cacheKey,
            visibility: "DOCUMENT",
            location: { dimensionRange: { sheetId, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1 } },
          } } }],
        },
      }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
      metadata = response.data.replies?.[0]?.createDeveloperMetadata?.developerMetadata;
    } catch (error) {
      try {
        metadata = await this.findRecordMetadata(sheets, tableName, recordId);
      } catch (confirmationError) {
        logger.log("error", "sheet_metadata_confirmation_read_failed", { table: tableName, recordId, error: confirmationError });
      }
      if (!metadata) {
        const status = Number(error?.response?.status || error?.status || 0);
        if (status >= 400 && status < 500 && status !== 408) {
          const pending = this.repository.getState(intentKey, { status: "pending" });
          this.repository.setState(intentKey, { status: "failed", at: this.now(), statusCode: status }, pending.revision);
          if (status === 429) throw rateLimitError();
          throw error;
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Metadatenerstellung ist unklar", 503, { tableName, recordId });
      }
    }
    if (metadata?.metadataId === undefined || metadata.metadataId === null) {
      throw new AppError("WRITE_OUTCOME_UNKNOWN", "Zeilenmetadaten konnten nicht bestaetigt werden", 503);
    }
    this.recordMetadata.set(cacheKey, metadata);
    const pending = this.repository.getState(intentKey, { status: "pending" });
    this.repository.setState(intentKey, { status: "confirmed", metadataId: metadata.metadataId, at: this.now() }, pending.revision);
    return metadata;
  }

  async searchRecordMetadataBatch(sheets, tableName, recordIds) {
    if (!recordIds.length) return new Map();
    const cacheKeys = new Set(recordIds.map((recordId) => `${tableName}:${recordId}`));
    const response = await executeSheetRead({
      method: "metadata_search",
      purpose: "metadata_search",
      call: (options) => sheets.spreadsheets.developerMetadata.search({
        spreadsheetId: SHEET_ID,
        requestBody: {
          dataFilters: [...cacheKeys].map((metadataValue) => ({ developerMetadataLookup: {
            metadataKey: RECORD_METADATA_KEY,
            metadataValue,
            visibility: "DOCUMENT",
            locationType: "ROW",
          } })),
        },
      }, options),
    });
    const grouped = new Map();
    for (const match of response.data.matchedDeveloperMetadata || []) {
      const metadata = match.developerMetadata;
      const cacheKey = String(metadata?.metadataValue || "");
      if (!metadata || !cacheKeys.has(cacheKey)) continue;
      if (!grouped.has(cacheKey)) grouped.set(cacheKey, []);
      grouped.get(cacheKey).push(metadata);
    }
    const result = new Map();
    const duplicates = [];
    for (const recordId of recordIds) {
      const cacheKey = `${tableName}:${recordId}`;
      const matches = grouped.get(cacheKey) || [];
      if (matches.length > 1) {
        const locations = matches.map((metadata) => {
          const range = metadata.location?.dimensionRange;
          return range ? `${range.sheetId}:${range.startIndex}:${range.endIndex}` : null;
        });
        if (locations.some((location) => !location) || new Set(locations).size !== 1) {
          throw new AppError("SHEET_SCHEMA", `Metadaten fuer ${cacheKey} sind nicht eindeutig`, 503);
        }
        matches.sort((left, right) => Number(left.metadataId) - Number(right.metadataId));
        duplicates.push(...matches.slice(1));
      }
      if (matches.length) result.set(recordId, matches[0]);
    }
    if (duplicates.length) {
      const startedAt = Date.now();
      metrics.recordSheetApiAttempt({ method: "metadata_cleanup", purpose: "metadata_cleanup", kind: "initial" });
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: {
            requests: duplicates.map((metadata) => ({
              deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataId: metadata.metadataId } } },
            })),
          },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
        metrics.recordSheetApiRequest({ method: "metadata_cleanup", purpose: "metadata_cleanup", result: "success", durationMs: Date.now() - startedAt });
      } catch (error) {
        metrics.recordSheetApiRequest({ method: "metadata_cleanup", purpose: "metadata_cleanup", result: "failed", durationMs: Date.now() - startedAt });
        logger.log("warn", "sheet_metadata_duplicate_cleanup_failed", { table: tableName, duplicateCount: duplicates.length, error });
      }
    }
    return result;
  }

  async createRecordMetadataBatch(sheets, tableName, records) {
    if (!records.length) return new Map();
    const sheetId = await this.getSheetId(sheets, tableName);
    const intents = records.map(({ recordId, rowIndex }) => {
      const cacheKey = `${tableName}:${recordId}`;
      const intentKey = `record-metadata-intent:${cacheKey}`;
      const intent = this.repository.getState(intentKey, { status: "none" });
      if (intent.value.status === "pending") {
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Zeilenmetadaten werden noch bestaetigt", 503, { tableName, recordId });
      }
      this.repository.setState(intentKey, { status: "pending", at: this.now() }, intent.revision);
      return { cacheKey, intentKey, recordId, rowIndex };
    });
    let metadataByIndex;
    try {
      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: intents.map(({ cacheKey, rowIndex }) => ({
            createDeveloperMetadata: { developerMetadata: {
              metadataKey: RECORD_METADATA_KEY,
              metadataValue: cacheKey,
              visibility: "DOCUMENT",
              location: { dimensionRange: { sheetId, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1 } },
            } },
          })),
        },
      }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
      const replies = response.data.replies || [];
      if (replies.length === intents.length) {
        metadataByIndex = replies.map((reply) => reply?.createDeveloperMetadata?.developerMetadata);
      }
    } catch (error) {
      try {
        const confirmed = await this.searchRecordMetadataBatch(sheets, tableName, intents.map(({ recordId }) => recordId));
        if (confirmed.size === intents.length) metadataByIndex = intents.map(({ recordId }) => confirmed.get(recordId));
      } catch {}
      if (!metadataByIndex) {
        const status = Number(error?.response?.status || error?.status || 0);
        if (status >= 400 && status < 500 && status !== 408) {
          for (const intent of intents) {
            const pending = this.repository.getState(intent.intentKey, { status: "pending" });
            this.repository.setState(intent.intentKey, { status: "failed", at: this.now(), statusCode: status }, pending.revision);
          }
          if (status === 429) throw rateLimitError();
          throw error;
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Metadatenerstellung ist unklar", 503, {
          tableName,
          recordIds: intents.map(({ recordId }) => recordId),
        });
      }
    }
    if (!metadataByIndex || metadataByIndex.some((metadata) => metadata?.metadataId === undefined || metadata.metadataId === null)) {
      throw new AppError("WRITE_OUTCOME_UNKNOWN", "Zeilenmetadaten konnten nicht vollstaendig bestaetigt werden", 503, {
        tableName,
        recordIds: intents.map(({ recordId }) => recordId),
      });
    }
    const result = new Map();
    intents.forEach((intent, index) => {
      const metadata = metadataByIndex[index];
      this.recordMetadata.set(intent.cacheKey, metadata);
      const pending = this.repository.getState(intent.intentKey, { status: "pending" });
      this.repository.setState(intent.intentKey, { status: "confirmed", metadataId: metadata.metadataId, at: this.now() }, pending.revision);
      result.set(intent.recordId, metadata);
    });
    return result;
  }

  async deleteRecordMetadata(sheets, tableName, recordId, metadataId) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataId } } } }] },
    }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
    this.recordMetadata.delete(`${tableName}:${recordId}`);
    const intentKey = `record-metadata-intent:${tableName}:${recordId}`;
    const intent = this.repository.getState(intentKey, { status: "none" });
    this.repository.setState(intentKey, { status: "deleted", at: this.now() }, intent.revision);
  }

  async readMetadataRow(sheets, metadataId, valueRenderOption = "FORMULA", purpose = "metadata_row") {
    const response = await executeSheetRead({
      method: "metadata_row",
      purpose,
      call: (options) => sheets.spreadsheets.values.batchGetByDataFilter({
        spreadsheetId: SHEET_ID,
        requestBody: {
          dataFilters: [{ developerMetadataLookup: { metadataId } }],
          majorDimension: "ROWS",
          valueRenderOption,
        },
      }, options),
    });
    const rows = (response.data.valueRanges || []).flatMap((entry) => entry.valueRange?.values || []);
    return rows.length === 1 ? rows[0] : null;
  }

  async readMetadataRows(sheets, metadataIds, valueRenderOption = "UNFORMATTED_VALUE") {
    if (!metadataIds.length) return new Map();
    const response = await executeSheetRead({
      method: "metadata_rows",
      purpose: "metadata_rows",
      call: (options) => sheets.spreadsheets.values.batchGetByDataFilter({
        spreadsheetId: SHEET_ID,
        requestBody: {
          dataFilters: metadataIds.map((metadataId) => ({ developerMetadataLookup: { metadataId } })),
          majorDimension: "ROWS",
          valueRenderOption,
        },
      }, options),
    });
    const result = new Map();
    for (const entry of response.data.valueRanges || []) {
      const rows = entry.valueRange?.values || [];
      if (rows.length !== 1) continue;
      for (const filter of entry.dataFilters || []) {
        const metadataId = filter.developerMetadataLookup?.metadataId;
        if (metadataId !== undefined && metadataId !== null) result.set(Number(metadataId), rows[0]);
      }
    }
    return result;
  }

  async resolveStableRow(tableName, recordId, initialValues = null, valueRenderOption = "FORMULA") {
    const sheets = await this.getClient();
    let values = initialValues || await this.readTable(tableName);
    for (let attempt = 0; attempt < 3; attempt++) {
      const header = headerOf(values);
      const idIndex = headerIndex(header, "id");
      const offset = values.slice(1).findIndex((row) => String(row[idIndex] || "").trim() === recordId);
      if (offset < 0) throw new AppError("RECORD_NOT_FOUND", "Datensatz wurde nicht gefunden", 404);
      let metadata = await this.findRecordMetadata(sheets, tableName, recordId);
      if (!metadata) metadata = await this.createRecordMetadata(sheets, tableName, recordId, offset + 1);
      const row = await this.readMetadataRow(sheets, metadata.metadataId, valueRenderOption);
      if (row && String(row[idIndex] || "").trim() === recordId) return { sheets, metadata, row, header };
      await this.deleteRecordMetadata(sheets, tableName, recordId, metadata.metadataId);
      values = await this.readTable(tableName);
    }
    throw new AppError("WRITE_CONFLICT", "Datensatz wurde waehrend der Aktualisierung verschoben", 409);
  }

  async resolveStableCompositeRow(tableName, recordId, identity, initialValues = null) {
    const sheets = await this.getClient();
    let values = initialValues || await this.readTable(tableName);
    for (let attempt = 0; attempt < 3; attempt++) {
      const header = headerOf(values);
      const offset = values.slice(1).findIndex((row) => identity(row, header));
      if (offset < 0) throw new AppError("RECORD_NOT_FOUND", "Datensatz wurde nicht gefunden", 404);
      let metadata = await this.findRecordMetadata(sheets, tableName, recordId);
      if (!metadata) metadata = await this.createRecordMetadata(sheets, tableName, recordId, offset + 1);
      const row = await this.readMetadataRow(sheets, metadata.metadataId, "UNFORMATTED_VALUE");
      if (row && identity(row, header)) return { sheets, metadata, row, header };
      await this.deleteRecordMetadata(sheets, tableName, recordId, metadata.metadataId);
      values = await this.readTable(tableName);
    }
    throw new AppError("WRITE_CONFLICT", "Ranglistenzeile wurde waehrend der Aktualisierung verschoben", 409);
  }

  async resolveStableCompositeRows(tableName, records, initialValues = null) {
    const sheets = await this.getClient();
    const values = initialValues || await this.readTable(tableName);
    const header = headerOf(values);
    await this.loadRecordMetadata(sheets);
    const resolvedMetadata = new Map();
    const missing = [];
    const unresolved = [];
    for (const record of records) {
      const cacheKey = `${tableName}:${record.recordId}`;
      const metadata = this.recordMetadata.get(cacheKey) || null;
      if (metadata) {
        resolvedMetadata.set(record.recordId, metadata);
        continue;
      }
      if (this.recordMetadataUnresolved.has(cacheKey)) {
        unresolved.push(record.recordId);
        continue;
      }
      const offset = values.slice(1).findIndex((row) => record.identity(row, header));
      if (offset < 0) throw new AppError("RECORD_NOT_FOUND", "Datensatz wurde nicht gefunden", 404);
      missing.push({ recordId: record.recordId, rowIndex: offset + 1 });
    }
    if (unresolved.length) {
      const recovered = await this.searchRecordMetadataBatch(sheets, tableName, unresolved);
      for (const recordId of unresolved) {
        const metadata = recovered.get(recordId);
        if (!metadata) throw new AppError("SHEET_SCHEMA", `Metadaten fuer ${tableName}:${recordId} fehlen`, 503);
        const cacheKey = `${tableName}:${recordId}`;
        this.recordMetadata.set(cacheKey, metadata);
        this.recordMetadataUnresolved.delete(cacheKey);
        this.confirmRecordMetadataIntent(cacheKey, metadata);
        resolvedMetadata.set(recordId, metadata);
      }
    }
    const pending = missing.filter(({ recordId }) => (
      this.repository.getState(`record-metadata-intent:${tableName}:${recordId}`, { status: "none" }).value.status === "pending"
    ));
    if (pending.length) {
      const confirmed = await this.searchRecordMetadataBatch(sheets, tableName, pending.map(({ recordId }) => recordId));
      for (const { recordId } of pending) {
        const intentKey = `record-metadata-intent:${tableName}:${recordId}`;
        const intent = this.repository.getState(intentKey, { status: "pending" });
        const metadata = confirmed.get(recordId);
        if (metadata) {
          this.recordMetadata.set(`${tableName}:${recordId}`, metadata);
          this.repository.setState(intentKey, { status: "confirmed", metadataId: metadata.metadataId, at: this.now() }, intent.revision);
          resolvedMetadata.set(recordId, metadata);
        } else {
          this.repository.setState(intentKey, { status: "retry", at: this.now() }, intent.revision);
        }
      }
    }
    const toCreate = missing.filter(({ recordId }) => !resolvedMetadata.has(recordId));
    for (const [recordId, metadata] of await this.createRecordMetadataBatch(sheets, tableName, toCreate)) {
      resolvedMetadata.set(recordId, metadata);
    }
    const rows = await this.readMetadataRows(
      sheets,
      records.map(({ recordId }) => resolvedMetadata.get(recordId).metadataId),
    );
    const result = [];
    for (const record of records) {
      const metadata = resolvedMetadata.get(record.recordId);
      const row = rows.get(Number(metadata.metadataId));
      if (row && record.identity(row, header)) {
        result.push({ sheets, metadata, row, header });
      } else {
        result.push(await this.resolveStableCompositeRow(tableName, record.recordId, record.identity, values));
      }
    }
    return result;
  }

  async refreshCache(tableName, fallback) {
    try {
      const fresh = await this.readTable(tableName, "write_refresh");
      dataStore.set(tableName, fresh, { source: "write-refresh" });
      return fresh;
    } catch (error) {
      logger.log("error", "sheet_cache_refresh_failed", { table: tableName, error });
      return fallback(structuredClone(dataStore.get(tableName)));
    }
  }

  cancelScheduledRefresh(tableName) {
    const timer = this.refreshTimers.get(tableName);
    if (timer) clearTimeout(timer);
    this.refreshTimers.delete(tableName);
  }

  scheduleRefresh(tableName) {
    this.cancelScheduledRefresh(tableName);
    const timer = setTimeout(() => {
      this.refreshTimers.delete(tableName);
      this.enqueue(tableName, () => this.refreshCache(tableName, (cached) => cached)).catch((error) => {
        if (error.code !== "SHUTTING_DOWN") logger.log("error", "sheet_scheduled_refresh_failed", { table: tableName, error });
      });
    }, this.refreshDelayMs);
    timer.unref?.();
    this.refreshTimers.set(tableName, timer);
  }

  async runIdempotent(principal, endpoint, operationId, payload, callback) {
    const actorKey = `${principal.type}:${principal.id}`;
    const existing = this.repository.getOperation(actorKey, operationId, endpoint, payload);
    if (existing && existing.operationStatus !== "unknown") return { ...existing, repeated: true };
    return this.enqueue(`operation:${actorKey}:${operationId}`, async () => {
      const repeated = this.repository.getOperation(actorKey, operationId, endpoint, payload);
      if (repeated && repeated.operationStatus !== "unknown") return { ...repeated, repeated: true };
      let checkpointed = false;
      try {
        const result = await callback({
          recoveryOnly: repeated?.operationStatus === "unknown",
          recoveryDetails: repeated?.details || null,
          checkpointUnknown: (details) => {
            const marker = { operationStatus: "unknown", details };
            const current = this.repository.getOperation(actorKey, operationId, endpoint, payload);
            if (current) this.repository.replaceOperation(actorKey, operationId, endpoint, payload, marker);
            else this.repository.saveOperation(actorKey, operationId, endpoint, payload, marker);
            checkpointed = true;
          },
        });
        const current = this.repository.getOperation(actorKey, operationId, endpoint, payload);
        if (current) this.repository.replaceOperation(actorKey, operationId, endpoint, payload, result);
        else this.repository.saveOperation(actorKey, operationId, endpoint, payload, result);
        return repeated ? { ...result, repeated: true } : result;
      } catch (error) {
        if (error.code === "WRITE_OUTCOME_UNKNOWN") {
          const marker = {
            operationStatus: "unknown",
            details: Object.hasOwn(error, "_recoveryDetails") ? error._recoveryDetails : error.details || null,
          };
          if (repeated) this.repository.replaceOperation(actorKey, operationId, endpoint, payload, marker);
          else this.repository.saveOperation(actorKey, operationId, endpoint, payload, marker);
        } else if (checkpointed) {
          this.repository.deleteOperation(actorKey, operationId, endpoint, payload);
        }
        throw error;
      }
    });
  }

  async reconcilePerson(principal, params) {
    const { operationId, ...rawRequest } = params;
    const request = validateReconciliationRequest(rawRequest);
    return this.runIdempotent(principal, "reconcilePerson", operationId, request, ({ recoveryOnly, recoveryDetails }) => this.enqueue("players", async () => {
      this.cancelScheduledRefresh("players");
      const values = await this.readTable("players");
      dataStore.set("players", values, { source: "write-read" });
      const header = headerOf(values);
      const idIndex = headerIndex(header, "id");
      const externalIdIndex = headerIndex(header, "cd-id");
      if (idIndex < 0 || externalIdIndex < 0) throw new AppError("SHEET_SCHEMA", "Personen-Spalten ID oder CD-ID fehlen", 503);
      const projection = projectPeopleReconciliation(values);

      if (request.action === "create") {
        const existingIds = values.slice(1).map((row) => String(row[idIndex] || "").trim()).filter(Boolean);
        if (existingIds.some((id) => !/^\d+$/.test(id))) {
          throw new AppError("SHEET_SCHEMA", "Personen-IDs muessen fuer Neuanlagen numerisch sein", 503);
        }
        const recoveryPersonId = String(recoveryDetails?.personId || recoveryDetails?.recordId || "");
        const newPersonId = recoveryOnly
          ? recoveryPersonId
          : (existingIds.reduce((max, id) => {
            const value = BigInt(id);
            return value > max ? value : max;
          }, 0n) + 1n).toString();
        if (newPersonId.length > 64) throw new AppError("SHEET_SCHEMA", "Naechste Personen-ID ist zu lang", 503);
        if (!newPersonId) {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Neuanlage ist noch nicht nachweisbar", 503, { externalId: request.externalId });
        }
        assertUniqueExternalId(projection.people, request.externalId, recoveryOnly ? newPersonId : "");
        const existingRowOffset = values.slice(1).findIndex((row) => (
          String(row[idIndex] || "").trim() === newPersonId
          && String(row[externalIdIndex] || "").trim() === request.externalId
        ));
        if (recoveryOnly && existingRowOffset < 0) {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Neuanlage ist noch nicht nachweisbar", 503, {
            personId: newPersonId,
            externalId: request.externalId,
          });
        }

        const indexes = fieldIndexes(header);
        for (const field of Object.keys(FIELD_DEFINITIONS)) {
          if (indexes[field] < 0) throw new AppError("SHEET_SCHEMA", `Personen-Spalte fuer ${field} fehlt`, 503);
        }
        const controlledValues = Object.fromEntries(Object.keys(FIELD_DEFINITIONS).map((field) => [field, request.values[field] || ""]));
        let newRow = existingRowOffset >= 0 ? values[existingRowOffset + 1] : null;
        if (newRow && Object.entries(controlledValues).some(([field, value]) => String(newRow[indexes[field]] ?? "") !== value)) {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Neuanlage stimmt nicht mit dem bestaetigten Zielstand ueberein", 503, {
            personId: newPersonId,
            externalId: request.externalId,
          });
        }
        const sheets = await this.getClient();
        let refreshed = values;
        let confirmedRowOffset = existingRowOffset;
        if (!newRow) {
          newRow = Array(header.length).fill("");
          newRow[idIndex] = newPersonId;
          newRow[externalIdIndex] = request.externalId;
          for (const [field, value] of Object.entries(controlledValues)) newRow[indexes[field]] = value;
          const candidate = structuredClone(values);
          candidate.push(newRow);
          validateTableValues("players", candidate);
          assertPlayerLoginConflictsNotWorsened(values, candidate);
          let appendError = null;
          try {
            await sheets.spreadsheets.values.append({
              spreadsheetId: SHEET_ID,
              range: TABLE_CONFIG.players.range,
              valueInputOption: "RAW",
              requestBody: { values: [newRow] },
            }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
          } catch (error) {
            appendError = error;
          }
          try {
            refreshed = await this.readTable("players", "confirmation");
            confirmedRowOffset = refreshed.slice(1).findIndex((row) => (
              String(row[idIndex] || "").trim() === newPersonId
              && String(row[externalIdIndex] || "").trim() === request.externalId
            ));
            if (confirmedRowOffset < 0) throw appendError || new Error("Angehaengte Personenzeile fehlt");
            newRow = refreshed[confirmedRowOffset + 1];
            if (Object.entries(controlledValues).some(([field, value]) => String(newRow[indexes[field]] ?? "") !== value)) {
              throw appendError || new Error("Angehaengte Personenzeile weicht ab");
            }
            validateTableValues("players", refreshed);
            assertPlayerLoginConflictsNotWorsened(values, refreshed);
            assertUniqueExternalId(projectPeopleReconciliation(refreshed).people, request.externalId, newPersonId);
          } catch {
            throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Personenneuanlage ist unklar", 503, {
              personId: newPersonId,
              externalId: request.externalId,
            });
          }
        }

        const rowIndex = confirmedRowOffset + 1;
        let metadata;
        try {
          metadata = await this.findRecordMetadata(sheets, "players", newPersonId);
          if (!metadata) metadata = await this.createRecordMetadata(sheets, "players", newPersonId, rowIndex);
          if (!metadata?.metadataId) throw new Error("Metadaten-ID fehlt");
        } catch {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Metadaten der neuen Person sind unklar", 503, {
            personId: newPersonId,
            externalId: request.externalId,
          });
        }
        dataStore.set("players", refreshed, { source: "write-local", authoritative: false });
        this.scheduleRefresh("players");
        const afterProjection = projectPeopleReconciliation(refreshed).people.find((person) => person.id === newPersonId);
        return withAudit({
          success: true,
          action: "create",
          personId: newPersonId,
          fingerprint: afterProjection?.fingerprint || reconciliationFingerprint(controlledValues, request.externalId),
          recovered: recoveryOnly || undefined,
        }, {
          targetName: [controlledValues.firstName, controlledValues.lastName].filter(Boolean).join(" "),
          before: null,
          after: reconciliationAuditValues(["externalId", ...Object.keys(request.values)], { externalId: request.externalId, ...request.values }, "gesetzt"),
        });
      }

      let stable;
      try {
        stable = await this.resolveStableRow("players", request.personId, values, "FORMATTED_VALUE");
      } catch (error) {
        if (error.code === "RECORD_NOT_FOUND") throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
        throw error;
      }
      const { metadata, row, sheets } = stable;
      const beforeValues = rawPersonValues(header, row);
      const beforeExternalId = String(row[externalIdIndex] || "").trim();
      const currentFingerprint = reconciliationFingerprint(beforeValues, beforeExternalId);
      if (currentFingerprint !== request.expectedFingerprint && !recoveryOnly) {
        throw new AppError("PERSON_CONFLICT", "Personendaten wurden zwischenzeitlich geaendert", 409, {
          personId: request.personId,
          currentFingerprint,
        });
      }

      let targetExternalId = beforeExternalId;
      let changes;
      if (request.action === "deactivate") {
        const role = String(beforeValues.role || "").trim().toLowerCase();
        if (["admin", "operator"].includes(role)) {
          throw new AppError("ROLE_PROTECTED", "Admin und Operator duerfen nicht durch den Mitgliederabgleich deaktiviert werden", 409);
        }
        changes = { active: "" };
      } else {
        const currentPerson = { id: request.personId, externalId: beforeExternalId };
        if (!recoveryOnly) assertUpdateCandidate(currentPerson, request);
        if (!recoveryOnly && beforeExternalId && beforeExternalId !== request.externalId) {
          throw new AppError("EXTERNAL_ID_CONFLICT", "Eine bestehende CD-ID darf nicht neu zugeordnet werden", 409);
        }
        assertUniqueExternalId(projection.people, request.externalId, request.personId);
        targetExternalId = request.externalId;
        changes = request.changes;
        const currentRole = String(beforeValues.role || "").trim().toLowerCase();
        if (["admin", "operator"].includes(currentRole) && Object.hasOwn(changes, "role") && changes.role.toLowerCase() !== currentRole) {
          throw new AppError("ROLE_PROTECTED", "Admin- und Operatorrollen duerfen nicht aus Importdaten geaendert werden", 409);
        }
      }

      const indexes = fieldIndexes(header);
      for (const field of Object.keys(changes)) {
        if (indexes[field] < 0) throw new AppError("SHEET_SCHEMA", `Personen-Spalte fuer ${field} fehlt`, 503);
      }
      const targetsMatch = String(row[externalIdIndex] || "").trim() === targetExternalId
        && Object.entries(changes).every(([field, value]) => String(row[indexes[field]] ?? "") === value);
      if (recoveryOnly && !targetsMatch) {
        if (["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) this.repository.revokeUserSessions(request.personId);
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang des Mitgliederabgleichs ist weiterhin unklar", 503, { personId: request.personId });
      }
      if (targetsMatch) {
        if (recoveryOnly && ["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) {
          this.repository.revokeUserSessions(request.personId);
        }
        return withAudit({ success: true, action: request.action, personId: request.personId, fingerprint: currentFingerprint, repeated: true }, {
          targetName: [beforeValues.firstName, beforeValues.lastName].map((value) => String(value || "").trim()).filter(Boolean).join(" "),
          before: null,
          after: null,
        });
      }

      const candidate = structuredClone(values);
      const candidateRow = candidate.slice(1).find((entry) => String(entry[idIndex] || "").trim() === request.personId);
      if (!candidateRow) throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
      candidateRow[externalIdIndex] = targetExternalId;
      for (const [field, value] of Object.entries(changes)) candidateRow[indexes[field]] = value;
      validateTableValues("players", candidate);
      assertPlayerLoginConflictsNotWorsened(values, candidate);
      if (targetExternalId) assertUniqueExternalId(projectPeopleReconciliation(candidate).people, targetExternalId, request.personId);

      const maxIndex = Math.max(externalIdIndex, ...Object.keys(changes).map((field) => indexes[field]));
      const updates = Array(maxIndex + 1).fill(null);
      updates[externalIdIndex] = targetExternalId;
      for (const [field, value] of Object.entries(changes)) updates[indexes[field]] = value;
      try {
        const response = await sheets.spreadsheets.values.batchUpdateByDataFilter({
          spreadsheetId: SHEET_ID,
          requestBody: {
            valueInputOption: "RAW",
            data: [{
              dataFilter: { developerMetadataLookup: { metadataId: metadata.metadataId } },
              majorDimension: "ROWS",
              values: [updates],
            }],
          },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
        if (Number(response.data.totalUpdatedRows) !== 1) throw new Error("Metadaten-Update hat keine eindeutige Zeile aktualisiert");
      } catch (error) {
        try {
          const confirmationRow = await this.readMetadataRow(sheets, metadata.metadataId, "FORMATTED_VALUE", "confirmation");
          const confirmed = confirmationRow
            && String(confirmationRow[externalIdIndex] || "").trim() === targetExternalId
            && Object.entries(changes).every(([field, value]) => String(confirmationRow[indexes[field]] ?? "") === value);
          if (!confirmed) throw error;
        } catch {
          if (["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) this.repository.revokeUserSessions(request.personId);
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang des Mitgliederabgleichs ist unklar", 503, { personId: request.personId });
        }
      }

      dataStore.set("players", candidate, { source: "write-local", authoritative: false });
      this.scheduleRefresh("players");
      if (["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) this.repository.revokeUserSessions(request.personId);
      const afterProjection = projectPeopleReconciliation(candidate).people.find((person) => person.id === request.personId);
      const changedExternalId = beforeExternalId !== targetExternalId;
      return withAudit({
        success: true,
        action: request.action,
        personId: request.personId,
        fingerprint: afterProjection?.fingerprint || "",
      }, {
        targetName: [afterProjection?.values.firstName, afterProjection?.values.lastName].map((value) => String(value || "").trim()).filter(Boolean).join(" "),
        before: reconciliationAuditValues(
          [...(changedExternalId ? ["externalId"] : []), ...Object.keys(changes)],
          { externalId: beforeExternalId, ...beforeValues },
          "vorher",
        ),
        after: reconciliationAuditValues(
          [...(changedExternalId ? ["externalId"] : []), ...Object.keys(changes)],
          { externalId: targetExternalId, ...changes },
          "nachher",
        ),
      });
    }));
  }

  async normalizePerson(principal, params) {
    const changes = validateChanges(params.changes);
    const payload = {
      personId: params.personId,
      expectedFingerprint: params.expectedFingerprint,
      changes,
    };
    return this.runIdempotent(principal, "normalizePerson", params.operationId, payload, ({ recoveryOnly }) => this.enqueue("players", async () => {
      this.cancelScheduledRefresh("players");
      const values = await this.readTable("players");
      dataStore.set("players", values, { source: "write-read" });
      let stable;
      try {
        stable = await this.resolveStableRow("players", params.personId, values, "FORMATTED_VALUE");
      } catch (error) {
        if (error.code === "RECORD_NOT_FOUND") throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
        throw error;
      }
      const { header, metadata, row, sheets } = stable;
      const idIndex = headerIndex(header, "id");
      if (!row || String(row[idIndex] || "").trim() !== params.personId) {
        throw new AppError("WRITE_CONFLICT", "Person wurde waehrend der Aktualisierung verschoben", 409);
      }
      const indexes = fieldIndexes(header);
      const beforeValues = rawPersonValues(header, row);
      const currentFingerprint = personFingerprint(beforeValues);
      const targetsMatch = Object.entries(changes).every(([field, value]) => indexes[field] >= 0 && String(row[indexes[field]] ?? "") === value);

      if (recoveryOnly) {
        if (!targetsMatch) {
          if (["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) this.repository.revokeUserSessions(params.personId);
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Personenaenderung ist weiterhin unklar", 503, { personId: params.personId });
        }
        const refreshed = values;
        if (["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) this.repository.revokeUserSessions(params.personId);
        const projected = projectPeopleNormalization(refreshed).people.find((person) => person.id === params.personId);
        return withAudit({ success: true, personId: params.personId, fingerprint: projected?.fingerprint || "", recovered: true }, {
          targetName: [projected?.values.firstName, projected?.values.lastName].map((value) => String(value || "").trim()).filter(Boolean).join(" "),
          before: null,
          after: changes,
        });
      }

      if (currentFingerprint !== params.expectedFingerprint) {
        throw new AppError("PERSON_CONFLICT", "Personendaten wurden zwischenzeitlich geaendert", 409, {
          personId: params.personId,
          currentFingerprint,
        });
      }
      for (const field of Object.keys(changes)) {
        if (indexes[field] < 0) throw new AppError("SHEET_SCHEMA", `Personen-Spalte fuer ${field} fehlt`, 503);
      }
      if (targetsMatch) {
        return withAudit({ success: true, personId: params.personId, fingerprint: currentFingerprint, repeated: true }, {
          targetName: [beforeValues.firstName, beforeValues.lastName].map((value) => String(value || "").trim()).filter(Boolean).join(" "),
          before: Object.fromEntries(Object.keys(changes).map((field) => [field, beforeValues[field]])),
          after: changes,
        });
      }

      const candidate = structuredClone(values);
      const candidateRow = candidate.slice(1).find((entry) => String(entry[idIndex] || "").trim() === params.personId);
      if (!candidateRow) throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
      for (const [field, value] of Object.entries(changes)) candidateRow[indexes[field]] = value;

      const roleIndex = headerIndex(header, "role");
      const activeIndex = headerIndex(header, "aktiv");
      const currentRole = String(row[roleIndex] || "").trim().toLowerCase();
      const targetRole = String(candidateRow[roleIndex] || "").trim().toLowerCase();
      const targetActive = String(candidateRow[activeIndex] || "").trim();
      if (params.personId === principal.id && currentRole === "admin" && (targetRole !== "admin" || targetActive !== "1")) {
        throw new AppError("ADMIN_SELF_PROTECTION", "Die eigene aktive Adminrolle darf nicht entfernt werden", 409);
      }
      const activeAdminCount = candidate.slice(1).filter((entry) => (
        String(entry[roleIndex] || "").trim().toLowerCase() === "admin"
        && String(entry[activeIndex] || "").trim() === "1"
      )).length;
      if (!activeAdminCount) throw new AppError("LAST_ADMIN_PROTECTION", "Mindestens ein aktiver Admin muss erhalten bleiben", 409);

      try {
        validateTableValues("players", candidate);
        assertPlayerLoginConflictsNotWorsened(values, candidate);
      } catch (error) {
        throw error;
      }

      const maxIndex = Math.max(...Object.keys(changes).map((field) => indexes[field]));
      const updates = Array(maxIndex + 1).fill(null);
      for (const [field, value] of Object.entries(changes)) updates[indexes[field]] = value;
      try {
        const response = await sheets.spreadsheets.values.batchUpdateByDataFilter({
          spreadsheetId: SHEET_ID,
          requestBody: {
            valueInputOption: "RAW",
            data: [{
              dataFilter: { developerMetadataLookup: { metadataId: metadata.metadataId } },
              majorDimension: "ROWS",
              values: [updates],
            }],
          },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
        if (Number(response.data.totalUpdatedRows) !== 1) throw new Error("Metadaten-Update hat keine eindeutige Zeile aktualisiert");
      } catch (error) {
        try {
          const confirmationRow = await this.readMetadataRow(sheets, metadata.metadataId, "FORMATTED_VALUE", "confirmation");
          const confirmed = confirmationRow && Object.entries(changes).every(([field, value]) => String(confirmationRow[indexes[field]] ?? "") === value);
          if (!confirmed) throw error;
        } catch {
          if (["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) this.repository.revokeUserSessions(params.personId);
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Personenaenderung ist unklar", 503, { personId: params.personId });
        }
      }

      const refreshed = candidate;
      dataStore.set("players", refreshed, { source: "write-local", authoritative: false });
      this.scheduleRefresh("players");
      if (["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) this.repository.revokeUserSessions(params.personId);
      const projected = projectPeopleNormalization(refreshed).people.find((person) => person.id === params.personId);
      return withAudit({ success: true, personId: params.personId, fingerprint: projected?.fingerprint || "" }, {
        targetName: [projected?.values.firstName, projected?.values.lastName].map((value) => String(value || "").trim()).filter(Boolean).join(" "),
        before: Object.fromEntries(Object.keys(changes).map((field) => [field, beforeValues[field]])),
        after: changes,
      });
    }));
  }

  async setPasswordHash(personId, storedHash, { expectedHash, requirePasswordSetupAllowed = false } = {}) {
    return this.enqueue("players", async () => {
      this.cancelScheduledRefresh("players");
      const values = await this.readTable("players");
      dataStore.set("players", values, { source: "write-read" });
      let stable;
      try {
        stable = await this.resolveStableRow("players", personId, values);
      } catch (error) {
        if (error.code === "RECORD_NOT_FOUND") throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
        throw error;
      }
      const { header, metadata, row, sheets } = stable;
      const passwordIndex = headerIndex(header, "passwdhash");
      const resetIndex = headerIndex(header, "kennwortvergessen");
      const activeIndex = headerIndex(header, "aktiv");
      if (passwordIndex < 0) throw new AppError("SHEET_SCHEMA", "Personen-Spalten fehlen", 500);
      if (requirePasswordSetupAllowed && (
        resetIndex < 0
        || activeIndex < 0
        || String(row[resetIndex] || "").trim().toLowerCase() !== "x"
        || String(row[activeIndex] || "").trim() !== "1"
      )) {
        throw new AppError("PASSWORD_SETUP_INVALID", "Passwortvergabe ist nicht freigegeben", 401);
      }
      if (String(row[passwordIndex] || "").trim() === storedHash) {
        return { success: true, recovered: true };
      }
      if (expectedHash !== undefined && String(row[passwordIndex] || "").trim() !== expectedHash) {
        throw new AppError("PASSWORD_CONFLICT", "Passwort wurde zwischenzeitlich geaendert", 409);
      }
      const updates = Array(Math.max(passwordIndex, resetIndex) + 1).fill(null);
      updates[passwordIndex] = storedHash;
      if (resetIndex >= 0) updates[resetIndex] = "";
      try {
        const response = await sheets.spreadsheets.values.batchUpdateByDataFilter({
          spreadsheetId: SHEET_ID,
          requestBody: {
            valueInputOption: "RAW",
            data: [{
              dataFilter: { developerMetadataLookup: { metadataId: metadata.metadataId } },
              majorDimension: "ROWS",
              values: [updates],
            }],
          },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
        if (Number(response.data.totalUpdatedRows) !== 1) throw new Error("Metadaten-Update hat keine eindeutige Zeile aktualisiert");
      } catch (error) {
        try {
          const confirmationRow = await this.readMetadataRow(sheets, metadata.metadataId, "FORMULA", "confirmation");
          if (confirmationRow && String(confirmationRow[passwordIndex] || "").trim() === storedHash) {
            const candidate = structuredClone(values);
            const candidateRow = candidate.slice(1).find((entry) => String(entry[headerIndex(headerOf(candidate), "id")] || "").trim() === personId);
            if (candidateRow) {
              candidateRow[passwordIndex] = storedHash;
              if (resetIndex >= 0) candidateRow[resetIndex] = "";
            }
            dataStore.set("players", candidate, { source: "write-local", authoritative: false });
            this.scheduleRefresh("players");
            return { success: true, recovered: true };
          }
        } catch (confirmationError) {
          logger.log("error", "sheet_password_confirmation_read_failed", { error: confirmationError });
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Passwortaenderung ist unklar", 503, { personId });
      }
      const candidate = structuredClone(values);
      const candidateRow = candidate.slice(1).find((entry) => String(entry[headerIndex(headerOf(candidate), "id")] || "").trim() === personId);
      if (candidateRow) {
        candidateRow[passwordIndex] = storedHash;
        if (resetIndex >= 0) candidateRow[resetIndex] = "";
      }
      dataStore.set("players", candidate, { source: "write-local", authoritative: false });
      this.scheduleRefresh("players");
      return { success: true };
    });
  }

  async setPasswordSetupAllowed(personId, allowed) {
    return this.enqueue("players", async () => {
      this.cancelScheduledRefresh("players");
      const values = await this.readTable("players");
      dataStore.set("players", values, { source: "write-read" });
      let stable;
      try {
        stable = await this.resolveStableRow("players", personId, values);
      } catch (error) {
        if (error.code === "RECORD_NOT_FOUND") throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
        throw error;
      }
      const { header, metadata, row, sheets } = stable;
      const setupIndex = headerIndex(header, "kennwortvergessen");
      if (setupIndex < 0) throw new AppError("SHEET_SCHEMA", "Personen-Spalte KennwortVergessen fehlt", 500);
      const marker = allowed ? "x" : "";
      if (String(row[setupIndex] || "").trim().toLowerCase() === marker) return { success: true, repeated: true };
      const updates = Array(setupIndex + 1).fill(null);
      updates[setupIndex] = marker;
      try {
        const response = await sheets.spreadsheets.values.batchUpdateByDataFilter({
          spreadsheetId: SHEET_ID,
          requestBody: {
            valueInputOption: "RAW",
            data: [{
              dataFilter: { developerMetadataLookup: { metadataId: metadata.metadataId } },
              majorDimension: "ROWS",
              values: [updates],
            }],
          },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
        if (Number(response.data.totalUpdatedRows) !== 1) throw new Error("Metadaten-Update hat keine eindeutige Zeile aktualisiert");
      } catch (error) {
        try {
          const confirmationRow = await this.readMetadataRow(sheets, metadata.metadataId, "FORMULA", "confirmation");
          if (!confirmationRow || String(confirmationRow[setupIndex] || "").trim().toLowerCase() !== marker) throw error;
        } catch {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Passwortfreigabe ist unklar", 503, { personId });
        }
      }
      const candidate = structuredClone(values);
      const candidateRow = candidate.slice(1).find((entry) => String(entry[headerIndex(headerOf(candidate), "id")] || "").trim() === personId);
      if (candidateRow) candidateRow[setupIndex] = marker;
      dataStore.set("players", candidate, { source: "write-local", authoritative: false });
      this.scheduleRefresh("players");
      return { success: true };
    });
  }

  async addMatch(principal, params) {
    const payload = { bewerbId: params.bewerbId, opponentId: params.opponentId };
    return this.runIdempotent(principal, "addMatch", params.operationId, payload, ({ recoveryOnly }) => this.enqueue(`ranking:${params.bewerbId}`, () => this.enqueue("matches1", async () => {
      if (params.opponentId === principal.id) throw new AppError("MATCH_SELF", "Ein Spieler kann sich nicht selbst fordern");
      this.cancelScheduledRefresh("matches1");
      const values = await this.readTable("matches1");
      dataStore.set("matches1", values, { source: "write-read" });
      const header = headerOf(values);
      const idIndex = headerIndex(header, "id");
      const newId = stableRecordId("m", principal, params.operationId);
      const existingRow = values.slice(1).find((row) => String(row[idIndex] || "").trim() === newId);
      if (existingRow) {
        dataStore.set("matches1", values, { source: "write" });
        await this.ensureChallengeMessage(principal, params, newId, existingRow, header);
        return { success: true, newMatchId: newId, recovered: true };
      }
      if (recoveryOnly) {
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Match-Erstellung ist noch nicht nachweisbar", 503, { operationId: params.operationId, recordId: newId });
      }
      this.assertChallengeAllowed(principal, params.bewerbId, params.opponentId, values);
      const newRow = rowForHeader(header, {
        id: newId,
        forderungdate: viennaTimestamp(),
        bewerbid: params.bewerbId,
        spieler1id: principal.id,
        spieler3id: params.opponentId,
      });
      const sheets = await this.getClient();
      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: TABLE_CONFIG.matches1.range,
          valueInputOption: "RAW",
          requestBody: { values: [newRow] },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
      } catch (error) {
        let confirmation = null;
        try {
          confirmation = await this.readTable("matches1", "confirmation");
        } catch (confirmationError) {
          logger.log("error", "sheet_match_confirmation_read_failed", { recordId: newId, error: confirmationError });
        }
        const confirmedRow = confirmation?.slice(1).find((row) => String(row[idIndex] || "").trim() === newId);
        if (confirmedRow) {
          dataStore.set("matches1", confirmation, { source: "write" });
          await this.ensureChallengeMessage(principal, params, newId, confirmedRow, headerOf(confirmation));
          return { success: true, newMatchId: newId, recovered: true };
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Match-Erstellung ist unklar", 503, { operationId: params.operationId, recordId: newId });
      }
      const candidate = structuredClone(values);
      candidate.push(newRow);
      dataStore.set("matches1", candidate, { source: "write-local", authoritative: false });
      this.scheduleRefresh("matches1");
      await this.ensureChallengeMessage(principal, params, newId, newRow, header);
      return { success: true, newMatchId: newId };
    })));
  }

  async setRankingMatchDate(principal, params) {
    const payload = { matchId: params.matchId, matchDate: params.matchDate };
    return this.runIdempotent(principal, "setRankingMatchDate", params.operationId, payload, ({ recoveryOnly, recoveryDetails, checkpointUnknown }) => this.enqueue("matches1", async () => {
      requireCurrentData("bewerbe", "players");
      this.cancelScheduledRefresh("matches1");
      const values = await this.readTable("matches1");
      dataStore.set("matches1", values, { source: "write-read" });
      let stable;
      try {
        stable = await this.resolveStableRow("matches1", params.matchId, values, "FORMATTED_VALUE");
      } catch (error) {
        if (error.code === "RECORD_NOT_FOUND") throw new AppError("MATCH_NOT_FOUND", "Forderung wurde nicht gefunden", 404);
        throw error;
      }
      const { sheets, metadata, row, header } = stable;
      const indexes = {
        ignore: headerIndex(header, "ignore"),
        date: headerIndex(header, "matchdate"),
        challengedAt: headerIndex(header, "forderungdate"),
        competition: headerIndex(header, "bewerbid"),
        challenger: headerIndex(header, "spieler1id"),
        opponent: headerIndex(header, "spieler3id"),
        result: headerIndex(header, "ergebnis"),
      };
      if ([indexes.date, indexes.challengedAt, indexes.competition, indexes.challenger, indexes.opponent, indexes.result].some((index) => index < 0)) {
        throw new AppError("SHEET_SCHEMA", "Matches1-Spalten fuer Spieltermine fehlen", 503);
      }
      const competitionId = String(row[indexes.competition] || "").trim();
      const competition = this.competition(competitionId);
      const competitionTypeIndex = headerIndex(competition.header, "bewerbsartid");
      if (competitionTypeIndex < 0) throw new AppError("SHEET_SCHEMA", "Bewerbsart-Spalte fehlt", 503);
      if (String(competition.row[competitionTypeIndex] || "").trim() !== "2") {
        throw new AppError("RANKING_MATCH_REQUIRED", "Spieltermine koennen hier nur fuer Ranglistenforderungen festgelegt werden", 409);
      }
      const challenger = parseParticipant(row[indexes.challenger]);
      const opponent = parseParticipant(row[indexes.opponent]);
      if (![challenger.id, opponent.id].includes(principal.id)) {
        throw new AppError("MATCH_PARTICIPANT_REQUIRED", "Nur die Beteiligten duerfen den Spieltermin festlegen", 403);
      }
      if ((indexes.ignore >= 0 && String(row[indexes.ignore] || "").trim() === "1")
        || !String(row[indexes.challengedAt] || "").trim()
        || String(row[indexes.result] || "").trim()
        || challenger.retired
        || opponent.retired) {
        throw new AppError("RANKING_CHALLENGE_CLOSED", "Die Forderung ist nicht mehr offen", 409);
      }
      const appointment = parseMatchDate(params.matchDate);
      const challengedAt = parseMatchDate(row[indexes.challengedAt]);
      if (!appointment) throw new AppError("MATCH_DATE_INVALID", "Spieltermin ist ungueltig", 400);
      if (!challengedAt) throw new AppError("MATCH_DATA_INVALID", "Forderungszeitpunkt ist ungueltig", 503);
      const currentDate = String(row[indexes.date] || "").trim();
      const previousDate = recoveryOnly ? String(recoveryDetails?.previousDate || "") : currentDate;
      if (appointment.getMinutes() !== 0 || appointment.getHours() < 6 || appointment.getHours() > 23) {
        throw new AppError("MATCH_DATE_TIME_INVALID", "Spieltermine sind nur zur vollen Stunde zwischen 06:00 und 23:00 Uhr moeglich", 409);
      }
      const now = this.now();
      if (previousDate) {
        if (appointment.getTime() < now) throw new AppError("MATCH_DATE_PAST", "Ein geaenderter Spieltermin muss in der Zukunft liegen", 409);
      } else {
        const deadline = challengedAt.getTime() + 14 * 24 * 60 * 60 * 1000;
        if (appointment.getTime() < challengedAt.getTime() || appointment.getTime() > deadline) {
          throw new AppError("MATCH_DATE_AFTER_DEADLINE", "Der erste Spieltermin muss im vierzehntaegigen Zeitkorridor ab der Forderung liegen", 409);
        }
      }
      if (recoveryOnly) {
        if (currentDate !== params.matchDate) {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Spieltermin ist noch nicht nachweisbar", 503, { operationId: params.operationId, matchId: params.matchId, matchDate: params.matchDate, previousDate });
        }
        await this.ensureRankingMatchDateEvent(principal, params, row, header, previousDate);
        logger.log("info", "ranking_match_date_update_completed", { matchId: params.matchId, competitionId, actorId: principal.id, matchDate: params.matchDate, recovered: true });
        return withAudit({ success: true, matchId: params.matchId, matchDate: params.matchDate, recovered: true }, {
          before: { matchId: params.matchId, matchDate: previousDate },
          after: { matchId: params.matchId, matchDate: params.matchDate },
        });
      }
      if (currentDate === params.matchDate) throw new AppError("MATCH_DATE_UNCHANGED", "Der ausgewaehlte Spieltermin ist bereits eingetragen", 409);
      checkpointUnknown({ phase: "match-date-write", matchId: params.matchId, matchDate: params.matchDate, previousDate });
      const updates = Array(indexes.date + 1).fill(null);
      updates[indexes.date] = params.matchDate;
      let recovered = false;
      try {
        const response = await sheets.spreadsheets.values.batchUpdateByDataFilter({
          spreadsheetId: SHEET_ID,
          requestBody: {
            valueInputOption: "RAW",
            data: [{ dataFilter: { developerMetadataLookup: { metadataId: metadata.metadataId } }, majorDimension: "ROWS", values: [updates] }],
          },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
        if (Number(response.data.totalUpdatedRows) !== 1) throw new Error("Metadaten-Update hat keine eindeutige Zeile aktualisiert");
      } catch (error) {
        const confirmationRow = await this.readMetadataRow(sheets, metadata.metadataId, "FORMATTED_VALUE", "confirmation").catch(() => null);
        if (!confirmationRow || String(confirmationRow[indexes.date] || "").trim() !== params.matchDate) {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Spielterminsetzung ist unklar", 503, { operationId: params.operationId, matchId: params.matchId, matchDate: params.matchDate, previousDate });
        }
        recovered = true;
      }
      const candidate = structuredClone(values);
      const candidateRow = candidate.slice(1).find((entry) => String(entry[headerIndex(headerOf(candidate), "id")] || "").trim() === params.matchId);
      if (candidateRow) candidateRow[indexes.date] = params.matchDate;
      dataStore.set("matches1", candidate, { source: "write-local", authoritative: false });
      this.scheduleRefresh("matches1");
      const eventRow = [...row];
      eventRow[indexes.date] = params.matchDate;
      const eventContext = await this.ensureRankingMatchDateEvent(principal, params, eventRow, header, previousDate);
      logger.log("info", "ranking_match_date_update_completed", { matchId: params.matchId, competitionId: eventContext.competitionId, actorId: principal.id, matchDate: params.matchDate, recovered });
      return withAudit({ success: true, matchId: params.matchId, matchDate: params.matchDate, ...(recovered ? { recovered: true } : {}) }, {
        before: { matchId: params.matchId, matchDate: previousDate },
        after: { matchId: params.matchId, matchDate: params.matchDate },
      });
    }));
  }

  matchResultCompetition(matchRow, matchHeader) {
    const competitionId = String(matchRow[headerIndex(matchHeader, "bewerbid")] || "").trim();
    const competition = this.competition(competitionId);
    const typeId = String(competition.row[headerIndex(competition.header, "bewerbsartid")] || "").trim();
    const types = dataStore.get("bewerbsart");
    const typeHeader = headerOf(types);
    const typeRow = types.slice(1).find((row) => String(row[headerIndex(typeHeader, "id")] || "").trim() === typeId) || [];
    const roundRobinIndex = headerIndex(typeHeader, "roundrobin");
    return {
      competitionId,
      competition,
      typeId,
      typeHeader,
      typeRow,
      ranking: typeId === "2",
      roundRobin: typeRow.length && roundRobinIndex >= 0
        ? String(typeRow[roundRobinIndex] || "").trim() === "1"
        : null,
      rasterfunktion: String(typeRow[headerIndex(typeHeader, "rasterfunktion")] || "").trim(),
    };
  }

  matchResultRules(matchRow, matchHeader, competition) {
    try {
      const types = parseMatchTypeTable(dataStore.get("matchtyp"));
      return resolveMatchType(rowObject(matchHeader, matchRow), rowObject(competition.header, competition.row), types).rules;
    } catch (error) {
      throw appResultRuleError(error);
    }
  }

  assertResultActor(principal, state) {
    if (principal.role === "admin") return;
    if (!["player", "player a", "player b"].includes(String(principal.role || "").toLowerCase())
      || !state.participants.some(({ id }) => id === String(principal.id))) {
      throw new AppError("MATCH_PARTICIPANT_REQUIRED", "Nur Matchbeteiligte duerfen Ergebnisse eintragen", 403);
    }
  }

  assertResultParticipants(state) {
    const participants = state.participants;
    if (!participants[0]?.id || !participants[2]?.id) {
      throw new AppError("MATCH_PARTICIPANTS_INVALID", "Beide Matchseiten benoetigen einen Hauptspieler", 409);
    }
    if (Boolean(participants[1]?.id) !== Boolean(participants[3]?.id)) {
      throw new AppError("MATCH_PARTICIPANTS_INVALID", "Doppelpartner muessen auf beiden Seiten vorhanden sein", 409);
    }
    const players = dataStore.get("players");
    const playerHeader = headerOf(players);
    const idIndex = headerIndex(playerHeader, "id");
    const knownIds = new Set(players.slice(1).map((row) => String(row[idIndex] || "").trim()).filter(Boolean));
    const ids = participants.map(({ id }) => id).filter(Boolean);
    if (ids.some((id) => !/^[A-Za-z0-9_.:-]{1,64}$/.test(id) || /^(?:PRE|BYE)$/i.test(id) || !knownIds.has(id))) {
      throw new AppError("MATCH_PARTICIPANTS_INVALID", "Match enthaelt unbekannte oder ungueltige Teilnehmer", 409);
    }
    if (new Set(ids).size !== ids.length) {
      throw new AppError("MATCH_PARTICIPANTS_INVALID", "Jede Person darf nur einmal im Match vorkommen", 409);
    }
    const marked = participants.map(({ marker }, index) => ({ marker, index })).filter(({ marker }) => marker);
    if (marked.length > 1 || marked.some(({ index }) => index !== 0 && index !== 2)
      || (!state.closed && marked.length) || (marked[0]?.marker === "wo" && Boolean(state.result))) {
      throw new AppError("MATCH_PARTICIPANTS_INVALID", "Abschlussmarker des Matches sind nicht eindeutig", 409);
    }
  }

  resultRankingTargets(values, competitionId, state, winnerSide, matchId) {
    const header = headerOf(values);
    const indexes = {
      competition: headerIndex(header, "bewerbid"),
      person: headerIndex(header, "personid"),
      rank: headerIndex(header, "rang"),
    };
    const challengerId = state.participants[0].id;
    const defenderId = state.participants[2].id;
    const memberships = values.slice(1).filter((row) => String(row[indexes.competition] || "").trim() === competitionId);
    const challenger = memberships.find((row) => String(row[indexes.person] || "").trim() === challengerId);
    const defender = memberships.find((row) => String(row[indexes.person] || "").trim() === defenderId);
    if (!defender || Number(defender[indexes.rank]) <= 0) throw new AppError("RANKING_REPAIR_REQUIRED", "Ranglistenstand muss administrativ repariert werden", 409);
    const defenderRank = Number(defender[indexes.rank]);
    const active = memberships.filter((row) => Number(row[indexes.rank]) > 0);
    if (!Number.isInteger(defenderRank) || defenderRank < 1) {
      throw new AppError("RANKING_REPAIR_REQUIRED", "Ranglistenstand muss administrativ repariert werden", 409);
    }
    if (!challenger) {
      const ranksBehind = active.filter((row) => Number(row[indexes.rank]) > defenderRank).length;
      if (winnerSide !== 1 && ranksBehind >= 10) return [];
      const afterRank = winnerSide === 1
        ? defenderRank
        : Math.max(...active.map((row) => Number(row[indexes.rank]))) + 1;
      const targets = winnerSide === 1 ? active.flatMap((row) => {
        const rank = Number(row[indexes.rank]);
        return rank >= defenderRank
          ? [{ personId: String(row[indexes.person] || "").trim(), beforeRank: rank, afterRank: rank + 1 }]
          : [];
      }) : [];
      return [...targets, { personId: challengerId, beforeRank: null, afterRank, inserted: true, recordId: resultMembershipId(matchId, competitionId, challengerId) }];
    }
    const challengerRank = Number(challenger[indexes.rank]);
    if (!Number.isInteger(challengerRank) || challengerRank < 0) {
      throw new AppError("RANKING_REPAIR_REQUIRED", "Ranglistenstand muss administrativ repariert werden", 409);
    }
    if (challengerRank === 0) {
      const withdrawnAtIndex = headerIndex(header, "rausgehangenam");
      const previousRankIndex = headerIndex(header, "rausgehangenletzteplatzierung");
      const withdrawnAt = parseMatchDate(challenger[withdrawnAtIndex]);
      const previousRank = Number(challenger[previousRankIndex]);
      if (!withdrawnAt || !Number.isInteger(previousRank) || previousRank < 1) {
        throw new AppError("RANKING_RETURN_INVALID", "Rueckkehranspruch ist ungueltig", 409);
      }
      const expiresAt = new Date(withdrawnAt);
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      if (new Date(this.now()) > expiresAt) {
        const ranksBehind = active.filter((row) => Number(row[indexes.rank]) > defenderRank).length;
        if (winnerSide !== 1 && ranksBehind >= 10) return [];
        const afterRank = winnerSide === 1
          ? defenderRank
          : Math.max(...active.map((row) => Number(row[indexes.rank]))) + 1;
        const targets = winnerSide === 1 ? active.flatMap((row) => {
          const rank = Number(row[indexes.rank]);
          return rank >= defenderRank
            ? [{ personId: String(row[indexes.person] || "").trim(), beforeRank: rank, afterRank: rank + 1 }]
            : [];
        }) : [];
        return [...targets, { personId: challengerId, beforeRank: 0, afterRank }];
      }
      const insertionRank = winnerSide === 1 ? defenderRank : defenderRank + 1;
      return memberships.flatMap((row) => {
        const personId = String(row[indexes.person] || "").trim();
        const rank = Number(row[indexes.rank]);
        if (personId === challengerId) return [{ personId, beforeRank: 0, afterRank: insertionRank }];
        return rank >= insertionRank
          ? [{ personId, beforeRank: rank, afterRank: rank + 1 }]
          : [];
      });
    }
    if (winnerSide !== 1) return [];
    if (challengerRank > 0 && challengerRank <= defenderRank) return [];
    return memberships.flatMap((row) => {
      const personId = String(row[indexes.person] || "").trim();
      const rank = Number(row[indexes.rank]);
      if (personId === challengerId) return [{ personId, beforeRank: challengerRank, afterRank: defenderRank }];
      if (rank >= defenderRank && (challengerRank === 0 || rank < challengerRank)) {
        return [{ personId, beforeRank: rank, afterRank: rank + 1 }];
      }
      return [];
    });
  }

  customRankingTargets(values, competitionId, rankPlan) {
    const header = headerOf(values);
    const competitionIndex = headerIndex(header, "bewerbid");
    const personIndex = headerIndex(header, "personid");
    const rankIndex = headerIndex(header, "rang");
    const rows = values.slice(1).filter((row) => String(row[competitionIndex] || "").trim() === competitionId);
    const byPerson = new Map(rankPlan.map((entry) => [entry.personId, entry]));
    if (byPerson.size !== rankPlan.length || rows.length !== rankPlan.length
      || rows.some((row) => !byPerson.has(String(row[personIndex] || "").trim()))) {
      throw new AppError("RANK_PLAN_INCOMPLETE", "Rangplan muss alle Ranglistenmitglieder eindeutig enthalten", 409);
    }
    const targets = rows.map((row) => {
      const personId = String(row[personIndex] || "").trim();
      const currentRank = Number(row[rankIndex]);
      const entry = byPerson.get(personId);
      if (currentRank > 0 && entry.newRank === 0) {
        throw new AppError("RANK_PLAN_INVALID", "Aktive Ranglistenmitglieder koennen ohne Raushaengedaten nicht auf Rang 0 gesetzt werden", 409);
      }
      if (currentRank !== entry.expectedRank) throw new AppError("RANK_CONFLICT", "Rang wurde zwischenzeitlich geaendert", 409);
      return { personId, beforeRank: currentRank, afterRank: entry.newRank };
    });
    const ranks = targets.map(({ afterRank }) => afterRank);
    const positiveRanks = ranks.filter((rank) => rank > 0);
    if (new Set(positiveRanks).size !== positiveRanks.length || ranks.some((rank) => !Number.isInteger(rank) || rank < 0)) {
      throw new AppError("RANK_PLAN_INVALID", "Positive Zielraenge muessen eindeutig sein; Rang 0 darf mehrfach vorkommen", 409);
    }
    return targets;
  }

  async resultPlan(principal, params, values, rankingValues, options) {
    const header = headerOf(values);
    const idIndex = headerIndex(header, "id");
    const row = values.slice(1).find((entry) => String(entry[idIndex] || "").trim() === params.matchId);
    if (!row) throw new AppError("MATCH_NOT_FOUND", "Match wurde nicht gefunden", 404);
    const state = completionState(row, header);
    this.assertResultParticipants(state);
    const adminReason = options.admin ? String(params.reason || "").trim() : "";
    if (options.admin && (adminReason.length < 1 || adminReason.length > 500)) {
      throw new AppError("ADMIN_REASON_REQUIRED", "Administrativer Grund muss 1 bis 500 Zeichen lang sein", 400);
    }
    const currentFingerprint = matchCompletionFingerprint(row, header);
    if (currentFingerprint !== params.expectedFingerprint) {
      throw new AppError("RESULT_CONFLICT", "Matchergebnis wurde zwischenzeitlich geaendert", 409, { currentFingerprint });
    }
    const context = this.matchResultCompetition(row, header);
    if (options.rankPlan && !context.ranking) throw new AppError("RANKING_MATCH_REQUIRED", "Administrativer Rangplan ist nur fuer Ranglistenmatches erlaubt", 409);
    const matchDateIndex = headerIndex(header, "matchdate");
    const matchEndIndex = headerIndex(header, "matchende");
    if (matchDateIndex < 0 || matchEndIndex < 0) throw new AppError("SHEET_SCHEMA", "Matches1-Spalten MatchDate oder MatchEnde fehlen", 503);
    const participantIds = [...new Set(state.participants.map(({ id }) => id).filter(Boolean))];
    let changeType;
    let completionType = state.kind;
    let targetRow = [...row];
    let winnerSide = completionWinnerSide(state);
    const previousWinnerSide = winnerSide;
    let rankingTargets = [];
    let rankingProvenanceBefore = null;
    let rankingProvenanceAfter = null;
    let rankingProvenanceReplace = false;
    let koTarget = null;
    let koTargetStatus = "";
    let koExpectedRoundCode = "";

    if (options.action === "matchEnd") {
      if (!state.closed || !state.matchEnd || !winnerSide) throw new AppError("MATCH_RESULT_OPEN", "Match ist noch nicht abgeschlossen", 409);
      assertMatchEnd(row[matchDateIndex], params.matchEnd, this.now());
      targetRow[matchEndIndex] = params.matchEnd;
      changeType = "match_end_corrected";
    } else if (options.action === "clear") {
      if (!state.closed || !winnerSide) throw new AppError("MATCH_RESULT_OPEN", "Match ist noch nicht abgeschlossen", 409);
      targetRow[headerIndex(header, "ergebnis")] = "";
      targetRow[matchEndIndex] = "";
      for (const field of ["spieler1id", "spieler2id", "spieler3id", "spieler4id"]) {
        const index = headerIndex(header, field);
        if (index >= 0) targetRow[index] = String(targetRow[index] || "").replace(/\s+\[(?:wo|ret)\]$/, "").trim();
      }
      changeType = "result_cleared";
    } else {
      this.assertResultActor(principal, state);
      const rules = this.matchResultRules(row, header, context.competition);
      let validated;
      try {
        validated = validateCompletion({ kind: params.kind, result: params.result || "", losingSide: params.losingSide }, rules);
      } catch (error) {
        throw appResultRuleError(error);
      }
      if (!validated.valid) throw new AppError(validated.error, "Matchergebnis ist ungueltig", 409);
      const suppliedEnd = params.matchEnd || "";
      if (!state.closed && !suppliedEnd) throw new AppError("MATCH_END_REQUIRED", "Beim ersten Abschluss ist MatchEnde erforderlich", 409);
      if (state.closed && suppliedEnd && suppliedEnd !== state.matchEnd) {
        throw new AppError("MATCH_END_CHANGE_FORBIDDEN", principal.role === "admin"
          ? "Matchende muss ueber die administrative Zeitkorrektur geaendert werden"
          : "Beteiligte duerfen MatchEnde bei Korrekturen nicht aendern", principal.role === "admin" ? 409 : 403);
      }
      const targetEnd = state.closed ? state.matchEnd : suppliedEnd;
      assertMatchEnd(row[matchDateIndex], targetEnd, this.now());
      let encoded;
      try {
        encoded = encodeCompletion({
          Ergebnis: row[headerIndex(header, "ergebnis")] || "",
          Spieler1ID: row[headerIndex(header, "spieler1id")] || "",
          Spieler2ID: headerIndex(header, "spieler2id") < 0 ? "" : row[headerIndex(header, "spieler2id")] || "",
          Spieler3ID: row[headerIndex(header, "spieler3id")] || "",
          Spieler4ID: headerIndex(header, "spieler4id") < 0 ? "" : row[headerIndex(header, "spieler4id")] || "",
        }, validated);
      } catch (error) {
        throw appResultRuleError(error);
      }
      for (const field of ["Ergebnis", "Spieler1ID", "Spieler2ID", "Spieler3ID", "Spieler4ID"]) {
        const index = headerIndex(header, field);
        if (index >= 0 && Object.hasOwn(encoded, field)) targetRow[index] = encoded[field];
      }
      targetRow[matchEndIndex] = targetEnd;
      winnerSide = validated.winnerSide;
      completionType = validated.kind;
      changeType = state.closed ? "result_corrected" : "result";
      if (context.ranking) {
        if (options.rankPlan) {
          rankingTargets = this.customRankingTargets(rankingValues, context.competitionId, options.rankPlan);
          const provenance = this.repository.getState(`match-result-ranking:${params.matchId}`, null).value;
          if (provenance) {
            const originalByPerson = new Map(provenance.before.map((entry) => [entry.personId, entry]));
            rankingProvenanceBefore = [
              ...provenance.before,
              ...rankingTargets.filter(({ personId }) => !originalByPerson.has(personId)).map(({ personId, beforeRank, inserted }) => ({
                personId,
                beforeRank,
                ...(inserted ? { inserted: true } : {}),
              })),
            ];
            const insertedIds = new Set(rankingProvenanceBefore.filter(({ inserted }) => inserted).map(({ personId }) => personId));
            rankingProvenanceAfter = rankingTargets.map(({ personId, afterRank }) => ({
              personId,
              afterRank,
              ...(insertedIds.has(personId) ? { inserted: true } : {}),
            }));
            rankingProvenanceReplace = true;
          }
        }
        else {
          const provenance = this.repository.getState(`match-result-ranking:${params.matchId}`, null).value;
          if (state.closed && provenance) {
            rankingProvenanceBefore = provenance.before;
            const rankMap = new Map(provenance.after.map((entry) => [entry.personId, entry.afterRank]));
            const rankingHeader = headerOf(rankingValues);
            const competitionIndex = headerIndex(rankingHeader, "bewerbid");
            const personIndex = headerIndex(rankingHeader, "personid");
            const rankIndex = headerIndex(rankingHeader, "rang");
            const current = rankingValues.slice(1).filter((entry) => String(entry[competitionIndex] || "").trim() === context.competitionId);
            if (provenance.after.some((entry) => Number(current.find((row) => String(row[personIndex] || "").trim() === entry.personId)?.[rankIndex]) !== rankMap.get(entry.personId))) {
              throw new AppError("RANKING_REPAIR_REQUIRED", "Ranglistenstand wurde nach dem Ergebnis veraendert", 409);
            }
            for (const entry of provenance.after.filter((candidate) => candidate.inserted)) {
              const currentRow = current.find((candidate) => String(candidate[personIndex] || "").trim() === entry.personId);
              const rankingIdIndex = headerIndex(rankingHeader, "id");
              if (!currentRow || String(currentRow[rankingIdIndex] || "").trim() !== resultMembershipId(params.matchId, context.competitionId, entry.personId)) {
                throw new AppError("RANKING_REPAIR_REQUIRED", "Eingefuegte Ranglistenmitgliedschaft wurde nach dem Ergebnis veraendert", 409);
              }
            }
            const virtual = structuredClone(rankingValues);
            const virtualRows = virtual.slice(1).filter((entry) => String(entry[competitionIndex] || "").trim() === context.competitionId);
            for (const entry of provenance.before) {
              const rowToRestore = virtualRows.find((candidate) => String(candidate[personIndex] || "").trim() === entry.personId);
              if (entry.inserted && rowToRestore) rowToRestore.fill("");
              else if (rowToRestore) rowToRestore[rankIndex] = entry.beforeRank;
            }
            const nextTargets = this.resultRankingTargets(virtual, context.competitionId, state, winnerSide, params.matchId);
            rankingProvenanceReplace = true;
            const originalByPerson = new Map(provenance.before.map((entry) => [entry.personId, entry]));
            rankingProvenanceBefore = [
              ...provenance.before,
              ...nextTargets.filter(({ personId }) => !originalByPerson.has(personId)).map(({ personId, beforeRank, inserted }) => ({
                personId,
                beforeRank,
                ...(inserted ? { inserted: true } : {}),
              })),
            ];
            rankingProvenanceAfter = nextTargets.map(({ personId, afterRank, inserted }) => ({ personId, afterRank, ...(inserted ? { inserted: true } : {}) }));
            for (const target of nextTargets) {
              let targetRow = virtualRows.find((candidate) => String(candidate[personIndex] || "").trim() === target.personId);
              if (!targetRow && target.inserted) {
                targetRow = rowForHeader(rankingHeader, { ID: target.recordId, BewerbID: context.competitionId, PersonID: target.personId, Rang: target.afterRank });
                const empty = virtual.slice(1).findIndex((candidate) => !candidate.some((value) => String(value || "").trim()));
                if (empty >= 0) virtual[empty + 1].splice(0, virtual[empty + 1].length, ...targetRow);
                else {
                  virtual.push(targetRow);
                  virtualRows.push(targetRow);
                }
              } else if (targetRow) targetRow[rankIndex] = target.afterRank;
            }
            const affected = new Set([...provenance.after.map((entry) => entry.personId), ...nextTargets.map((entry) => entry.personId)]);
            rankingTargets = [...affected].flatMap((personId) => {
              const actual = current.find((candidate) => String(candidate[personIndex] || "").trim() === personId);
              const desired = virtualRows.find((candidate) => String(candidate[personIndex] || "").trim() === personId);
              const previous = provenance.before.find((entry) => entry.personId === personId);
              const next = nextTargets.find((entry) => entry.personId === personId);
              if (actual && !desired) return [{ personId, beforeRank: Number(actual[rankIndex]), afterRank: null, removed: true, inserted: Boolean(previous?.inserted) }];
              if (!actual && desired) return [{ personId, beforeRank: null, afterRank: Number(desired[rankIndex]), inserted: true, recordId: next?.recordId }];
              return actual && desired && Number(actual[rankIndex]) !== Number(desired[rankIndex])
                ? [{ personId, beforeRank: Number(actual[rankIndex]), afterRank: Number(desired[rankIndex]), inserted: Boolean(previous?.inserted) }]
                : [];
            });
          } else if (state.closed && previousWinnerSide === 1) {
            throw new AppError("RANKING_REPAIR_REQUIRED", "Provenienz der Rangverschiebung fehlt", 409);
          } else {
            rankingTargets = this.resultRankingTargets(rankingValues, context.competitionId, state, winnerSide, params.matchId);
          }
        }
      }
    }

    const raster = Number(context.rasterfunktion);
    if (!context.ranking && context.roundRobin === false && Number.isInteger(raster) && raster > 0 && (raster & (raster - 1)) === 0) {
      let successor;
      try { successor = koRoundSuccessor(row[headerIndex(header, "bewerbrunde")], raster); } catch (error) { throw appResultRuleError(error); }
      if (successor) {
        koExpectedRoundCode = successor.roundCode;
        const roundIndex = headerIndex(header, "bewerbrunde");
        const successorRows = values.slice(1).filter((entry) => (
          String(entry[headerIndex(header, "bewerbid")] || "").trim() === context.competitionId
          && String(entry[roundIndex] || "").trim().toUpperCase() === successor.roundCode
        ));
        if (successorRows.length > 1) throw new AppError("KO_TARGET_AMBIGUOUS", "KO-Nachfolgematch ist nicht eindeutig", 409);
        if (successorRows.length === 0) koTargetStatus = options.action === "clear" ? "" : "missing";
        else {
          const [successorRow] = successorRows;
          const successorState = completionState(successorRow, header);
          if (successorState.closed) throw new AppError("RESULT_CORRECTION_DEPENDENCY_CONFLICT", "Abhaengiges KO-Match ist bereits abgeschlossen", 409);
          const oldWinner = completionWinnerSide(state);
          const oldIds = oldWinner ? (oldWinner === 1 ? state.participants.slice(0, 2) : state.participants.slice(2, 4)).map(({ id }) => id).filter(Boolean) : [];
          const winningParticipants = winnerSide === 1 ? state.participants.slice(0, 2) : state.participants.slice(2, 4);
          if (options.action !== "clear" && (!winningParticipants[0]?.id || winningParticipants.some(({ id, marker }) => id && (marker || id === "PRE")))) {
            throw new AppError("KO_WINNER_INVALID", "KO-Gewinnerseite enthaelt keine sauberen Personen-IDs", 409);
          }
          const newIds = options.action === "clear" ? [] : winningParticipants.map(({ id }) => id).filter(Boolean);
          const slotNames = successor.side === 1 ? ["spieler1id", "spieler2id"] : ["spieler3id", "spieler4id"];
          const successorTarget = [...successorRow];
          const existing = slotNames.map((name) => String(successorRow[headerIndex(header, name)] || "").trim()).filter(Boolean);
          if (state.closed && existing.join("\0") !== oldIds.join("\0")) {
            throw new AppError("RESULT_CORRECTION_DEPENDENCY_CONFLICT", "KO-Nachfolger wurde zwischenzeitlich veraendert", 409);
          }
          if (!state.closed && existing.length && existing.join("\0") !== newIds.join("\0")) {
            throw new AppError("RESULT_CORRECTION_DEPENDENCY_CONFLICT", "KO-Zielslot ist bereits belegt", 409);
          }
          slotNames.forEach((name, index) => { successorTarget[headerIndex(header, name)] = newIds[index] || ""; });
          koTarget = {
            recordId: String(successorRow[idIndex] || "").trim(),
            changes: changedCells(header, successorRow, successorTarget, slotNames),
            identity: [{ index: idIndex, name: "id", value: String(successorRow[idIndex] || "") }],
          };
          koTargetStatus = "ready";
        }
      }
    }

    if (options.action === "clear" && context.ranking) {
      const provenance = this.repository.getState(`match-result-ranking:${params.matchId}`, null).value;
      if (provenance) {
        const rankingHeader = headerOf(rankingValues);
        const competitionIndex = headerIndex(rankingHeader, "bewerbid");
        const personIndex = headerIndex(rankingHeader, "personid");
        const rankIndex = headerIndex(rankingHeader, "rang");
        rankingTargets = provenance.after.map((entry) => {
          const current = rankingValues.slice(1).find((candidate) => String(candidate[competitionIndex] || "").trim() === context.competitionId && String(candidate[personIndex] || "").trim() === entry.personId);
          if (!current || Number(current[rankIndex]) !== entry.afterRank) throw new AppError("RANKING_REPAIR_REQUIRED", "Ranglistenstand wurde nach dem Ergebnis veraendert", 409);
          const before = provenance.before.find((candidate) => candidate.personId === entry.personId);
          if (before?.inserted) {
            const idIndex = headerIndex(rankingHeader, "id");
            if (String(current[idIndex] || "").trim() !== resultMembershipId(params.matchId, context.competitionId, entry.personId)) {
              throw new AppError("RANKING_REPAIR_REQUIRED", "Eingefuegte Ranglistenmitgliedschaft wurde nach dem Ergebnis veraendert", 409);
            }
          }
          if (!before) throw new AppError("RANKING_REPAIR_REQUIRED", "Urspruengliche Ranglistenprovenienz ist unvollstaendig", 409);
          return before?.inserted
            ? { personId: entry.personId, beforeRank: entry.afterRank, afterRank: null, removed: true, inserted: true }
            : { personId: entry.personId, beforeRank: entry.afterRank, afterRank: before.beforeRank };
        });
      } else if (winnerSide === 1) {
        throw new AppError("RANKING_REPAIR_REQUIRED", "Provenienz der Rangverschiebung fehlt", 409);
      }
    }

    const rankingHeader = headerOf(rankingValues);
    const rankingCompetitionIndex = headerIndex(rankingHeader, "bewerbid");
    const rankingPersonIndex = headerIndex(rankingHeader, "personid");
    const rankingRankIndex = headerIndex(rankingHeader, "rang");
    const rankUpdates = rankingTargets.flatMap((target) => {
      const rankingRow = rankingValues.slice(1).find((entry) => String(entry[rankingCompetitionIndex] || "").trim() === context.competitionId && String(entry[rankingPersonIndex] || "").trim() === target.personId);
      if (target.inserted && target.beforeRank === null) {
        if (rankingRow) throw new AppError("RANK_CONFLICT", "Ranglistenmitgliedschaft wurde zwischenzeitlich angelegt", 409);
        const emptyOffset = rankingValues.slice(1).findIndex((entry) => !entry.some((value) => String(value || "").trim()));
        const rowNumber = emptyOffset >= 0 ? emptyOffset + 2 : rankingValues.length + 1;
        const afterRow = rowForHeader(rankingHeader, { ID: target.recordId, BewerbID: context.competitionId, PersonID: target.personId, Rang: target.afterRank });
        const changes = ["id", "bewerbid", "personid", "rang"].map((name) => {
          const index = headerIndex(rankingHeader, name);
          return { index, name, before: "", after: afterRow[index] ?? "" };
        });
        return [{ table: "rlPlatzierung", recordId: `membership:${context.competitionId}:${target.personId}`, personId: target.personId, beforeRank: null, afterRank: target.afterRank, inserted: true, rowNumber, changes, identity: [] }];
      }
      if (!rankingRow || Number(rankingRow[rankingRankIndex]) !== target.beforeRank) throw new AppError("RANK_CONFLICT", "Rang wurde zwischenzeitlich geaendert", 409);
      const rowNumber = rankingValues.indexOf(rankingRow) + 1;
      if (!target.removed && target.beforeRank === target.afterRank) return [];
      const names = target.removed ? ["id", "bewerbid", "personid", "rang"] : ["rang"];
      const afterRow = [...rankingRow];
      for (const name of names) afterRow[headerIndex(rankingHeader, name)] = target.removed ? "" : target.afterRank;
      return [{
        table: "rlPlatzierung",
        recordId: `membership:${context.competitionId}:${target.personId}`,
        personId: target.personId,
        beforeRank: target.beforeRank,
        afterRank: target.afterRank,
        inserted: Boolean(target.inserted),
        removed: Boolean(target.removed),
        rowNumber,
        changes: changedCells(rankingHeader, rankingRow, afterRow, names),
        identity: target.removed ? [] : [
          { index: rankingCompetitionIndex, name: "bewerbid", value: context.competitionId },
          { index: rankingPersonIndex, name: "personid", value: target.personId },
        ],
      }];
    });
    const matchChanges = changedCells(header, row, targetRow, ["ergebnis", "matchende", "spieler1id", "spieler2id", "spieler3id", "spieler4id"]);
    const competitionName = String(context.competition.row[headerIndex(context.competition.header, "bezeichnung")] || "").trim();
    const updates = [
      ...(matchChanges.length ? [{
        table: "matches1",
        recordId: params.matchId,
        changes: matchChanges,
        identity: [{ index: idIndex, name: "id", value: params.matchId }],
      }] : []),
      ...(koTarget?.changes.length ? [{ table: "matches1", ...koTarget }] : []),
      ...rankUpdates,
    ];
    if (!updates.length) throw new AppError("MATCH_RESULT_UNCHANGED", "Ergebnis und Rangplan sind unveraendert", 409);
    return {
      phase: "match-result",
      endpoint: options.endpoint,
      matchId: params.matchId,
      competitionId: context.competitionId,
      changeType,
      completionType,
      source: options.source,
      participantIds,
      participantNames: Object.fromEntries(participantIds.map((id) => [id, this.personName(id)])),
      competitionName,
      roundCode: String(row[headerIndex(header, "bewerbrunde")] || "").trim(),
      result: String(targetRow[headerIndex(header, "ergebnis")] || "").trim(),
      matchEnd: String(targetRow[matchEndIndex] || "").trim(),
      reason: adminReason,
      reasonRecorded: Boolean(options.admin),
      occurredAt: this.now(),
      updates,
      matchGuard: {
        recordId: params.matchId,
        beforeFingerprint: currentFingerprint,
        afterFingerprint: matchCompletionFingerprint(targetRow, header),
      },
      rankingBefore: rankingProvenanceBefore || rankUpdates.map(({ personId, beforeRank, inserted }) => ({ personId, beforeRank, ...(inserted ? { inserted: true } : {}) })),
      rankingAfter: rankingProvenanceAfter || rankUpdates.filter(({ removed }) => !removed).map(({ personId, afterRank, inserted }) => ({ personId, afterRank, ...(inserted ? { inserted: true } : {}) })),
      rankingProvenanceReplace,
      rankingUpdateCount: rankUpdates.length,
      koTargetMatchId: koTarget?.recordId || "",
      koTargetStatus,
      koExpectedRoundCode,
    };
  }

  async resolveResultPlanRows(plan, matches, rankings) {
    const resolved = [];
    for (const update of plan.updates) {
      if (update.table === "matches1") {
        const stable = await this.resolveStableRow("matches1", update.recordId, matches, "FORMATTED_VALUE");
        resolved.push({ ...update, metadataId: stable.metadata.metadataId, currentRow: stable.row, sheets: stable.sheets });
      } else if (update.inserted && update.beforeRank === null) {
        const rankingHeader = headerOf(rankings);
        const competitionIndex = headerIndex(rankingHeader, "bewerbid");
        const personIndex = headerIndex(rankingHeader, "personid");
        const existing = rankings.slice(1).find((row) => String(row[competitionIndex] || "").trim() === plan.competitionId
          && String(row[personIndex] || "").trim() === update.personId);
        if (existing) {
          const [stable] = await this.resolveStableCompositeRows("rlPlatzierung", [{
            recordId: update.recordId,
            identity: (row, header) => String(row[headerIndex(header, "bewerbid")] || "").trim() === plan.competitionId
              && String(row[headerIndex(header, "personid")] || "").trim() === update.personId,
          }], rankings);
          resolved.push({ ...update, metadataId: stable.metadata.metadataId, currentRow: stable.row, sheets: stable.sheets });
        } else {
          const rowAtTarget = rankings[update.rowNumber - 1] || [];
          if (rowAtTarget.some((value) => String(value || "").trim())) {
            throw new AppError("WRITE_CONFLICT", "Zielzeile der neuen Ranglistenmitgliedschaft ist belegt", 409);
          }
          const sheets = await this.getClient();
          const maxIndex = Math.max(...update.changes.map(({ index }) => index));
          resolved.push({ ...update, a1Range: `'${TABLE_CONFIG.rlPlatzierung.range}'!A${update.rowNumber}:${columnName(maxIndex)}${update.rowNumber}`, currentRow: rowAtTarget, sheets });
        }
      } else if (update.removed && update.inserted) {
        const rankingHeader = headerOf(rankings);
        const existing = rankings.slice(1).find((row) => String(row[headerIndex(rankingHeader, "bewerbid")] || "").trim() === plan.competitionId
          && String(row[headerIndex(rankingHeader, "personid")] || "").trim() === update.personId);
        if (existing) {
          const [stable] = await this.resolveStableCompositeRows("rlPlatzierung", [{
            recordId: update.recordId,
            identity: (row, header) => String(row[headerIndex(header, "bewerbid")] || "").trim() === plan.competitionId
              && String(row[headerIndex(header, "personid")] || "").trim() === update.personId,
          }], rankings);
          const currentRow = await this.readMetadataRow(stable.sheets, stable.metadata.metadataId, "FORMULA");
          assertRemovableInsertedRankingRow(update, currentRow || stable.row, stable.header);
          resolved.push({ ...update, metadataId: stable.metadata.metadataId, currentRow: currentRow || stable.row, sheets: stable.sheets });
        } else {
          const sheets = await this.getClient();
          resolved.push({ ...update, currentRow: rankings[update.rowNumber - 1] || [], sheets });
        }
      } else {
        const [stable] = await this.resolveStableCompositeRows("rlPlatzierung", [{
          recordId: update.recordId,
          identity: (row, header) => String(row[headerIndex(header, "bewerbid")] || "").trim() === plan.competitionId
            && String(row[headerIndex(header, "personid")] || "").trim() === update.personId,
        }], rankings);
        resolved.push({ ...update, metadataId: stable.metadata.metadataId, currentRow: stable.row, sheets: stable.sheets });
      }
    }
    return resolved;
  }

  async ensureResultEvent(principal, params, plan) {
    if (!this.messagingService) throw new AppError("MESSAGING_UNAVAILABLE", "Nachrichtendienst ist nicht verfuegbar", 503);
    let notificationType = "result";
    try {
      await this.messagingService.ensureMatchResultEvent({
        operationId: params.operationId,
        matchId: plan.matchId,
        competitionId: plan.competitionId,
        competitionName: plan.competitionName,
        roundCode: plan.roundCode,
        participantIds: plan.participantIds,
        participantNames: plan.participantNames,
        actorId: principal.id,
        actorName: principal.name || this.personName(principal.id),
        changeType: plan.changeType,
        completionType: plan.completionType,
        result: plan.result,
        matchEnd: plan.matchEnd,
        reason: plan.reason,
        createdAt: plan.occurredAt,
      });
      if (plan.koTargetStatus === "missing") {
        notificationType = "ko_progression";
        await this.messagingService.ensureMissingKoTargetEvent({
          operationId: params.operationId,
          matchId: plan.matchId,
          competitionName: plan.competitionName,
          roundCode: plan.roundCode,
          expectedRoundCode: plan.koExpectedRoundCode,
          actorId: principal.id,
          actorName: principal.name || this.personName(principal.id),
          createdAt: plan.occurredAt,
        });
      }
    } catch (error) {
      logger.log("error", notificationType === "ko_progression" ? "ko_progression_admin_notification_failed" : "match_result_event_persistence_failed", {
        matchId: plan.matchId,
        competitionId: plan.competitionId,
        changeType: plan.changeType,
        ...(notificationType === "ko_progression" ? { expectedRoundCode: plan.koExpectedRoundCode } : {}),
        errorCode: error.code || "MESSAGING_WRITE_FAILED",
      });
      throw resultRecoveryError("Ergebnisaenderung ist ausgefuehrt, Meldungen konnten nicht bestaetigt werden", params, plan);
    }
  }

  persistResultProvenance(plan, params) {
    if (!plan.rankingAfter.length && !plan.rankingBefore.length && !plan.rankingProvenanceReplace) return;
    try {
      const key = `match-result-ranking:${plan.matchId}`;
      const state = this.repository.getState(key, null);
      this.repository.setState(key, plan.changeType === "result_cleared" || (plan.rankingProvenanceReplace && !plan.rankingAfter.length) ? null : {
        before: plan.rankingBefore,
        after: plan.rankingAfter,
      }, state.revision);
    } catch (error) {
      throw resultRecoveryError("Ergebnisaenderung ist ausgefuehrt, Ranglistenprovenienz konnte nicht bestaetigt werden", params, plan);
    }
  }

  projectResultPlan(plan, matches, rankings) {
    const nextMatches = structuredClone(matches);
    const nextRankings = structuredClone(rankings);
    for (const update of plan.updates) {
      const target = update.table === "matches1" ? nextMatches : nextRankings;
      const targetHeader = headerOf(target);
      let row = update.table === "matches1"
        ? target.slice(1).find((entry) => String(entry[headerIndex(targetHeader, "id")] || "").trim() === update.recordId)
        : target.slice(1).find((entry) => String(entry[headerIndex(targetHeader, "bewerbid")] || "").trim() === plan.competitionId && String(entry[headerIndex(targetHeader, "personid")] || "").trim() === update.personId);
      if (!row && update.table === "rlPlatzierung" && update.inserted && update.beforeRank === null) {
        while (target.length < update.rowNumber) target.push([]);
        row = target[update.rowNumber - 1];
      }
      if (!row) throw new AppError("WRITE_CONFLICT", "Geplante Ergebniszeile wurde nicht gefunden", 409);
      for (const { index, after } of update.changes) row[index] = after;
    }
    validateTableValues("matches1", nextMatches);
    const rankingHeader = headerOf(nextRankings);
    const competitionIndex = headerIndex(rankingHeader, "bewerbid");
    const personIndex = headerIndex(rankingHeader, "personid");
    validateTableValues("rlPlatzierung", nextRankings.map((row, index) => (
      index === 0 || String(row[competitionIndex] || "").trim() || String(row[personIndex] || "").trim() ? row : []
    )));
    return { nextMatches, nextRankings };
  }

  async applyResultOperation(principal, params, options) {
    const payload = Object.fromEntries(Object.entries(params).filter(([key]) => key !== "operationId"));
    return this.runIdempotent(principal, options.endpoint, params.operationId, payload, ({ recoveryOnly, recoveryDetails, checkpointUnknown }) => this.enqueue("matches1", () => this.enqueue("rlPlatzierung", async () => {
      requireCurrentData("bewerbe", "bewerbsart", "matchtyp", "players");
      if (options.admin && principal.role !== "admin") throw new AppError("FORBIDDEN", "Administratorberechtigung fehlt", 403);
      this.cancelScheduledRefresh("matches1");
      this.cancelScheduledRefresh("rlPlatzierung");
      const [matches, rankings] = await Promise.all([this.readTable("matches1"), this.readTable("rlPlatzierung")]);
      dataStore.set("matches1", matches, { source: "write-read" });
      dataStore.set("rlPlatzierung", rankings, { source: "write-read" });
      const plan = recoveryOnly ? recoveryDetails : await this.resultPlan(principal, params, matches, rankings, options);
      if (!plan || plan.phase !== "match-result" || plan.endpoint !== options.endpoint || plan.matchId !== params.matchId || !Array.isArray(plan.updates)
        || plan.updates.some((update) => !Array.isArray(update.changes) || update.changes.length === 0)
        || plan.matchGuard?.recordId !== params.matchId) {
        throw resultRecoveryError("Recovery-Plan der Ergebnisaenderung ist ungueltig", params, plan || {});
      }
      const resolved = await this.resolveResultPlanRows(plan, matches, rankings);
      const stableMatch = await this.resolveStableRow("matches1", plan.matchGuard.recordId, matches, "FORMATTED_VALUE");
      const matchFingerprint = matchCompletionFingerprint(stableMatch.row, stableMatch.header);
      const beforeCount = resolved.filter((entry) => resultUpdateMatches(entry, entry.currentRow, "before")).length;
      const afterCount = resolved.filter((entry) => resultUpdateMatches(entry, entry.currentRow, "after")).length;
      if (afterCount === resolved.length && matchFingerprint === plan.matchGuard.afterFingerprint) {
        await this.establishInsertedResultMetadata(plan, rankings, resolved[0]?.sheets || await this.getClient(), params);
        this.persistResultProvenance(plan, params);
        await this.ensureResultEvent(principal, params, plan);
        return this.resultOperationResponse(plan, true);
      }
      if (recoveryOnly || beforeCount !== resolved.length || matchFingerprint !== plan.matchGuard.beforeFingerprint) {
        throw resultRecoveryError(beforeCount === resolved.length ? "Ergebnisaenderung wurde noch nicht ausgefuehrt" : "Ergebnisaenderung besitzt einen gemischten Zustand", params, plan);
      }
      let { nextMatches, nextRankings } = this.projectResultPlan(plan, matches, rankings);
      if (resolved.some(({ a1Range }) => a1Range)) {
        // A1 inserts have no stable row metadata, so narrow the non-CAS race with one last table read.
        const immediateRankings = await this.readTable("rlPlatzierung", "write_precondition");
        for (const entry of resolved.filter(({ table }) => table === "rlPlatzierung")) {
          const current = entry.a1Range
            ? immediateRankings[entry.rowNumber - 1] || []
            : immediateRankings.slice(1).find((row) => {
              const header = headerOf(immediateRankings);
              return String(row[headerIndex(header, "bewerbid")] || "").trim() === plan.competitionId
                && String(row[headerIndex(header, "personid")] || "").trim() === entry.personId;
            });
          if (entry.a1Range && current.some((value) => String(value || "").trim())) {
            throw new AppError("WRITE_CONFLICT", "Zielzeile der neuen Ranglistenmitgliedschaft ist belegt", 409);
          }
          if (!resultUpdateMatches(entry, current, "before")) {
            throw new AppError("RANK_CONFLICT", "Rang wurde unmittelbar vor dem Ergebniswrite geaendert", 409);
          }
        }
        ({ nextMatches, nextRankings } = this.projectResultPlan(plan, matches, immediateRankings));
      }
      const immediateMatch = await this.readMetadataRow(stableMatch.sheets, stableMatch.metadata.metadataId, "FORMATTED_VALUE", "write_precondition");
      if (!immediateMatch
        || String(immediateMatch[headerIndex(stableMatch.header, "id")] || "").trim() !== plan.matchId
        || matchCompletionFingerprint(immediateMatch, stableMatch.header) !== plan.matchGuard.beforeFingerprint) {
        throw new AppError("RESULT_CONFLICT", "Matchergebnis wurde unmittelbar vor dem Write geaendert", 409);
      }
      checkpointUnknown(plan);
      const sheets = resolved[0]?.sheets || await this.getClient();
      let recovered = false;
      try {
        const response = await sheets.spreadsheets.values.batchUpdateByDataFilter({
          spreadsheetId: SHEET_ID,
          requestBody: {
            valueInputOption: "RAW",
            data: resolved.map((entry) => ({ dataFilter: entry.a1Range
              ? { a1Range: entry.a1Range }
              : { developerMetadataLookup: { metadataId: entry.metadataId } }, majorDimension: "ROWS", values: [sparseResultRow(entry)] })),
          },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
        if (Number(response.data.totalUpdatedRows) !== resolved.length) throw new Error("Ergebnisbatch hat nicht alle Zeilen aktualisiert");
      } catch (error) {
        const needsRankingConfirmation = plan.updates.some((entry) => entry.table === "rlPlatzierung" && (entry.inserted && entry.beforeRank === null || entry.removed && entry.inserted));
        const freshRankings = needsRankingConfirmation
          ? await this.readTable("rlPlatzierung", "confirmation").catch(() => null)
          : null;
        for (const entry of resolved) {
          if (entry.a1Range) entry.currentRow = freshRankings?.[entry.rowNumber - 1] || null;
          else entry.currentRow = await this.readMetadataRow(sheets, entry.metadataId, "FORMATTED_VALUE", "confirmation").catch(() => null);
        }
        const confirmedMatch = await this.readMetadataRow(stableMatch.sheets, stableMatch.metadata.metadataId, "FORMATTED_VALUE", "confirmation").catch(() => null);
        const confirmedMatchFingerprint = confirmedMatch ? matchCompletionFingerprint(confirmedMatch, stableMatch.header) : "";
        const confirmedAfter = resolved.filter((entry) => resultUpdateMatches(entry, entry.currentRow, "after")).length;
        const confirmedBefore = resolved.filter((entry) => resultUpdateMatches(entry, entry.currentRow, "before")).length;
        if (confirmedAfter === resolved.length && confirmedMatchFingerprint === plan.matchGuard.afterFingerprint) recovered = true;
        else throw resultRecoveryError(confirmedBefore === resolved.length && confirmedMatchFingerprint === plan.matchGuard.beforeFingerprint ? "Ergebnisaenderung wurde nicht ausgefuehrt" : "Ausgang der Ergebnisaenderung ist gemischt oder unklar", params, plan);
      }
      if (plan.updates.some((entry) => entry.table === "rlPlatzierung" && (entry.inserted && entry.beforeRank === null || entry.removed && entry.inserted))) {
        const confirmedRankings = await this.readTable("rlPlatzierung", "confirmation").catch(() => null);
        if (!confirmedRankings) throw resultRecoveryError("Ranglistenmitgliedschaft konnte nicht bestaetigt werden", params, plan);
        const rankingUpdates = plan.updates.filter((entry) => entry.table === "rlPlatzierung");
        if (rankingUpdates.some((entry) => {
          const row = entry.inserted && (entry.beforeRank === null || entry.removed)
            ? confirmedRankings[entry.rowNumber - 1]
            : confirmedRankings.slice(1).find((candidate) => String(candidate[headerIndex(headerOf(confirmedRankings), "bewerbid")] || "").trim() === plan.competitionId
              && String(candidate[headerIndex(headerOf(confirmedRankings), "personid")] || "").trim() === entry.personId);
          return !resultUpdateMatches(entry, row, "after");
        })) {
          throw resultRecoveryError("Ranglistenstand stimmt nicht mit dem Zielplan ueberein", params, plan);
        }
        validateTableValues("rlPlatzierung", confirmedRankings);
        await this.establishInsertedResultMetadata(plan, confirmedRankings, sheets, params);
      }
      for (const update of plan.updates.filter((entry) => entry.removed && entry.inserted)) {
        const resolvedUpdate = resolved.find((entry) => entry.recordId === update.recordId);
        if (!resolvedUpdate?.metadataId) continue;
        try {
          await this.deleteRecordMetadata(sheets, "rlPlatzierung", update.recordId, resolvedUpdate.metadataId);
        } catch (error) {
          this.recordMetadata.delete(`rlPlatzierung:${update.recordId}`);
          logger.log("warn", "sheet_result_membership_metadata_cleanup_failed", { matchId: plan.matchId, personId: update.personId, errorCode: error.code || "METADATA_CLEANUP_FAILED" });
        }
      }
      dataStore.set("matches1", nextMatches, { source: "write-local", authoritative: false });
      dataStore.set("rlPlatzierung", nextRankings, { source: "write-local", authoritative: false });
      this.scheduleRefresh("matches1");
      if (plan.updates.some((entry) => entry.table === "rlPlatzierung")) this.scheduleRefresh("rlPlatzierung");
      this.persistResultProvenance(plan, params);
      await this.ensureResultEvent(principal, params, plan);
      return this.resultOperationResponse(plan, recovered);
    })));
  }

  async establishInsertedResultMetadata(plan, rankings, sheets, params) {
    const inserted = plan.updates.filter((entry) => entry.table === "rlPlatzierung" && entry.inserted && entry.beforeRank === null);
    if (!inserted.length) return;
    const header = headerOf(rankings);
    const competitionIndex = headerIndex(header, "bewerbid");
    const personIndex = headerIndex(header, "personid");
    for (const update of inserted) {
      const matches = rankings.slice(1).filter((row) => String(row[competitionIndex] || "").trim() === plan.competitionId
        && String(row[personIndex] || "").trim() === update.personId);
      if (matches.length !== 1 || !resultUpdateMatches(update, matches[0], "after")) {
        throw resultRecoveryError("Neue Ranglistenmitgliedschaft ist nicht eindeutig bestaetigt", params, plan);
      }
    }
    await this.resolveStableCompositeRows("rlPlatzierung", inserted.map((update) => ({
      recordId: update.recordId,
      identity: (row, rowHeader) => String(row[headerIndex(rowHeader, "bewerbid")] || "").trim() === plan.competitionId
        && String(row[headerIndex(rowHeader, "personid")] || "").trim() === update.personId,
    })), rankings);
  }

  resultOperationResponse(plan, recovered = false) {
    const eventName = plan.changeType === "match_end_corrected" ? "admin_match_end_update_completed"
      : plan.changeType === "result_cleared" ? "admin_match_result_clear_completed" : "match_result_update_completed";
    logger.log("info", eventName, {
      matchId: plan.matchId,
      competitionId: plan.competitionId,
      changeType: plan.changeType,
      completionType: plan.completionType,
      source: plan.source,
      shiftedCount: plan.rankingUpdateCount ?? plan.rankingAfter.length,
      koTargetMatchId: plan.koTargetMatchId,
      koTargetStatus: plan.koTargetStatus,
      recovered,
      reasonRecorded: Boolean(plan.reasonRecorded),
    });
    return withAudit({
      success: true,
      matchId: plan.matchId,
      fingerprint: (() => {
        const matches = dataStore.get("matches1");
        const header = headerOf(matches);
        const idIndex = headerIndex(header, "id");
        const row = matches.slice(1).find((entry) => String(entry[idIndex] || "").trim() === plan.matchId);
        return matchCompletionFingerprint(row, header);
      })(),
      ...(recovered ? { recovered: true } : {}),
      ...(plan.koTargetStatus === "missing" ? { warningCode: "KO_TARGET_MISSING" } : {}),
    }, {
      before: {
        matchId: plan.matchId,
        competitionId: plan.competitionId,
        ...(plan.reasonRecorded ? { reasonRecorded: true } : {}),
      },
      after: {
        matchId: plan.matchId,
        competitionId: plan.competitionId,
        changeType: plan.changeType,
        completionType: plan.completionType,
        source: plan.source,
        shiftedCount: plan.rankingUpdateCount ?? plan.rankingAfter.length,
        koTargetMatchId: plan.koTargetMatchId,
        koTargetStatus: plan.koTargetStatus,
        ...(plan.reasonRecorded ? { reasonRecorded: true } : {}),
      },
    });
  }

  setMatchResult(principal, params) {
    return this.applyResultOperation(principal, params, { endpoint: "setMatchResult", action: "result", source: principal.role === "admin" ? "admin" : "participant" });
  }

  adminSetMatchEnd(principal, params) {
    return this.applyResultOperation(principal, params, { endpoint: "adminSetMatchEnd", action: "matchEnd", source: "admin", admin: true });
  }

  adminClearMatchResult(principal, params) {
    return this.applyResultOperation(principal, params, { endpoint: "adminClearMatchResult", action: "clear", source: "admin", admin: true });
  }

  adminCorrectRankingResult(principal, params) {
    return this.applyResultOperation(principal, params, { endpoint: "adminCorrectRankingResult", action: "result", source: "admin", admin: true, rankPlan: params.rankPlan });
  }

  async adminDeleteRankingChallenge(principal, params) {
    const payload = { matchId: params.matchId, reason: params.reason };
    return this.runIdempotent(principal, "adminDeleteRankingChallenge", params.operationId, payload, ({ recoveryOnly, recoveryDetails, checkpointUnknown }) => this.enqueue("matches1", async () => {
      if (principal.role !== "admin") throw new AppError("FORBIDDEN", "Administratorberechtigung fehlt", 403);
      requireCurrentData("bewerbe", "players");
      this.cancelScheduledRefresh("matches1");
      const values = await this.readTable("matches1");
      dataStore.set("matches1", values, { source: "write-read" });
      const header = headerOf(values);
      const idIndex = headerIndex(header, "id");
      if (idIndex < 0) throw new AppError("SHEET_SCHEMA", "Matches1-Spalte ID fehlt", 503);
      const target = values.slice(1).find((row) => String(row[idIndex] || "").trim() === params.matchId);
      if (recoveryOnly && !target) {
        const plan = recoveryDetails;
        if (plan?.action !== "deleted" || plan.matchId !== params.matchId) {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Recovery-Plan der Forderungsloeschung ist ungueltig", 503, plan || {});
        }
        await this.ensureAdminRankingChallengeEvent(principal, params, plan);
        logger.log("info", "ranking_challenge_delete_completed", { matchId: params.matchId, competitionId: plan.competitionId, actorId: principal.id, recovered: true });
        return withAudit({ success: true, matchId: params.matchId, deleted: true, recovered: true }, {
          before: { matchId: params.matchId, competitionId: plan.competitionId, challengeDate: plan.challengeDate, matchDate: plan.matchDate },
          after: { deleted: true, reasonRecorded: true },
        });
      }
      if (!target) throw new AppError("MATCH_NOT_FOUND", "Forderung wurde nicht gefunden", 404);
      const stable = await this.resolveStableRow("matches1", params.matchId, values, "FORMATTED_VALUE");
      const context = this.adminRankingChallengeContext(stable.row, stable.header);
      const plan = recoveryOnly ? recoveryDetails : {
        action: "deleted",
        matchId: params.matchId,
        competitionId: context.competitionId,
        challengerId: context.challengerId,
        opponentId: context.opponentId,
        challengeDate: context.challengeDate,
        matchDate: context.matchDate,
        occurredAt: this.now(),
      };
      if (recoveryOnly) {
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Forderungsloeschung ist noch nicht nachweisbar", 503, plan);
      }
      checkpointUnknown(plan);
      let recovered = false;
      try {
        const response = await stable.sheets.spreadsheets.values.batchClearByDataFilter({
          spreadsheetId: SHEET_ID,
          requestBody: { dataFilters: [{ developerMetadataLookup: { metadataId: stable.metadata.metadataId } }] },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
        if ((response.data.clearedRanges || []).length !== 1) throw new Error("Metadaten-Clear hat keine eindeutige Zeile aktualisiert");
      } catch (error) {
        const confirmationRow = await this.readMetadataRow(stable.sheets, stable.metadata.metadataId, "FORMULA", "confirmation").catch(() => null);
        const confirmation = await this.readTable("matches1", "confirmation").catch(() => null);
        const confirmationIdIndex = confirmation ? headerIndex(headerOf(confirmation), "id") : -1;
        const stillPresent = confirmationIdIndex >= 0 && confirmation.slice(1).some((row) => String(row[confirmationIdIndex] || "").trim() === params.matchId);
        if ((confirmationRow && confirmationRow.some((value) => String(value || "").trim())) || !confirmation || stillPresent) {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Forderungsloeschung ist unklar", 503, plan);
        }
        recovered = true;
      }
      try {
        await this.deleteRecordMetadata(stable.sheets, "matches1", params.matchId, stable.metadata.metadataId);
      } catch (error) {
        this.recordMetadata.delete(`matches1:${params.matchId}`);
        logger.log("warn", "sheet_match_metadata_cleanup_failed", { matchId: params.matchId, errorCode: error.code || "METADATA_CLEANUP_FAILED" });
      }
      const candidate = [values[0], ...values.slice(1).filter((row) => String(row[idIndex] || "").trim() !== params.matchId)];
      dataStore.set("matches1", candidate, { source: "write-local", authoritative: false });
      this.scheduleRefresh("matches1");
      await this.ensureAdminRankingChallengeEvent(principal, params, plan);
      logger.log("info", "ranking_challenge_delete_completed", { matchId: params.matchId, competitionId: plan.competitionId, actorId: principal.id, recovered });
      return withAudit({ success: true, matchId: params.matchId, deleted: true, ...(recovered ? { recovered: true } : {}) }, {
        before: { matchId: params.matchId, competitionId: plan.competitionId, challengeDate: plan.challengeDate, matchDate: plan.matchDate },
        after: { deleted: true, reasonRecorded: true },
      });
    }));
  }

  async adminSetRankingChallengeDate(principal, params) {
    return this.adminSetRankingDate(principal, params, {
      endpoint: "adminSetRankingChallengeDate",
      action: "challenge_date_changed",
      field: "challengeDate",
      column: "forderungdate",
      fullHour: false,
      completedEvent: "ranking_challenge_date_update_completed",
    });
  }

  async adminSetRankingMatchDate(principal, params) {
    return this.adminSetRankingDate(principal, params, {
      endpoint: "adminSetRankingMatchDate",
      action: "match_date_changed",
      field: "matchDate",
      column: "matchdate",
      fullHour: true,
      completedEvent: "ranking_match_date_admin_update_completed",
    });
  }

  async adminSetRankingDate(principal, params, options) {
    const nextDate = params[options.field];
    const payload = { matchId: params.matchId, [options.field]: nextDate, reason: params.reason };
    return this.runIdempotent(principal, options.endpoint, params.operationId, payload, ({ recoveryOnly, recoveryDetails, checkpointUnknown }) => this.enqueue("matches1", async () => {
      if (principal.role !== "admin") throw new AppError("FORBIDDEN", "Administratorberechtigung fehlt", 403);
      requireCurrentData("bewerbe", "players");
      if (!validCompactDateTime(nextDate)) throw new AppError("MATCH_DATE_INVALID", "Zeitpunkt ist ungueltig", 400);
      if (options.fullHour && !nextDate.endsWith("00")) {
        throw new AppError("MATCH_DATE_TIME_INVALID", "Spieldaten sind nur zur vollen Stunde moeglich", 409);
      }
      this.cancelScheduledRefresh("matches1");
      const values = await this.readTable("matches1");
      dataStore.set("matches1", values, { source: "write-read" });
      let stable;
      try {
        stable = await this.resolveStableRow("matches1", params.matchId, values, "FORMATTED_VALUE");
      } catch (error) {
        if (error.code === "RECORD_NOT_FOUND") {
          if (recoveryOnly) throw new AppError("WRITE_OUTCOME_UNKNOWN", "Datumsänderung ist nicht mehr nachweisbar", 503, recoveryDetails || {});
          throw new AppError("MATCH_NOT_FOUND", "Forderung wurde nicht gefunden", 404);
        }
        throw error;
      }
      const columnIndex = headerIndex(stable.header, options.column);
      const currentDate = String(stable.row[columnIndex] || "").trim();
      if (recoveryOnly) {
        const plan = recoveryDetails;
        const previousDate = String(plan?.previousDate || "");
        if (plan?.action !== options.action || plan.matchId !== params.matchId || plan.nextDate !== nextDate || currentDate !== nextDate) {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Datumsänderung ist noch nicht nachweisbar", 503, plan || {});
        }
        await this.ensureAdminRankingChallengeEvent(principal, params, plan);
        logger.log("info", options.completedEvent, { matchId: params.matchId, competitionId: plan.competitionId, actorId: principal.id, previousDate, nextDate, recovered: true });
        return withAudit({ success: true, matchId: params.matchId, [options.field]: nextDate, recovered: true }, {
          before: { matchId: params.matchId, [options.field]: previousDate },
          after: { matchId: params.matchId, [options.field]: nextDate, reasonRecorded: true },
        });
      }
      const context = this.adminRankingChallengeContext(stable.row, stable.header);
      const previousDate = currentDate;
      const plan = {
        action: options.action,
        matchId: params.matchId,
        competitionId: context.competitionId,
        challengerId: context.challengerId,
        opponentId: context.opponentId,
        previousDate,
        nextDate,
        occurredAt: this.now(),
      };
      if (currentDate === nextDate) throw new AppError("MATCH_DATE_UNCHANGED", "Der ausgewaehlte Zeitpunkt ist bereits eingetragen", 409);
      checkpointUnknown(plan);
      const updates = Array(columnIndex + 1).fill(null);
      updates[columnIndex] = nextDate;
      let recovered = false;
      try {
        const response = await stable.sheets.spreadsheets.values.batchUpdateByDataFilter({
          spreadsheetId: SHEET_ID,
          requestBody: {
            valueInputOption: "RAW",
            data: [{ dataFilter: { developerMetadataLookup: { metadataId: stable.metadata.metadataId } }, majorDimension: "ROWS", values: [updates] }],
          },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
        if (Number(response.data.totalUpdatedRows) !== 1) throw new Error("Metadaten-Update hat keine eindeutige Zeile aktualisiert");
      } catch (error) {
        const confirmationRow = await this.readMetadataRow(stable.sheets, stable.metadata.metadataId, "FORMATTED_VALUE", "confirmation").catch(() => null);
        if (!confirmationRow || String(confirmationRow[columnIndex] || "").trim() !== nextDate) {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Datumsänderung ist unklar", 503, plan);
        }
        recovered = true;
      }
      const candidate = structuredClone(values);
      const candidateIdIndex = headerIndex(headerOf(candidate), "id");
      const candidateRow = candidate.slice(1).find((row) => String(row[candidateIdIndex] || "").trim() === params.matchId);
      if (candidateRow) candidateRow[columnIndex] = nextDate;
      dataStore.set("matches1", candidate, { source: "write-local", authoritative: false });
      this.scheduleRefresh("matches1");
      await this.ensureAdminRankingChallengeEvent(principal, params, plan);
      logger.log("info", options.completedEvent, { matchId: params.matchId, competitionId: plan.competitionId, actorId: principal.id, previousDate, nextDate, recovered });
      return withAudit({ success: true, matchId: params.matchId, [options.field]: nextDate, ...(recovered ? { recovered: true } : {}) }, {
        before: { matchId: params.matchId, [options.field]: previousDate },
        after: { matchId: params.matchId, [options.field]: nextDate, reasonRecorded: true },
      });
    }));
  }

  async addEntry(principal, params) {
    const payload = { bewerbId: params.bewerbId };
    return this.runIdempotent(principal, "addEntryList", params.operationId, payload, ({ recoveryOnly }) => this.enqueue("entryList", async () => {
      this.cancelScheduledRefresh("entryList");
      const values = await this.readTable("entryList");
      dataStore.set("entryList", values, { source: "write-read" });
      const header = headerOf(values);
      const idIndex = headerIndex(header, "id");
      const competitionIndex = headerIndex(header, "bewerbid", "bewerb id");
      const personIndex = headerIndex(header, "personenid", "personen id", "personid", "playerid", "spielerid");
      if (competitionIndex < 0 || personIndex < 0) throw new AppError("SHEET_SCHEMA", "EntryList-Spalten fehlen", 500);
      const newId = stableRecordId("e", principal, params.operationId);
      if (values.slice(1).some((row) => String(row[idIndex] || "").trim() === newId)) {
        dataStore.set("entryList", values, { source: "write" });
        return { success: true, entryId: newId, recovered: true };
      }
      if (recoveryOnly) {
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Anmeldung ist noch nicht nachweisbar", 503, { operationId: params.operationId, recordId: newId });
      }
      this.assertEntryWindow(params.bewerbId, principal.id);
      const exists = values.slice(1).some((row) =>
        String(row[competitionIndex] || "").trim() === params.bewerbId &&
        String(row[personIndex] || "").trim() === principal.id);
      if (exists) {
        return { success: true, alreadyPresent: true };
      }
      const newRow = rowForHeader(header, { id: newId, bewerbid: params.bewerbId, personenid: principal.id, entrydate: viennaTimestamp() });
      const sheets = await this.getClient();
      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: TABLE_CONFIG.entryList.range,
          valueInputOption: "RAW",
          requestBody: { values: [newRow] },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
      } catch (error) {
        try {
          const confirmation = await this.readTable("entryList", "confirmation");
          if (confirmation.slice(1).some((row) => String(row[idIndex] || "").trim() === newId)) {
            dataStore.set("entryList", confirmation, { source: "write" });
            return { success: true, entryId: newId, recovered: true };
          }
        } catch (confirmationError) {
          logger.log("error", "sheet_entry_confirmation_read_failed", { recordId: newId, error: confirmationError });
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Anmeldung ist unklar", 503, { operationId: params.operationId, recordId: newId });
      }
      const candidate = structuredClone(values);
      candidate.push(newRow);
      dataStore.set("entryList", candidate, { source: "write-local", authoritative: false });
      this.scheduleRefresh("entryList");
      return { success: true, entryId: newId };
    }));
  }

  async removeEntry(principal, params) {
    const payload = { bewerbId: params.bewerbId };
    return this.runIdempotent(principal, "removeEntryList", params.operationId, payload, ({ recoveryOnly, recoveryDetails }) => this.enqueue("entryList", async () => {
      this.cancelScheduledRefresh("entryList");
      const values = await this.readTable("entryList");
      dataStore.set("entryList", values, { source: "write-read" });
      const header = headerOf(values);
      const idIndex = headerIndex(header, "id");
      const competitionIndex = headerIndex(header, "bewerbid", "bewerb id");
      const personIndex = headerIndex(header, "personenid", "personen id", "personid", "playerid", "spielerid");
      if (idIndex < 0 || competitionIndex < 0 || personIndex < 0) throw new AppError("SHEET_SCHEMA", "EntryList-Spalten fehlen", 500);
      if (recoveryOnly && recoveryDetails?.phase === "delete") {
        const recordId = String(recoveryDetails?.recordId || "").trim();
        if (recordId && !values.slice(1).some((row) => String(row[idIndex] || "").trim() === recordId)) {
          dataStore.set("entryList", values, { source: "write" });
          return withAudit({ success: true, removed: true, recovered: true }, { before: recoveryDetails.tombstone || null, after: null });
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Abmeldung ist weiterhin unklar", 503, {
          operationId: params.operationId,
          recordId,
          phase: "delete",
          tombstone: recoveryDetails?.tombstone || null,
        });
      }
      const targetRow = values.slice(1).find((row) =>
        String(row[competitionIndex] || "").trim() === params.bewerbId &&
        String(row[personIndex] || "").trim() === principal.id);
      if (!targetRow) {
        return withAudit({ success: true, removed: false }, { before: null, after: null });
      }
      const recordId = String(targetRow[idIndex] || "").trim();
      const entryDateIndex = headerIndex(header, "entrydate");
      const tombstone = {
        recordId,
        bewerbId: String(targetRow[competitionIndex] || "").trim(),
        personId: String(targetRow[personIndex] || "").trim(),
        entryDate: entryDateIndex < 0 ? "" : String(targetRow[entryDateIndex] || "").trim(),
      };
      const { metadata, row, sheets } = await this.resolveStableRow("entryList", recordId, values);
      if (
        String(row[competitionIndex] || "").trim() !== params.bewerbId
        || String(row[personIndex] || "").trim() !== principal.id
      ) {
        throw new AppError("WRITE_CONFLICT", "EntryList-Datensatz wurde zwischenzeitlich geaendert", 409);
      }
      try {
        const response = await sheets.spreadsheets.values.batchClearByDataFilter({
          spreadsheetId: SHEET_ID,
          requestBody: { dataFilters: [{ developerMetadataLookup: { metadataId: metadata.metadataId } }] },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
        if ((response.data.clearedRanges || []).length !== 1) throw new Error("Metadaten-Clear hat keine eindeutige Zeile aktualisiert");
        try {
          await this.deleteRecordMetadata(sheets, "entryList", recordId, metadata.metadataId);
        } catch (metadataError) {
          this.recordMetadata.delete(`entryList:${recordId}`);
          logger.log("warn", "sheet_entry_metadata_cleanup_failed", { recordId, error: metadataError });
        }
      } catch (error) {
        try {
          const confirmationRow = await this.readMetadataRow(sheets, metadata.metadataId, "FORMULA", "confirmation");
          if (!confirmationRow || !confirmationRow.some((value) => String(value || "").trim())) {
            try {
              await this.deleteRecordMetadata(sheets, "entryList", recordId, metadata.metadataId);
            } catch {
              this.recordMetadata.delete(`entryList:${recordId}`);
            }
            const confirmation = await this.readTable("entryList", "confirmation");
            const confirmationHeader = headerOf(confirmation);
            const confirmationIdIndex = headerIndex(confirmationHeader, "id");
            const stillPresent = confirmation.slice(1).some((entry) => String(entry[confirmationIdIndex] || "").trim() === recordId);
            if (!stillPresent) {
              dataStore.set("entryList", confirmation, { source: "write" });
              return withAudit({ success: true, removed: true, recovered: true }, { before: tombstone, after: null });
            }
          }
        } catch (confirmationError) {
          logger.log("error", "sheet_entry_delete_confirmation_read_failed", { recordId, error: confirmationError });
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Abmeldung ist unklar", 503, {
          operationId: params.operationId,
          recordId,
          phase: "delete",
          tombstone,
        });
      }
      const candidate = [values[0], ...values.slice(1).filter((entry) => String(entry[idIndex] || "").trim() !== recordId)];
      dataStore.set("entryList", candidate, { source: "write-local", authoritative: false });
      this.scheduleRefresh("entryList");
      return withAudit({ success: true, removed: true }, { before: tombstone, after: null });
    }));
  }

  async withdrawFromRanking(principal, params) {
    const payload = { reason: params.reason, rank: params.rank, bewerbId: params.bewerbId };
    return this.runIdempotent(principal, "withdrawFromRanking", params.operationId, payload, ({ recoveryOnly, recoveryDetails, checkpointUnknown }) => (
      this.enqueue(`ranking:${params.bewerbId}`, () => this.enqueue("rlPlatzierung", async () => {
        const [values, matches] = await Promise.all([
          this.readTable("rlPlatzierung"),
          this.readTable("matches1"),
        ]);
        dataStore.set("rlPlatzierung", values, { source: "write-read" });
        dataStore.set("matches1", matches, { source: "write-read" });

        const competition = this.competition(params.bewerbId);
        const competitionTypeIndex = headerIndex(competition.header, "bewerbsartid");
        if (String(competition.row[competitionTypeIndex] || "").trim() !== "2") {
          throw new AppError("RANKING_REQUIRED", "Bewerb ist keine Rangliste", 409);
        }

        const header = headerOf(values);
        const indexes = {
          competition: headerIndex(header, "bewerbid"),
          person: headerIndex(header, "personid"),
          rank: headerIndex(header, "rang"),
          withdrawnAt: headerIndex(header, "rausgehangenam"),
          previousRank: headerIndex(header, "rausgehangenletzteplatzierung"),
          reason: headerIndex(header, "rausgehangengrund"),
        };
        const membership = (personId) => values.slice(1).find((row) => (
          String(row[indexes.competition] || "").trim() === params.bewerbId
          && String(row[indexes.person] || "").trim() === String(personId)
        ));
        const ownRow = membership(principal.id);
        if (!ownRow) throw new AppError("RANKING_MEMBERSHIP_REQUIRED", "Spieler ist nicht in dieser Rangliste", 409);

        let plan = recoveryOnly ? recoveryDetails : null;
        if (!plan) {
          const currentRank = Number(ownRow[indexes.rank]);
          if (currentRank <= 0) throw new AppError("RANKING_ALREADY_WITHDRAWN", "Spieler ist bereits rausgehaengt", 409);
          if (currentRank !== params.rank) throw new AppError("RANK_CONFLICT", "Rang wurde zwischenzeitlich geaendert", 409);
          const now = new Date(this.now());
          const rules = analyzeMatchRules(matches, params.bewerbId, now);
          if (rules.busyIds.has(String(principal.id))) {
            throw new AppError("RANKING_WITHDRAWAL_MATCH_OPEN", "Raushängen ist waehrend einer offenen Forderung nicht moeglich", 409);
          }
          const targets = values.slice(1).flatMap((row) => {
            if (String(row[indexes.competition] || "").trim() !== params.bewerbId) return [];
            const rank = Number(row[indexes.rank]);
            const personId = String(row[indexes.person] || "").trim();
            if (personId === String(principal.id)) return [{ personId, beforeRank: currentRank, afterRank: 0, own: true }];
            return Number.isInteger(rank) && rank > currentRank
              ? [{ personId, beforeRank: rank, afterRank: rank - 1, own: false }]
              : [];
          });
          plan = {
            phase: "ranking-withdrawal",
            bewerbId: params.bewerbId,
            personId: String(principal.id),
            previousRank: currentRank,
            withdrawnAt: viennaTimestamp(false, now),
            targets,
          };
        }
        if (plan.phase !== "ranking-withdrawal"
          || plan.bewerbId !== params.bewerbId
          || plan.personId !== String(principal.id)
          || !Array.isArray(plan.targets)) {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Recovery-Plan der Ranglistenaenderung ist ungueltig", 503, plan);
        }

        checkpointUnknown(plan);
        const stableRows = await this.resolveStableCompositeRows(
          "rlPlatzierung",
          plan.targets.map((target) => ({
            recordId: `membership:${params.bewerbId}:${target.personId}`,
            identity: (row, rowHeader) => (
              String(row[headerIndex(rowHeader, "bewerbid")] || "").trim() === params.bewerbId
              && String(row[headerIndex(rowHeader, "personid")] || "").trim() === target.personId
            ),
          })),
          values,
        );
        const stable = plan.targets.map((target, index) => ({
          ...target,
          metadataId: stableRows[index].metadata.metadataId,
          row: stableRows[index].row,
        }));

        const targetMatches = (entry) => {
          if (Number(entry.row[indexes.rank]) !== entry.afterRank) return false;
          if (!entry.own) return true;
          return String(entry.row[indexes.withdrawnAt] || "").trim() === plan.withdrawnAt
            && Number(entry.row[indexes.previousRank]) === plan.previousRank
            && String(entry.row[indexes.reason] || "").trim() === params.reason;
        };
        const beforeMatches = (entry) => Number(entry.row[indexes.rank]) === entry.beforeRank;
        if (recoveryOnly && stable.every(targetMatches)) {
          dataStore.set("rlPlatzierung", values, { source: "write-read" });
          await this.ensureRankingWithdrawalEvent(principal, params, plan);
          return withAudit({
            success: true,
            recovered: true,
            withdrawnAt: plan.withdrawnAt,
            previousRank: plan.previousRank,
            shiftedCount: Math.max(0, plan.targets.length - 1),
          }, {
            before: { bewerbId: params.bewerbId, rank: plan.previousRank },
            after: { rank: 0, withdrawnAt: plan.withdrawnAt, shiftedCount: Math.max(0, plan.targets.length - 1), reasonRecorded: true },
          });
        }
        if (!stable.every(beforeMatches)) {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ranglistenaenderung besitzt einen gemischten Zustand", 503, plan);
        }

        const updatedRows = stable.map((entry) => {
          const row = [...entry.row];
          row[indexes.rank] = entry.afterRank;
          if (entry.own) {
            row[indexes.withdrawnAt] = plan.withdrawnAt;
            row[indexes.previousRank] = plan.previousRank;
            row[indexes.reason] = params.reason;
          }
          return { ...entry, updatedRow: row };
        });
        const candidate = structuredClone(values);
        for (const entry of updatedRows) {
          const row = candidate.slice(1).find((candidateRow) => (
            String(candidateRow[indexes.competition] || "").trim() === params.bewerbId
            && String(candidateRow[indexes.person] || "").trim() === entry.personId
          ));
          if (row) row.splice(0, row.length, ...entry.updatedRow);
        }
        validateTableValues("rlPlatzierung", candidate);

        this.cancelScheduledRefresh("rlPlatzierung");
        const sheets = await this.getClient();
        try {
          const response = await sheets.spreadsheets.values.batchUpdateByDataFilter({
            spreadsheetId: SHEET_ID,
            requestBody: {
              valueInputOption: "RAW",
              data: updatedRows.map((entry) => ({
                dataFilter: { developerMetadataLookup: { metadataId: entry.metadataId } },
                majorDimension: "ROWS",
                values: [entry.updatedRow],
              })),
            },
          }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
          if (Number(response.data.totalUpdatedRows) !== updatedRows.length) throw new Error("Ranglistenupdate hat nicht alle Zeilen aktualisiert");
        } catch (error) {
          try {
            for (const entry of updatedRows) entry.row = await this.readMetadataRow(sheets, entry.metadataId, "UNFORMATTED_VALUE", "confirmation");
            if (!updatedRows.every(targetMatches)) throw error;
          } catch {
            throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang des Raushängens ist unklar", 503, plan);
          }
        }

        dataStore.set("rlPlatzierung", candidate, { source: "write-local", authoritative: false });
        this.scheduleRefresh("rlPlatzierung");
        await this.ensureRankingWithdrawalEvent(principal, params, plan);
        return withAudit({
          success: true,
          withdrawnAt: plan.withdrawnAt,
          previousRank: plan.previousRank,
          shiftedCount: Math.max(0, plan.targets.length - 1),
        }, {
          before: { bewerbId: params.bewerbId, rank: plan.previousRank },
          after: { rank: 0, withdrawnAt: plan.withdrawnAt, shiftedCount: Math.max(0, plan.targets.length - 1), reasonRecorded: true },
        });
      }))
    ));
  }

  async refreshSheetData(principal, { operationId }) {
    return this.runIdempotent(principal, "refreshSheetData", operationId, {}, async () => {
      const result = await dataPoller.refreshAll("admin");
      for (const tableName of Object.keys(TABLE_CONFIG)) this.cancelScheduledRefresh(tableName);
      return withAudit({
        success: true,
        refreshedAt: result.refreshedAt,
        tableCount: result.tableCount,
        changedTables: result.changedTables,
      }, {
        before: null,
        after: {
          tableCount: result.tableCount,
          changedTableCount: result.changedTables.length,
          refreshedAt: result.refreshedAt,
        },
      });
    });
  }

  async stop() {
    this.stopping = true;
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    await Promise.allSettled([...this.active]);
  }

  status() {
    return {
      stopping: this.stopping,
      activeWrites: this.active.size,
      queues: this.queues.size,
      pendingMetadataIntents: this.repository.countPendingMetadataIntents(),
      scheduledRefreshes: this.refreshTimers.size,
      readCoordinator: getSheetReadStatus(),
    };
  }
}

module.exports = { SheetService, viennaTimestamp };
