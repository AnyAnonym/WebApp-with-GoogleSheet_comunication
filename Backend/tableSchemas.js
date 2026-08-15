const { AppError } = require("./errors.js");
const { headerIndex, headerOf } = require("./tableUtils.js");
const logger = require("./logger.js");
const { emailValue } = require("./validators.js");

const VALID_ROLES = new Set(["player", "operator", "admin"]);
const warnedInvalidRoles = new Set();
const PLAYER_EMAIL_SUMMARY_EVERY = 10;
let playerEmailIssueState = { signature: "", validations: 0, affectedCount: 0 };

const REQUIRED_HEADERS = {
  players: ["id", "vorname", "nachname", "e-mail", "passwdhash", "aktiv", "role"],
  bewerbe: ["id", "bezeichnung", "bewerbsartid"],
  bewerbsart: ["id", "bezeichnung"],
  matchtyp: ["id", "satztiebreak", "entscheidender satz"],
  matches1: ["id", "matchdate", "forderungdate", "bewerbid", "bewerbrunde", "spieler1id", "spieler3id", "ergebnis"],
  rlPlatzierung: ["bewerbid", "personid", "rang"],
  navigator: ["name", "ziel"],
  entryList: ["id", "bewerbid", "personenid", "entrydate"],
};

function reportPlayerEmailIssues(issues) {
  if (!issues.length) {
    if (playerEmailIssueState.signature) {
      logger.log("info", "player_email_validation_recovered", {
        table: "players",
        previousAffectedCount: playerEmailIssueState.affectedCount,
      });
    }
    playerEmailIssueState = { signature: "", validations: 0, affectedCount: 0 };
    return;
  }

  const signature = JSON.stringify(issues);
  const fields = {
    table: "players",
    affectedCount: issues.length,
    affected: issues.slice(0, 20),
    omittedCount: Math.max(0, issues.length - 20),
  };
  if (signature !== playerEmailIssueState.signature) {
    logger.log("warn", "player_email_validation_issues", fields);
    playerEmailIssueState = { signature, validations: 1, affectedCount: issues.length };
    return;
  }

  playerEmailIssueState.validations++;
  if (playerEmailIssueState.validations % PLAYER_EMAIL_SUMMARY_EVERY === 0) {
    logger.log("warn", "player_email_validation_summary", fields);
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
    const emailIndex = headerIndex(header, "e-mail");
    const emails = new Set();
    const emailIssues = [];
    for (const [offset, row] of values.slice(1).entries()) {
      const role = String(row[roleIndex] || "").trim().toLowerCase();
      if (role && !VALID_ROLES.has(role) && !warnedInvalidRoles.has(role)) {
        warnedInvalidRoles.add(role);
        logger.log("warn", "player_role_fallback_applied", { invalidRole: role, fallbackRole: "player" });
      }
      const email = String(row[emailIndex] || "").trim().toLowerCase();
      if (!email) continue;
      let normalizedEmail;
      try {
        normalizedEmail = emailValue(email);
      } catch {
        emailIssues.push({
          rowNumber: offset + 2,
          personId: String(row[idIndex] || "").trim(),
          reason: "INVALID_EMAIL",
        });
        continue;
      }
      if (emails.has(normalizedEmail)) throw new AppError("SHEET_SCHEMA", "Personen-E-Mail ist nicht eindeutig", 503);
      emails.add(normalizedEmail);
    }
    reportPlayerEmailIssues(emailIssues);
  }
  return values;
}

module.exports = { REQUIRED_HEADERS, validateTableValues };
