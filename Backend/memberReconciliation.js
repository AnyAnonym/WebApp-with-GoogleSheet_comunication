const { AppError } = require("./errors.js");
const {
  FIELD_DEFINITIONS,
  projectPeopleNormalization,
  validateChanges,
} = require("./peopleNormalization.js");
const { hashPayload } = require("./security.js");
const { headerIndex, headerOf } = require("./tableUtils.js");
const { idValue, requireObject, stringValue } = require("./validators.js");

const CONTROLLED_FIELDS = Object.freeze(Object.keys(FIELD_DEFINITIONS));
const REQUEST_FIELDS = Object.freeze({
  update: new Set(["action", "personId", "expectedFingerprint", "externalId", "changes"]),
  create: new Set(["action", "externalId", "values"]),
  deactivate: new Set(["action", "personId", "expectedFingerprint"]),
});

function fingerprintValue(value) {
  return stringValue(value, "expectedFingerprint", { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/i }).toLowerCase();
}

function externalIdValue(value) {
  return stringValue(value, "externalId", { max: 64, pattern: /^[1-9]\d*$/ });
}

function reconciliationFingerprint(values, externalId) {
  const controlledValues = Object.fromEntries(CONTROLLED_FIELDS.map((field) => [field, String(values?.[field] ?? "")]));
  return hashPayload({ externalId: String(externalId ?? ""), values: controlledValues });
}

function projectPeopleReconciliation(table) {
  const header = headerOf(table);
  const externalIdIndex = headerIndex(header, "cd-id");
  if (externalIdIndex < 0) throw new AppError("SHEET_SCHEMA", "Personen-Spalte CD-ID fehlt", 503);

  const normalization = projectPeopleNormalization(table);
  const rowsByPersonId = new Map();
  const idIndex = headerIndex(header, "id");
  for (const row of table.slice(1)) {
    const id = String(row[idIndex] ?? "").trim();
    if (id) rowsByPersonId.set(id, row);
  }

  return {
    people: normalization.people.map(({ id, values }) => {
      const externalId = String(rowsByPersonId.get(id)?.[externalIdIndex] ?? "").trim();
      return { id, externalId, values, fingerprint: reconciliationFingerprint(values, externalId) };
    }),
  };
}

function assertClosedShape(value, action) {
  const allowed = REQUEST_FIELDS[action];
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new AppError("VALIDATION_ERROR", `Unbekanntes Feld fuer ${action}: ${key}`);
  }
}

function optionalChanges(rawChanges) {
  const changes = requireObject(rawChanges, "changes");
  return Object.keys(changes).length ? validateChanges(changes) : {};
}

function createValues(rawValues) {
  const values = validateChanges(rawValues);
  for (const field of ["lastName", "role", "active"]) {
    if (!Object.hasOwn(values, field)) throw new AppError("VALIDATION_ERROR", `values.${field} fehlt`);
  }
  if (values.active !== "1") throw new AppError("VALIDATION_ERROR", "values.active muss 1 sein");
  if (!["player", "player A", "player B"].includes(values.role)) {
    throw new AppError("VALIDATION_ERROR", "Neue Mitglieder muessen eine Spielerrolle erhalten");
  }
  return values;
}

/**
 * Validates a reconciliation domain request without operationId. The caller owns
 * operationId validation/idempotency and combines it with this returned object.
 */
function validateReconciliationRequest(raw) {
  const value = requireObject(raw, "request");
  const action = stringValue(value.action, "action", { max: 16 });
  if (!Object.hasOwn(REQUEST_FIELDS, action)) throw new AppError("VALIDATION_ERROR", "action ist ungueltig");
  assertClosedShape(value, action);

  if (action === "update") {
    const result = {
      action,
      personId: idValue(value.personId, "personId"),
      expectedFingerprint: fingerprintValue(value.expectedFingerprint),
      externalId: externalIdValue(value.externalId),
      changes: optionalChanges(value.changes),
    };
    if (Object.hasOwn(result.changes, "login")) {
      throw new AppError("VALIDATION_ERROR", "Bestehende Logins werden durch den Mitgliederabgleich nicht geaendert");
    }
    if (Object.hasOwn(result.changes, "active") && result.changes.active !== "1") {
      throw new AppError("VALIDATION_ERROR", "Importierte Mitglieder muessen aktiv bleiben");
    }
    if (Object.hasOwn(result.changes, "role") && !["player", "player A", "player B"].includes(result.changes.role)) {
      throw new AppError("VALIDATION_ERROR", "Importdaten duerfen nur Spielerrollen setzen");
    }
    return result;
  }
  if (action === "create") {
    return { action, externalId: externalIdValue(value.externalId), values: createValues(value.values) };
  }
  return {
    action,
    personId: idValue(value.personId, "personId"),
    expectedFingerprint: fingerprintValue(value.expectedFingerprint),
  };
}

function assertUniqueExternalId(people, externalId, exceptPersonId = "") {
  const canonicalExternalId = externalIdValue(externalId);
  if (people.some((person) => person.id !== exceptPersonId && String(person.externalId || "").trim() === canonicalExternalId)) {
    throw new AppError("EXTERNAL_ID_CONFLICT", "CD-ID ist bereits einer Person zugeordnet", 409);
  }
}

function assertUpdateCandidate(currentPerson, request) {
  if (!currentPerson || typeof currentPerson !== "object") throw new AppError("NOT_FOUND", "Person wurde nicht gefunden", 404);
  if (!Object.keys(request.changes).length && currentPerson.externalId === request.externalId) {
    throw new AppError("VALIDATION_ERROR", "update benoetigt Aenderungen oder eine neue CD-ID-Verknuepfung");
  }
}

module.exports = {
  CONTROLLED_FIELDS,
  assertUniqueExternalId,
  assertUpdateCandidate,
  externalIdValue,
  projectPeopleReconciliation,
  reconciliationFingerprint,
  validateReconciliationRequest,
};
