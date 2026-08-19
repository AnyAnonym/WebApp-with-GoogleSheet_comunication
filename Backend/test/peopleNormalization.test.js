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
    ["ID", "Vorname", "Nachname", "GeburtsDatum", "GeschlechtID", "TelefonMobil", "E-Mail", "Land", "PLZ", "Ort", "Adresse", "Aktiv", "Role", "passwdHash", "kennwortVergessen"],
    ["p1", " Ada ", "Admin", "02.01.1990", "2", "0043 664 123 45 67", "ADA@EXAMPLE.TEST", "Österreich", "4060", "Piberbach ", "Dorf 1", "1", "Admin", "secret", "x"],
    ["p2", "Pat", "Player", "19900102", "4", "unbekannt", "invalid", "", "A-4060", "Ort", "", "0", "", "secret-2", ""],
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
      ["ROLE_NONCANONICAL", "admin"],
    ],
  );
  assert.deepEqual(result.people[1].issues.map((entry) => entry.code), [
    "BIRTH_DATE_INVALID",
    "GENDER_INVALID",
    "PHONE_FORMAT_INVALID",
    "EMAIL_INVALID",
    "POSTAL_CODE_INVALID",
    "ACTIVE_NONCANONICAL",
    "ROLE_INVALID",
  ]);
  assert.match(result.people[0].fingerprint, /^[0-9a-f]{64}$/);

  const summary = summarizePeopleNormalization(table);
  assert.deepEqual(summary, {
    peopleCount: 2,
    affectedCount: 2,
    issueCount: 11,
    issueCounts: {
      EDGE_WHITESPACE: 2,
      REQUIRED_VALUE_MISSING: 0,
      BIRTH_DATE_INVALID: 1,
      GENDER_INVALID: 1,
      PHONE_FORMAT_INVALID: 1,
      EMAIL_NONCANONICAL: 1,
      EMAIL_DUPLICATE: 0,
      EMAIL_INVALID: 1,
      POSTAL_CODE_INVALID: 1,
      ACTIVE_NONCANONICAL: 1,
      ROLE_INVALID: 1,
      ROLE_NONCANONICAL: 1,
    },
  });
});

test("Telefon- und Zielwertnormalisierung folgen dem Sheetformat", () => {
  assert.equal(canonicalPhone("0043 664 123 45 67"), "0043 664 123 45 67");
  assert.equal(canonicalPhone("0043 664 1234567"), "0043 664 1234567");
  assert.equal(canonicalPhone("0049 151 123 45 67"), "0049 151 123 45 67");
  assert.equal(canonicalPhone("+43 664 1234567"), null);
  assert.equal(canonicalPhone("0043 664/1234567"), null);
  assert.equal(canonicalPhone("0664 1234567"), null);
  assert.equal(canonicalPhone("123"), null);
  assert.deepEqual(validateChanges({ phone: "0043 664 123 45 67", role: "PLAYER B" }), {
    phone: "0043 664 123 45 67",
    role: "player B",
  });
  assert.throws(() => validateChanges({ phone: "+43 664 1234567" }), { code: "VALIDATION_ERROR" });
});

test("Auditprojektion zeigt nur kontrollierte Statuswerte und Feldnamen", () => {
  assert.equal(normalizationAuditSummary(
    { firstName: "Peter", email: "old@example.test", active: "0", role: "player" },
    { firstName: "Patrick", email: "new@example.test", active: "", role: "player B" },
  ), "Vorname geaendert; E-Mail geaendert; Aktiv: 0 -> leer; Rolle: player -> player B");
  assert.equal(normalizationAuditSummary(
    { active: "freier-geheimwert", role: "eigentuemer" },
    { active: "1", role: "admin" },
  ), "Aktiv: ungueltig -> 1; Rolle: ungueltig -> admin");
  assert.equal(normalizationAuditSummary({ active: "1" }, { active: "1" }), "Keine Wertaenderung");
  assert.equal(normalizationAuditSummary(null, { role: "operator" }), "Rolle: unbekannt -> operator");
});
