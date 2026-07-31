const test = require("node:test");
const assert = require("node:assert/strict");
const { peopleFixture, setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { validateTableValues } = require("../tableSchemas.js");
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

test("Personen-IDs, E-Mails und Rollen werden strukturell validiert", () => {
  const duplicate = peopleFixture();
  duplicate.push(["p1", "Duplicate", "ID", "ada@example.test", "c".repeat(64), "", "", "", "1", "admin"]);
  assert.throws(() => validateTableValues("players", duplicate), { code: "SHEET_SCHEMA" });

  const valid = peopleFixture();
  assert.equal(validateTableValues("players", valid), valid);
});

test("ungueltige Personenrollen warnen einmalig und fallen auf player zurueck", (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  const invalid = peopleFixture("Court Boss");

  assert.equal(validateTableValues("players", invalid), invalid);
  assert.equal(validateTableValues("players", invalid), invalid);
  assert.equal(roleValue(invalid[1][9]), "player");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /court boss.*player/);
});
