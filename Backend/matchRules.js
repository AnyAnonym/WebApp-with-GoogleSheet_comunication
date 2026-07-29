const { AppError } = require("./errors.js");
const { headerIndex, headerOf } = require("./tableUtils.js");

function parseParticipant(raw) {
  const value = String(raw || "").trim();
  return {
    id: value.replace(/\[w\.?o\.?\]/gi, "").replace(/\[ret\]/gi, "").replace(/\[gesetzt\]/gi, "").trim(),
    retired: /\[(?:w\.?o\.?|ret)\]/i.test(value),
  };
}

function winningSide(result, first, third) {
  if (first.retired) return 2;
  if (third.retired) return 1;
  let firstWins = 0;
  let secondWins = 0;
  for (const set of String(result || "").trim().split("/").filter(Boolean)) {
    const scores = set.replace(/\(\d+\)/g, "").replace(/\[ret\]/gi, "").trim().split("-").map(Number);
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

function analyzeMatchRules(values, competitionId, now = new Date()) {
  if (!Array.isArray(values) || !values.length) throw new AppError("MATCH_DATA_UNAVAILABLE", "Matchdaten sind nicht verfuegbar", 503);
  const header = headerOf(values);
  const indexes = {
    ignore: headerIndex(header, "ignore", "ignorieren"),
    competition: headerIndex(header, "bewerbid"),
    date: headerIndex(header, "matchdate"),
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
    const result = String(row[indexes.result] || "").trim();
    const winner = winningSide(result, first, third);
    if (!result && !winner) {
      for (const participant of participants) busyIds.add(participant.id);
      continue;
    }
    if (!winner) throw new AppError("MATCH_DATA_INVALID", "Ein Match besitzt ein ungueltiges Ergebnis", 503);
    const matchDate = parseMatchDate(row[indexes.date]);
    if (!matchDate) throw new AppError("MATCH_DATA_INVALID", "Ein gespieltes Match besitzt ein ungueltiges Datum", 503);
    const firstTeam = [first.id, indexes.p2 < 0 ? "" : parseParticipant(row[indexes.p2]).id].filter(Boolean);
    const secondTeam = [third.id, indexes.p4 < 0 ? "" : parseParticipant(row[indexes.p4]).id].filter(Boolean);
    const winningTeam = winner === 1 ? firstTeam : secondTeam;
    const losingTeam = winner === 1 ? secondTeam : firstTeam;
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

module.exports = { analyzeMatchRules, parseMatchDate };
