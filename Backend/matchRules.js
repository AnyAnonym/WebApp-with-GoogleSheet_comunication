const crypto = require("crypto");
const { AppError } = require("./errors.js");
const { headerIndex, headerOf } = require("./tableUtils.js");

function parseParticipant(raw) {
  const value = String(raw || "").trim();
  const markerLength = value.endsWith("[wo]") ? 4 : value.endsWith("[ret]") ? 5 : 0;
  const retired = markerLength > 0;
  const withoutMarker = retired ? value.slice(0, -markerLength).trim() : value;
  return {
    id: withoutMarker.replace(/\[gesetzt\]/gi, "").trim(),
    retired,
  };
}

function winningSide(result, firstTeam, secondTeam) {
  if (firstTeam.some((participant) => participant.retired)) return 2;
  if (secondTeam.some((participant) => participant.retired)) return 1;
  let firstWins = 0;
  let secondWins = 0;
  for (const set of String(result || "").trim().split("/").filter(Boolean)) {
    const scores = set.replace(/\(\d+\)/g, "").replace(/\[ret\]/g, "").trim().split("-").map(Number);
    if (scores.length !== 2 || scores.some(Number.isNaN)) continue;
    if (scores[0] > scores[1]) firstWins++;
    if (scores[1] > scores[0]) secondWins++;
  }
  return firstWins > secondWins ? 1 : secondWins > firstWins ? 2 : 0;
}

function parseMatchDate(raw) {
  const match = String(raw || "").trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, yy, month, day, hour, minute] = match;
  const year = Number(yy) >= 50 ? 1900 + Number(yy) : 2000 + Number(yy);
  const value = new Date(year, Number(month) - 1, Number(day), Number(hour), Number(minute));
  if (
    value.getFullYear() !== year || value.getMonth() !== Number(month) - 1 || value.getDate() !== Number(day)
    || value.getHours() !== Number(hour) || value.getMinutes() !== Number(minute)
  ) return null;
  return value;
}

function matchCompletionFingerprint(row, header) {
  const normalizedHeader = headerOf([header]);
  const controlled = ["ergebnis", "matchende", "spieler1id", "spieler2id", "spieler3id", "spieler4id"]
    .map((name) => {
      const index = headerIndex(normalizedHeader, name);
      return index < 0 ? "" : String(row[index] ?? "").trim();
    });
  return crypto.createHash("sha256").update(JSON.stringify(controlled)).digest("hex");
}

function analyzeMatchRules(values, competitionId, now = new Date()) {
  if (!Array.isArray(values) || !values.length) throw new AppError("MATCH_DATA_UNAVAILABLE", "Matchdaten sind nicht verfuegbar", 503);
  const header = headerOf(values);
  const indexes = {
    ignore: headerIndex(header, "ignore", "ignorieren"),
    competition: headerIndex(header, "bewerbid"),
    date: headerIndex(header, "matchende"),
    legacyDate: headerIndex(header, "matchdate"),
    result: headerIndex(header, "ergebnis"),
    p1: headerIndex(header, "spieler1id"),
    p2: headerIndex(header, "spieler2id"),
    p3: headerIndex(header, "spieler3id"),
    p4: headerIndex(header, "spieler4id"),
  };
  if ([indexes.competition, indexes.date, indexes.result, indexes.p1, indexes.p3].includes(-1)) {
    throw new AppError("MATCH_SCHEMA_INCOMPLETE", "Matchdaten sind unvollstaendig", 503);
  }

  const busyIds = new Set();
  const latest = new Map();
  for (const row of values.slice(1)) {
    if (indexes.ignore >= 0 && String(row[indexes.ignore] || "").trim() === "1") continue;
    if (competitionId && String(row[indexes.competition] || "").trim() !== competitionId) continue;
    const participants = [indexes.p1, indexes.p2, indexes.p3, indexes.p4]
      .map((index) => (index < 0 ? { id: "", retired: false } : parseParticipant(row[index])))
      .filter((participant) => participant.id);
    const first = parseParticipant(row[indexes.p1]);
    const third = parseParticipant(row[indexes.p3]);
    const firstTeam = [first, indexes.p2 < 0 ? null : parseParticipant(row[indexes.p2])].filter((participant) => participant?.id);
    const secondTeam = [third, indexes.p4 < 0 ? null : parseParticipant(row[indexes.p4])].filter((participant) => participant?.id);
    const result = String(row[indexes.result] || "").trim();
    const winner = winningSide(result, firstTeam, secondTeam);
    if (!result && !winner) {
      for (const participant of participants) busyIds.add(participant.id);
      continue;
    }
    if (!winner) throw new AppError("MATCH_DATA_INVALID", "Ein Match besitzt ein ungueltiges Ergebnis", 503);
    const matchEnd = String(row[indexes.date] ?? "").trim();
    const matchDate = parseMatchDate(matchEnd || row[indexes.legacyDate]);
    if (!matchDate) throw new AppError("MATCH_DATA_INVALID", "Ein gespieltes Match besitzt ein ungueltiges Datum", 503);
    const firstTeamIds = firstTeam.map((participant) => participant.id);
    const secondTeamIds = secondTeam.map((participant) => participant.id);
    const winningTeam = winner === 1 ? firstTeamIds : secondTeamIds;
    const losingTeam = winner === 1 ? secondTeamIds : firstTeamIds;
    for (const id of winningTeam) {
      if (!latest.has(id) || latest.get(id).matchDate < matchDate) latest.set(id, { kind: "protection", matchDate });
    }
    for (const id of losingTeam) {
      if (!latest.has(id) || latest.get(id).matchDate < matchDate) latest.set(id, { kind: "blocked", matchDate });
    }
  }

  const protection = new Map();
  const blocked = new Map();
  const durationMs = 7 * 24 * 60 * 60 * 1000;
  for (const [id, status] of latest) {
    const until = new Date(status.matchDate.getTime() + durationMs);
    if (until <= now) continue;
    (status.kind === "protection" ? protection : blocked).set(id, until);
  }
  return { blocked, busyIds, protection };
}

module.exports = { analyzeMatchRules, matchCompletionFingerprint, parseMatchDate, parseParticipant };
