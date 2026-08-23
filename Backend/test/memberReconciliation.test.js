const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const {
  assertUniqueExternalId,
  assertUpdateCandidate,
  projectPeopleReconciliation,
  reconciliationFingerprint,
  validateReconciliationRequest,
} = require("../memberReconciliation.js");

const fingerprint = "a".repeat(64);
const controlledValues = {
  firstName: "Ada",
  lastName: "Admin",
  birthDate: "02.01.1990",
  gender: "2",
  phone: "0043 664 1234567",
  email: "ada@example.test",
  login: "ada.login",
  country: "Oesterreich",
  postalCode: "4060",
  city: "Piberbach",
  address: "Dorf 1",
  active: "1",
  role: "admin",
};

test("reconciliation projection exposes only identity, CD-ID, controlled values, and their fingerprint", () => {
  const table = [
    ["ID", "CD-ID", "Vorname", "Nachname", "GeburtsDatum", "GeschlechtID", "TelefonMobil", "E-Mail", "Land", "PLZ", "Ort", "Adresse", "Aktiv", "Role", "Login", "PasswdHash", "KennwortVergessen", "InternalNote"],
    ["p1", "4711", "Ada", "Admin", "02.01.1990", "2", "0043 664 1234567", "ada@example.test", "Oesterreich", "4060", "Piberbach", "Dorf 1", "1", "admin", "ada.login", "secret", "x", "private"],
  ];

  const person = projectPeopleReconciliation(table).people[0];
  assert.deepEqual(person, {
    id: "p1",
    externalId: "4711",
    values: controlledValues,
    fingerprint: reconciliationFingerprint(controlledValues, "4711"),
  });
  assert.match(person.fingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(person.fingerprint, reconciliationFingerprint(controlledValues, "4712"));
  assert.notEqual(person.fingerprint, reconciliationFingerprint({ ...controlledValues, city: "Linz" }, "4711"));
  assert.equal(JSON.stringify(person).includes("secret"), false);
  assert.equal(JSON.stringify(person).includes("private"), false);
  assert.equal(JSON.stringify(person).includes("ada.login"), true);
});

test("update has a strict shape and returns canonical exact values", () => {
  assert.deepEqual(validateReconciliationRequest({
    action: "update",
    personId: " p1 ",
    expectedFingerprint: fingerprint.toUpperCase(),
    externalId: " 4711 ",
    changes: { email: " ADA@EXAMPLE.TEST ", role: "PLAYER B", firstName: " Ada " },
  }), {
    action: "update",
    personId: "p1",
    expectedFingerprint: fingerprint,
    externalId: "4711",
    changes: { email: "ada@example.test", role: "player B", firstName: "Ada" },
  });
  assert.throws(() => validateReconciliationRequest({
    action: "update", personId: "p1", expectedFingerprint: fingerprint, externalId: "1", changes: { login: "ada.login" },
  }), { code: "VALIDATION_ERROR" });
  assert.throws(() => validateReconciliationRequest({
    action: "update", personId: "p1", expectedFingerprint: fingerprint, externalId: "1", changes: {}, operationId: "outside-domain",
  }), { code: "VALIDATION_ERROR" });
  assert.throws(() => validateReconciliationRequest({
    action: "update", personId: "p1", expectedFingerprint: fingerprint, externalId: "1", changes: {}, password: "secret",
  }), { code: "VALIDATION_ERROR" });
});

test("update permits empty changes only for a new CD-ID link", () => {
  const request = validateReconciliationRequest({
    action: "update", personId: "p1", expectedFingerprint: fingerprint, externalId: "4711", changes: {},
  });
  assert.doesNotThrow(() => assertUpdateCandidate({ id: "p1", externalId: "" }, request));
  assert.throws(() => assertUpdateCandidate({ id: "p1", externalId: "4711" }, request), { code: "VALIDATION_ERROR" });
});

test("external IDs reject ambiguous numeric forms and uniqueness conflicts", () => {
  const update = (externalId) => validateReconciliationRequest({
    action: "update", personId: "p1", expectedFingerprint: fingerprint, externalId, changes: { city: "Linz" },
  });
  for (const invalid of ["", "001", "+1", "1.0", "1e3", "1-2", 123]) {
    assert.throws(() => update(invalid), { code: "VALIDATION_ERROR" });
  }
  assert.throws(() => assertUniqueExternalId([
    { id: "p1", externalId: "123" },
    { id: "p2", externalId: "456" },
  ], "123", "p2"), { code: "EXTERNAL_ID_CONFLICT" });
  assert.doesNotThrow(() => assertUniqueExternalId([{ id: "p1", externalId: "123" }], "123", "p1"));
});

test("create requires lastName, role, active 1 and only controlled canonical values", () => {
  assert.deepEqual(validateReconciliationRequest({
    action: "create",
    externalId: "99",
    values: { firstName: " Ada ", lastName: " Admin ", email: " ADA@EXAMPLE.TEST ", login: "ADA.LOGIN", role: "PLAYER A", active: " 1 " },
  }), {
    action: "create",
    externalId: "99",
    values: { firstName: "Ada", lastName: "Admin", email: "ada@example.test", login: "ada.login", role: "player A", active: "1" },
  });
  for (const values of [
    { role: "player", active: "1" },
    { lastName: "Admin", active: "1" },
    { lastName: "Admin", role: "player" },
    { lastName: "Admin", role: "player", active: "" },
  ]) {
    assert.throws(() => validateReconciliationRequest({ action: "create", externalId: "99", values }), { code: "VALIDATION_ERROR" });
  }
  assert.throws(() => validateReconciliationRequest({
    action: "create", externalId: "99", values: { lastName: "Admin", role: "owner", active: "1" },
  }), { code: "VALIDATION_ERROR" });
  assert.throws(() => validateReconciliationRequest({
    action: "create", externalId: "99", values: { lastName: "Admin", role: "admin", active: "1" },
  }), { code: "VALIDATION_ERROR" });
  assert.throws(() => validateReconciliationRequest({
    action: "create", externalId: "99", values: { lastName: "Admin", role: "player", active: "1", id: "p1" },
  }), { code: "VALIDATION_ERROR" });
});

test("update accepts only active imported members and player roles", () => {
  const base = { action: "update", personId: "p1", expectedFingerprint: fingerprint, externalId: "99" };
  assert.throws(() => validateReconciliationRequest({ ...base, changes: { active: "" } }), { code: "VALIDATION_ERROR" });
  assert.throws(() => validateReconciliationRequest({ ...base, changes: { role: "operator" } }), { code: "VALIDATION_ERROR" });
});

test("deactivate accepts only personId and fingerprint", () => {
  assert.deepEqual(validateReconciliationRequest({
    action: "deactivate", personId: "p1", expectedFingerprint: fingerprint,
  }), { action: "deactivate", personId: "p1", expectedFingerprint: fingerprint });
  for (const extra of [{ externalId: "1" }, { values: {} }, { changes: { active: "" } }]) {
    assert.throws(() => validateReconciliationRequest({
      action: "deactivate", personId: "p1", expectedFingerprint: fingerprint, ...extra,
    }), { code: "VALIDATION_ERROR" });
  }
  assert.throws(() => validateReconciliationRequest({ action: "delete", personId: "p1" }), { code: "VALIDATION_ERROR" });
});
