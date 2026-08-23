const { AppError } = require("./errors.js");
const { headerIndex, headerOf } = require("./tableUtils.js");
const logger = require("./logger.js");
const { loginValue } = require("./validators.js");

const VALID_ROLES = new Set(["player", "player a", "player b", "operator", "admin"]);
const warnedInvalidRoles = new Set();
const PLAYER_LOGIN_SUMMARY_EVERY = 10;
let playerLoginIssueState = { signature: "", validations: 0, affectedCount: 0 };

const REQUIRED_HEADERS = {
  players: ["id", "vorname", "nachname", "e-mail", "login", "passwdhash", "aktiv", "role"],
  bewerbe: ["id", "bezeichnung", "bewerbsartid"],
  bewerbsart: ["id", "bezeichnung"],
  matchtyp: ["id", "satztiebreak", "entscheidender satz"],
  matches1: ["id", "matchdate", "forderungdate", "bewerbid", "bewerbrunde", "spieler1id", "spieler3id", "ergebnis"],
  rlPlatzierung: ["bewerbid", "personid", "rang"],
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
    const loginIssues = [];
    for (const [offset, row] of values.slice(1).entries()) {
      const role = String(row[roleIndex] || "").trim().toLowerCase();
      if (role && !VALID_ROLES.has(role) && !warnedInvalidRoles.has(role)) {
        warnedInvalidRoles.add(role);
        logger.log("warn", "player_role_fallback_applied", { invalidRole: role, fallbackRole: "player" });
      }
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
  return values;
}

module.exports = { REQUIRED_HEADERS, assertPlayerLoginConflictsNotWorsened, assertUniquePlayerLogins, validateTableValues };
