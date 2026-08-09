const test = require("node:test");
const assert = require("node:assert/strict");
const { peopleFixture, setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { validateTableValues } = require("../tableSchemas.js");
const logger = require("../logger.js");
const { roleValue } = require("../validators.js");

test("kritische Tabellen benoetigen ihre Vertragsspalten", () => {
  assert.throws(() => validateTableValues("matches1", [["ID"]]), { code: "SHEET_SCHEMA" });
  assert.throws(() => validateTableValues("players", []), { code: "SHEET_SCHEMA" });
  assert.throws(() => validateTableValues("entryList", [["ID", "BewerbID", "PersonenID", "Datum"]]), { code: "SHEET_SCHEMA" });
  assert.throws(() => validateTableValues("matchtyp", [["ID", "Bezeichnung"]]), { code: "SHEET_SCHEMA" });
  const entryList = [["ID", "BewerbID", "PersonenID", "Entrydate"]];
  assert.equal(validateTableValues("entryList", entryList), entryList);
  const matchtyp = [["ID", "Satztiebreak", "Entscheidender Satz"], ["1", "6-6", "MT10"]];
  assert.equal(validateTableValues("matchtyp", matchtyp), matchtyp);
});

test("Personen-IDs und kanonische E-Mail-Duplikate bleiben strukturell fatal", () => {
  const duplicate = peopleFixture();
  duplicate.push(["p1", "Duplicate", "ID", "ada@example.test", "c".repeat(64), "", "", "", "1", "admin"]);
  assert.throws(() => validateTableValues("players", duplicate), { code: "SHEET_SCHEMA" });

  const valid = peopleFixture();
  assert.equal(validateTableValues("players", valid), valid);

  const idnDuplicate = peopleFixture();
  idnDuplicate[1][3] = "üser@münchen.example";
  idnDuplicate[2][3] = "üser@xn--mnchen-3ya.example";
  assert.throws(() => validateTableValues("players", idnDuplicate), { code: "SHEET_SCHEMA" });
});

test("ungueltige Personen-E-Mails werden identifizierbar geloggt und blockieren den Load nicht", (t) => {
  const events = [];
  t.mock.method(logger, "log", (level, event, fields) => events.push({ level, event, fields }));
  const invalidEmail = peopleFixture();
  invalidEmail[1][3] = "ada@example";

  assert.equal(validateTableValues("players", invalidEmail), invalidEmail);
  for (let validation = 1; validation < 10; validation++) validateTableValues("players", invalidEmail);
  const validEmail = peopleFixture();
  assert.equal(validateTableValues("players", validEmail), validEmail);

  assert.deepEqual(events, [
    {
      level: "warn",
      event: "player_email_validation_issues",
      fields: {
        table: "players",
        affectedCount: 1,
        affected: [{ rowNumber: 2, personId: "p1", reason: "INVALID_EMAIL" }],
        omittedCount: 0,
      },
    },
    {
      level: "warn",
      event: "player_email_validation_summary",
      fields: {
        table: "players",
        affectedCount: 1,
        affected: [{ rowNumber: 2, personId: "p1", reason: "INVALID_EMAIL" }],
        omittedCount: 0,
      },
    },
    {
      level: "info",
      event: "player_email_validation_recovered",
      fields: { table: "players", previousAffectedCount: 1 },
    },
  ]);
});

test("ungueltige Personenrollen warnen einmalig und fallen auf player zurueck", (t) => {
  const warnings = [];
  t.mock.method(logger, "log", (level, event, fields) => warnings.push({ level, event, fields }));
  const invalid = peopleFixture("Court Boss");

  assert.equal(validateTableValues("players", invalid), invalid);
  assert.equal(validateTableValues("players", invalid), invalid);
  assert.equal(roleValue(invalid[1][9]), "player");
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0], {
    level: "warn",
    event: "player_role_fallback_applied",
    fields: { invalidRole: "court boss", fallbackRole: "player" },
  });
});
