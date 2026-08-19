const { AppError } = require("./errors.js");
const { hashPayload } = require("./security.js");
const { headerIndex, headerOf } = require("./tableUtils.js");
const { emailValue } = require("./validators.js");

const FIELD_DEFINITIONS = Object.freeze({
  firstName: { headers: ["vorname"], max: 100 },
  lastName: { headers: ["nachname"], max: 100, required: true },
  birthDate: { headers: ["geburtsdatum"], max: 10 },
  gender: { headers: ["geschlechtid", "geschlecht"], max: 1 },
  phone: { headers: ["telefonmobil"], max: 32 },
  email: { headers: ["e-mail", "email"], max: 254 },
  country: { headers: ["land"], max: 100 },
  postalCode: { headers: ["plz"], max: 16 },
  city: { headers: ["ort"], max: 100 },
  address: { headers: ["adresse"], max: 200 },
  active: { headers: ["aktiv"], max: 1 },
  role: { headers: ["role"], max: 16 },
});

const ROLE_VALUES = new Map([
  ["admin", "admin"],
  ["operator", "operator"],
  ["player", "player"],
  ["player a", "player A"],
  ["player b", "player B"],
]);

function fieldIndexes(header) {
  return Object.fromEntries(Object.entries(FIELD_DEFINITIONS).map(([field, definition]) => [
    field,
    headerIndex(header, ...definition.headers),
  ]));
}

function rawPersonValues(header, row) {
  const indexes = fieldIndexes(header);
  return Object.fromEntries(Object.keys(FIELD_DEFINITIONS).map((field) => [
    field,
    indexes[field] < 0 ? "" : String(row[indexes[field]] ?? ""),
  ]));
}

function personFingerprint(values) {
  return hashPayload(Object.fromEntries(Object.keys(FIELD_DEFINITIONS).map((field) => [field, String(values[field] ?? "")])));
}

function validBirthDate(value) {
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return false;
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day);
}

function canonicalRole(value) {
  return ROLE_VALUES.get(String(value || "").trim().toLowerCase()) || null;
}

function canonicalPhone(value) {
  const phone = String(value || "").trim();
  if (!phone) return "";
  return /^00\d+ \d+ \d(?:[\d ]*\d)?$/.test(phone) ? phone : null;
}

function validateTargetValue(field, rawValue) {
  const definition = FIELD_DEFINITIONS[field];
  if (!definition || typeof rawValue !== "string") {
    throw new AppError("VALIDATION_ERROR", `Ungueltiger Zielwert fuer ${field}`);
  }
  let value = rawValue.trim();
  if (value.length > definition.max) throw new AppError("VALIDATION_ERROR", `${field} ist zu lang`);
  if (definition.required && !value) throw new AppError("VALIDATION_ERROR", `${field} darf nicht leer sein`);

  if (field === "email" && value) value = emailValue(value);
  if (field === "birthDate" && value && !validBirthDate(value)) {
    throw new AppError("VALIDATION_ERROR", "GeburtsDatum muss TT.MM.JJJJ enthalten");
  }
  if (field === "gender" && value && !["1", "2", "3"].includes(value)) {
    throw new AppError("VALIDATION_ERROR", "GeschlechtID muss leer, 1, 2 oder 3 sein");
  }
  if (field === "phone" && value) {
    const phone = canonicalPhone(value);
    if (!phone) throw new AppError("VALIDATION_ERROR", "TelefonMobil ist ungueltig");
    value = phone;
  }
  if (field === "postalCode" && value && !/^\d{4}$/.test(value)) {
    throw new AppError("VALIDATION_ERROR", "PLZ muss vierstellig sein");
  }
  if (field === "active" && !["", "1"].includes(value)) {
    throw new AppError("VALIDATION_ERROR", "Aktiv muss leer oder 1 sein");
  }
  if (field === "role") {
    const role = canonicalRole(value);
    if (!role) throw new AppError("VALIDATION_ERROR", "Role ist ungueltig");
    value = role;
  }
  return value;
}

function validateChanges(rawChanges) {
  if (!rawChanges || Array.isArray(rawChanges) || typeof rawChanges !== "object") {
    throw new AppError("VALIDATION_ERROR", "changes muss ein Objekt sein");
  }
  const entries = Object.entries(rawChanges);
  if (!entries.length || entries.length > Object.keys(FIELD_DEFINITIONS).length) {
    throw new AppError("VALIDATION_ERROR", "changes muss mindestens ein erlaubtes Feld enthalten");
  }
  for (const [field] of entries) {
    if (!Object.hasOwn(FIELD_DEFINITIONS, field)) throw new AppError("VALIDATION_ERROR", `Unbekanntes Aenderungsfeld: ${field}`);
  }
  return Object.fromEntries(entries.map(([field, value]) => [field, validateTargetValue(field, value)]));
}

function issue(field, code, message, proposedValue) {
  return {
    field,
    code,
    message,
    ...(proposedValue === undefined ? {} : { proposedValue }),
  };
}

function analyzePerson(values, duplicateEmails) {
  const issues = [];
  for (const field of ["firstName", "lastName", "country", "city", "address"]) {
    const trimmed = values[field].trim();
    if (values[field] !== trimmed) issues.push(issue(field, "EDGE_WHITESPACE", "Fuehrender oder nachgestellter Leerraum", trimmed));
  }
  if (!values.lastName.trim()) issues.push(issue("lastName", "REQUIRED_VALUE_MISSING", "Nachname fehlt"));

  const birthDate = values.birthDate.trim();
  if (values.birthDate !== birthDate) issues.push(issue("birthDate", "EDGE_WHITESPACE", "Rand-Leerraum im Geburtsdatum", birthDate));
  if (birthDate && !validBirthDate(birthDate)) issues.push(issue("birthDate", "BIRTH_DATE_INVALID", "Geburtsdatum ist nicht TT.MM.JJJJ"));

  const gender = values.gender.trim();
  if (values.gender !== gender) issues.push(issue("gender", "EDGE_WHITESPACE", "Rand-Leerraum im Geschlecht", gender));
  if (gender && !["1", "2", "3"].includes(gender)) issues.push(issue("gender", "GENDER_INVALID", "GeschlechtID ist nicht 1, 2 oder 3"));

  const phone = values.phone.trim();
  const normalizedPhone = canonicalPhone(phone);
  if (phone && !normalizedPhone) {
    issues.push(issue("phone", "PHONE_FORMAT_INVALID", "Telefonnummer entspricht nicht dem Format 00<Ländercode> <Netzvorwahl> <Rest>"));
  } else if (values.phone !== phone) {
    issues.push(issue("phone", "EDGE_WHITESPACE", "Rand-Leerraum in der Telefonnummer", phone));
  }

  const email = values.email.trim();
  if (email) {
    try {
      const normalizedEmail = emailValue(email);
      if (values.email !== normalizedEmail) issues.push(issue("email", "EMAIL_NONCANONICAL", "E-Mail ist nicht kanonisch geschrieben", normalizedEmail));
      if (duplicateEmails.has(normalizedEmail)) issues.push(issue("email", "EMAIL_DUPLICATE", "E-Mail wird mehrfach verwendet"));
    } catch {
      issues.push(issue("email", "EMAIL_INVALID", "E-Mail-Adresse ist ungueltig"));
    }
  } else if (values.email !== email) {
    issues.push(issue("email", "EDGE_WHITESPACE", "E-Mail enthaelt nur Leerraum", ""));
  }

  const postalCode = values.postalCode.trim();
  if (values.postalCode !== postalCode) issues.push(issue("postalCode", "EDGE_WHITESPACE", "Rand-Leerraum in PLZ", postalCode));
  if (postalCode && !/^\d{4}$/.test(postalCode)) issues.push(issue("postalCode", "POSTAL_CODE_INVALID", "PLZ ist nicht vierstellig"));

  const active = values.active.trim();
  if (!["", "1"].includes(active)) issues.push(issue("active", "ACTIVE_NONCANONICAL", "Aktiv muss leer oder 1 sein", active === "0" ? "" : undefined));
  else if (values.active !== active) issues.push(issue("active", "EDGE_WHITESPACE", "Rand-Leerraum im Aktivstatus", active));

  const role = values.role.trim();
  const normalizedRole = canonicalRole(role);
  if (!normalizedRole) issues.push(issue("role", "ROLE_INVALID", "Role ist ungueltig", "player"));
  else if (values.role !== normalizedRole) issues.push(issue("role", "ROLE_NONCANONICAL", "Role ist nicht kanonisch geschrieben", normalizedRole));
  return issues;
}

function projectPeopleNormalization(table) {
  if (!Array.isArray(table) || !Array.isArray(table[0])) throw new AppError("SHEET_SCHEMA", "Personen-Tabelle besitzt keine Kopfzeile", 503);
  const header = headerOf(table);
  const idIndex = headerIndex(header, "id");
  if (idIndex < 0) throw new AppError("SHEET_SCHEMA", "Personen-Spalte ID fehlt", 503);

  const emailCounts = new Map();
  for (const row of table.slice(1)) {
    const values = rawPersonValues(header, row);
    if (!values.email.trim()) continue;
    try {
      const email = emailValue(values.email);
      emailCounts.set(email, (emailCounts.get(email) || 0) + 1);
    } catch {
      // Invalid values are reported on their row, not used as duplicate keys.
    }
  }
  const duplicateEmails = new Set([...emailCounts].filter(([, count]) => count > 1).map(([email]) => email));
  const people = table.slice(1).flatMap((row) => {
    const id = String(row[idIndex] || "").trim();
    if (!id) return [];
    const values = rawPersonValues(header, row);
    const issues = analyzePerson(values, duplicateEmails);
    return [{ id, values, issues, fingerprint: personFingerprint(values) }];
  });
  return {
    people,
    issueCount: people.reduce((sum, person) => sum + person.issues.length, 0),
    affectedCount: people.filter((person) => person.issues.length).length,
  };
}

module.exports = {
  FIELD_DEFINITIONS,
  canonicalPhone,
  canonicalRole,
  fieldIndexes,
  personFingerprint,
  projectPeopleNormalization,
  rawPersonValues,
  validateChanges,
};
