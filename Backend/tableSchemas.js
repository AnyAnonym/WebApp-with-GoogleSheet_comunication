const { AppError } = require("./errors.js");
const { headerIndex, headerOf } = require("./tableUtils.js");
const logger = require("./logger.js");

const VALID_ROLES = new Set(["player", "operator", "admin"]);
const warnedInvalidRoles = new Set();

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
    for (const row of values.slice(1)) {
      const role = String(row[roleIndex] || "").trim().toLowerCase();
      if (role && !VALID_ROLES.has(role) && !warnedInvalidRoles.has(role)) {
        warnedInvalidRoles.add(role);
        logger.log("warn", "player_role_fallback_applied", { invalidRole: role, fallbackRole: "player" });
      }
      const email = String(row[emailIndex] || "").trim().toLowerCase();
      if (!email) continue;
      if (emails.has(email)) throw new AppError("SHEET_SCHEMA", "Personen-E-Mail ist nicht eindeutig", 503);
      emails.add(email);
    }
  }
  return values;
}

module.exports = { REQUIRED_HEADERS, validateTableValues };
