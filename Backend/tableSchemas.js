const { AppError } = require("./errors.js");
const { headerIndex, headerOf } = require("./tableUtils.js");
const logger = require("./logger.js");
const { loginValue } = require("./validators.js");
const { notificationChannels } = require("./messagingService.js");

const VALID_ROLES = new Set(["player", "player a", "player b", "operator", "admin"]);
const warnedInvalidRoles = new Set();
const PLAYER_LOGIN_SUMMARY_EVERY = 10;
let playerLoginIssueState = { signature: "", validations: 0, affectedCount: 0 };

function validCompactTimestamp(value) {
  const match = String(value).match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!match) return false;
  const [, yy, month, day, hour, minute] = match;
  const year = Number(yy) >= 50 ? 1900 + Number(yy) : 2000 + Number(yy);
  const date = new Date(Date.UTC(year, Number(month) - 1, Number(day), Number(hour), Number(minute)));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day)
    && date.getUTCHours() === Number(hour)
    && date.getUTCMinutes() === Number(minute);
}

const REQUIRED_HEADERS = {
  players: ["id", "vorname", "nachname", "e-mail", "login", "passwdhash", "aktiv", "role"],
  bewerbe: ["id", "bezeichnung", "bewerbsartid"],
  bewerbsart: ["id", "bezeichnung"],
  matchtyp: ["id", "gewinnsaetze", "satzlaenge", "satztiebreak", "entscheidender satz", "noad"],
  matches1: ["id", "matchdate", "matchstart", "matchende", "ergebniserfasstam", "forderungdate", "bewerbid", "bewerbrunde", "spieler1id", "spieler3id", "ergebnis", "spieler1rangbeiergebnis", "spieler3rangbeiergebnis"],
  rlPlatzierung: ["bewerbid", "personid", "rang", "rausgehangenam", "rausgehangenletzteplatzierung", "rausgehangengrund"],
  navigator: ["name", "ziel"],
  entryList: ["id", "bewerbid", "personenid", "entrydate"],
};

function reportPlayerLoginIssues(issues) {
  if (!issues.length) {
    if (playerLoginIssueState.signature) {
      logger.log("info", "player_login_validation_recovered", {
        table: "players",
        previousAffectedCount: playerLoginIssueState.affectedCount,
      });
    }
    playerLoginIssueState = { signature: "", validations: 0, affectedCount: 0 };
    return;
  }

  const signature = JSON.stringify(issues);
  const fields = {
    table: "players",
    affectedCount: issues.length,
    affected: issues.slice(0, 20),
    omittedCount: Math.max(0, issues.length - 20),
  };
  if (signature !== playerLoginIssueState.signature) {
    logger.log("warn", "player_login_validation_issues", fields);
    playerLoginIssueState = { signature, validations: 1, affectedCount: issues.length };
    return;
  }

  playerLoginIssueState.validations++;
  if (playerLoginIssueState.validations % PLAYER_LOGIN_SUMMARY_EVERY === 0) {
    logger.log("warn", "player_login_validation_summary", fields);
  }
}

function playerLoginEntries(values) {
  const header = headerOf(values);
  const idIndex = headerIndex(header, "id");
  const loginIndex = headerIndex(header, "login");
  const entries = new Map();
  for (const [offset, row] of values.slice(1).entries()) {
    const login = String(row[loginIndex] || "");
    if (!login) continue;
    let normalizedLogin;
    try {
      normalizedLogin = loginValue(login);
    } catch {
      continue;
    }
    if (!entries.has(normalizedLogin)) entries.set(normalizedLogin, []);
    entries.get(normalizedLogin).push({ rowNumber: offset + 2, personId: String(row[idIndex] || "").trim() });
  }
  return entries;
}

function assertUniquePlayerLogins(values) {
  if ([...playerLoginEntries(values).values()].some((entries) => entries.length > 1)) {
    throw new AppError("LOGIN_CONFLICT", "Personen-Login ist nicht eindeutig", 409);
  }
}

function assertPlayerLoginConflictsNotWorsened(beforeValues, candidateValues) {
  const before = playerLoginEntries(beforeValues);
  for (const [login, entries] of playerLoginEntries(candidateValues)) {
    const previousCount = before.get(login)?.length || 0;
    if (entries.length > Math.max(1, previousCount)) {
      throw new AppError("LOGIN_CONFLICT", "Personen-Login ist nicht eindeutig", 409);
    }
  }
}

function validateTableValues(tableName, values) {
  if (!Array.isArray(values) || !Array.isArray(values[0])) {
    throw new AppError("SHEET_SCHEMA", `Tabelle ${tableName} besitzt keine Kopfzeile`, 503);
  }
  const header = headerOf(values);
  for (const required of REQUIRED_HEADERS[tableName] || []) {
    if (headerIndex(header, required) < 0) {
      throw new AppError("SHEET_SCHEMA", `Tabelle ${tableName}: Spalte ${required} fehlt`, 503);
    }
  }

  const idIndex = headerIndex(header, "id");
  if (idIndex >= 0) {
    const ids = new Set();
    for (const [offset, row] of values.slice(1).entries()) {
      if (!row.some((value) => String(value || "").trim())) continue;
      const id = String(row[idIndex] || "").trim();
      if (!id) throw new AppError("SHEET_SCHEMA", `Tabelle ${tableName}: ID in Zeile ${offset + 2} fehlt`, 503);
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(id)) throw new AppError("SHEET_SCHEMA", `Tabelle ${tableName}: ID-Format ist ungueltig`, 503);
      if (ids.has(id)) throw new AppError("SHEET_SCHEMA", `Tabelle ${tableName}: ID ist nicht eindeutig`, 503);
      ids.add(id);
    }
  }

  if (tableName === "players") {
    if (values.length < 2) throw new AppError("SHEET_SCHEMA", "Personen-Tabelle ist leer", 503);
    const roleIndex = headerIndex(header, "role");
    const loginIndex = headerIndex(header, "login");
    const notificationIndex = headerIndex(header, "notification");
    const loginIssues = [];
    for (const [offset, row] of values.slice(1).entries()) {
      const role = String(row[roleIndex] || "").trim().toLowerCase();
      if (role && !VALID_ROLES.has(role) && !warnedInvalidRoles.has(role)) {
        warnedInvalidRoles.add(role);
        logger.log("warn", "player_role_fallback_applied", { invalidRole: role, fallbackRole: "player" });
      }
      if (notificationIndex >= 0) notificationChannels(row[notificationIndex], {
        personId: String(row[idIndex] || "").trim(),
        rowNumber: offset + 2,
      });
      const login = String(row[loginIndex] || "");
      if (!login) continue;
      try {
        loginValue(login);
      } catch {
        loginIssues.push({
          rowNumber: offset + 2,
          personId: String(row[idIndex] || "").trim(),
          reason: "INVALID_LOGIN",
        });
        continue;
      }
    }
    for (const entries of playerLoginEntries(values).values()) {
      if (entries.length < 2) continue;
      for (const entry of entries) loginIssues.push({ ...entry, reason: "DUPLICATE_LOGIN" });
    }
    reportPlayerLoginIssues(loginIssues);
  }
  if (tableName === "bewerbe") {
    const genderIndex = headerIndex(header, "geschlecht");
    const ageIndex = headerIndex(header, "alterskategorie");
    for (const [offset, row] of values.slice(1).entries()) {
      const gender = genderIndex < 0 ? "" : String(row[genderIndex] || "").trim();
      if (gender) {
        const values = gender.split(",").map((value) => value.trim());
        if (values.some((value) => !["1", "2", "3"].includes(value)) || new Set(values).size !== values.length) {
          throw new AppError("SHEET_SCHEMA", `Tabelle ${tableName}: Geschlecht in Zeile ${offset + 2} ist ungueltig`, 503);
        }
      }
      const age = ageIndex < 0 ? "" : String(row[ageIndex] || "").trim();
      if (age && !/^\d{1,3}[+-]$/.test(age)) {
        throw new AppError("SHEET_SCHEMA", `Tabelle ${tableName}: Alterskategorie in Zeile ${offset + 2} ist ungueltig`, 503);
      }
    }
  }
  if (tableName === "matches1") {
    const rankIndexes = [headerIndex(header, "spieler1rangbeiergebnis"), headerIndex(header, "spieler3rangbeiergebnis")];
    const timestampIndexes = [headerIndex(header, "matchstart"), headerIndex(header, "ergebniserfasstam")];
    for (const [offset, row] of values.slice(1).entries()) {
      if (!row.some((value) => String(value || "").trim())) continue;
      const ranks = rankIndexes.map((index) => String(row[index] ?? "").trim());
      if (ranks.some(Boolean) && (ranks.some((rank) => !/^\d+$/.test(rank) || !Number.isSafeInteger(Number(rank))))) {
        throw new AppError("SHEET_SCHEMA", `Tabelle ${tableName}: Ergebnisraenge in Zeile ${offset + 2} sind ungueltig`, 503);
      }
      if (timestampIndexes.some((index) => String(row[index] ?? "").trim() && !validCompactTimestamp(row[index]))) {
        throw new AppError("SHEET_SCHEMA", `Tabelle ${tableName}: Ergebniszeitpunkte in Zeile ${offset + 2} sind ungueltig`, 503);
      }
    }
  }
  if (tableName === "rlPlatzierung") {
    const competitionIndex = headerIndex(header, "bewerbid");
    const personIndex = headerIndex(header, "personid");
    const rankIndex = headerIndex(header, "rang");
    const withdrawnAtIndex = headerIndex(header, "rausgehangenam");
    const previousRankIndex = headerIndex(header, "rausgehangenletzteplatzierung");
    const reasonIndex = headerIndex(header, "rausgehangengrund");
    const memberships = new Set();
    const activeRanks = new Set();
    for (const [offset, row] of values.slice(1).entries()) {
      if (!row.some((value) => String(value || "").trim())) continue;
      const competitionId = String(row[competitionIndex] || "").trim();
      const personId = String(row[personIndex] || "").trim();
      const rankText = String(row[rankIndex] ?? "").trim();
      const rank = Number(rankText);
      if (!competitionId || !personId || !/^\d+$/.test(rankText) || !Number.isSafeInteger(rank)) {
        throw new AppError("SHEET_SCHEMA", `Tabelle ${tableName}: Mitgliedschaft oder Rang in Zeile ${offset + 2} ist ungueltig`, 503);
      }
      const key = `${competitionId}\u0000${personId}`;
      if (memberships.has(key)) throw new AppError("SHEET_SCHEMA", `Tabelle ${tableName}: Mitgliedschaft ist nicht eindeutig`, 503);
      memberships.add(key);
      if (rank !== 0) {
        const rankKey = `${competitionId}\u0000${rank}`;
        if (activeRanks.has(rankKey)) throw new AppError("SHEET_SCHEMA", `Tabelle ${tableName}: Aktiver Rang ist nicht eindeutig`, 503);
        activeRanks.add(rankKey);
        continue;
      }
      const withdrawnAt = String(row[withdrawnAtIndex] || "").trim();
      const previousRankText = String(row[previousRankIndex] ?? "").trim();
      const reason = String(row[reasonIndex] || "").trim();
      if (!validCompactTimestamp(withdrawnAt)
        || !/^[1-9]\d*$/.test(previousRankText)
        || !Number.isSafeInteger(Number(previousRankText))
        || reason.length < 3
        || reason.length > 500) {
        throw new AppError("SHEET_SCHEMA", `Tabelle ${tableName}: Raushaengedaten in Zeile ${offset + 2} sind unvollstaendig`, 503);
      }
    }
  }
  return values;
}

module.exports = { REQUIRED_HEADERS, assertPlayerLoginConflictsNotWorsened, assertUniquePlayerLogins, validateTableValues };
