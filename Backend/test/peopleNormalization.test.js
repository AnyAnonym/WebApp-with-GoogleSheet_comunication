const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const {
  canonicalPhone,
  normalizationAuditSummary,
  projectPeopleNormalization,
  summarizePeopleNormalization,
  validateChanges,
} = require("../peopleNormalization.js");

test("Normalisierungsprojektion zeigt nur freigegebene Werte und konkrete Probleme", () => {
  const table = [
    ["ID", "Vorname", "Nachname", "GeburtsDatum", "GeschlechtID", "TelefonMobil", "E-Mail", "Land", "PLZ", "Ort", "Adresse", "Aktiv", "Role", "Login", "passwdHash", "kennwortVergessen"],
    ["p1", " Ada ", "Admin", "02.01.1990", "2", "0043 664 123 45 67", "ADA@EXAMPLE.TEST", "Österreich", "4060", "Piberbach ", "Dorf 1", "1", "Admin", "ADA.LOGIN", "secret", "x"],
    ["p2", "Pat", "Player", "19900102", "4", "unbekannt", "invalid", "", "A-4060", "Ort", "", "0", "", " bad login ", "secret-2", ""],
  ];

  const result = projectPeopleNormalization(table);
  assert.equal(result.people.length, 2);
  assert.equal(Object.hasOwn(result.people[0].values, "passwdHash"), false);
  assert.equal(Object.hasOwn(result.people[0].values, "kennwortVergessen"), false);
  assert.deepEqual(
    result.people[0].issues.map((entry) => [entry.code, entry.proposedValue]),
    [
      ["EDGE_WHITESPACE", "Ada"],
      ["EDGE_WHITESPACE", "Piberbach"],
      ["EMAIL_NONCANONICAL", "ada@example.test"],
      ["LOGIN_NONCANONICAL", "ada.login"],
      ["ROLE_NONCANONICAL", "admin"],
    ],
  );
  assert.deepEqual(result.people[1].issues.map((entry) => entry.code), [
    "BIRTH_DATE_INVALID",
    "GENDER_INVALID",
    "PHONE_FORMAT_INVALID",
    "EMAIL_INVALID",
    "LOGIN_INVALID",
    "POSTAL_CODE_INVALID",
    "ACTIVE_NONCANONICAL",
    "ROLE_INVALID",
  ]);
  assert.equal(Object.hasOwn(result.people[1].issues.at(-1), "proposedValue"), false);
  assert.match(result.people[0].fingerprint, /^[0-9a-f]{64}$/);

  const summary = summarizePeopleNormalization(table);
  assert.deepEqual(summary, {
    peopleCount: 2,
    affectedCount: 2,
    issueCount: 13,
    issueCounts: {
      EDGE_WHITESPACE: 2,
      REQUIRED_VALUE_MISSING: 0,
      BIRTH_DATE_INVALID: 1,
      GENDER_INVALID: 1,
      PHONE_FORMAT_INVALID: 1,
      EMAIL_NONCANONICAL: 1,
      EMAIL_INVALID: 1,
      LOGIN_NONCANONICAL: 1,
      LOGIN_DUPLICATE: 0,
      LOGIN_INVALID: 1,
      POSTAL_CODE_INVALID: 1,
      ACTIVE_NONCANONICAL: 1,
      ROLE_INVALID: 1,
      ROLE_NONCANONICAL: 1,
    },
  });
});

test("Normalisierung bietet nur serverseitig gueltige Vorschlaege an", () => {
  const result = projectPeopleNormalization([
    ["ID", "Nachname", "GeburtsDatum", "GeschlechtID", "PLZ", "Role"],
    ["p1", "   ", " 2020-01-01 ", " 4 ", " A-4060 ", "unbekannt"],
  ]);
  assert.ok(result.people[0].issues.length > 0);
  assert.equal(result.people[0].issues.some((entry) => Object.hasOwn(entry, "proposedValue")), false);
});

test("Telefon- und Zielwertnormalisierung folgen dem Sheetformat", () => {
  assert.equal(canonicalPhone("0043 664 123 45 67"), "0043 664 123 45 67");
  assert.equal(canonicalPhone("0043 664 1234567"), "0043 664 1234567");
  assert.equal(canonicalPhone("0049 151 123 45 67"), "0049 151 123 45 67");
  assert.equal(canonicalPhone("+43 664 1234567"), null);
  assert.equal(canonicalPhone("0043 664/1234567"), null);
  assert.equal(canonicalPhone("0664 1234567"), null);
  assert.equal(canonicalPhone("123"), null);
  assert.deepEqual(validateChanges({ phone: "0043 664 123 45 67", login: "ADA.LOGIN", role: "PLAYER B" }), {
    phone: "0043 664 123 45 67",
    login: "ada.login",
    role: "player B",
  });
  assert.throws(() => validateChanges({ phone: "+43 664 1234567" }), { code: "VALIDATION_ERROR" });
  assert.throws(() => validateChanges({ login: "bad login" }), { code: "VALIDATION_ERROR" });
});

test("doppelte E-Mails sind erlaubt, doppelte Logins bleiben fuer Reparaturen sichtbar", () => {
  const result = projectPeopleNormalization([
    ["ID", "Nachname", "E-Mail", "Login", "Role"],
    ["p1", "Eins", "shared@example.test", "SHARED.LOGIN", "player"],
    ["p2", "Zwei", "shared@example.test", "shared.login", "player"],
  ]);
  assert.equal(result.people.flatMap((person) => person.issues).some((entry) => entry.code === "EMAIL_DUPLICATE"), false);
  assert.deepEqual(result.people.map((person) => person.issues.map((entry) => entry.code)), [
    ["LOGIN_NONCANONICAL", "LOGIN_DUPLICATE"],
    ["LOGIN_DUPLICATE"],
  ]);
});

test("GeschlechtID hat Vorrang vor dem Legacy-Header Geschlecht", () => {
  const result = projectPeopleNormalization([
    ["ID", "Geschlecht", "GeschlechtID"],
    ["p1", "1", "3"],
  ]);
  assert.equal(result.people[0].values.gender, "3");
});

test("Auditprojektion zeigt nur kontrollierte Statuswerte und Feldnamen", () => {
  assert.equal(normalizationAuditSummary(
    { firstName: "Peter", email: "old@example.test", login: "old-login", active: "0", role: "player" },
    { firstName: "Patrick", email: "new@example.test", login: "secret-login", active: "", role: "player B" },
  ), "Vorname geaendert; E-Mail geaendert; Login geaendert; Aktiv: 0 -> leer; Rolle: player -> player B");
  assert.equal(normalizationAuditSummary(
    { active: "freier-geheimwert", role: "eigentuemer" },
    { active: "1", role: "admin" },
  ), "Aktiv: ungueltig -> 1; Rolle: ungueltig -> admin");
  assert.equal(normalizationAuditSummary({ active: "1" }, { active: "1" }), "Keine Wertaenderung");
  assert.equal(normalizationAuditSummary(null, { role: "operator" }), "Rolle: unbekannt -> operator");
});
