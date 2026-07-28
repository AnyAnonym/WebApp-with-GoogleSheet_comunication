const test = require("node:test");
const assert = require("node:assert/strict");
const { peopleFixture, setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { validateTableValues } = require("../tableSchemas.js");

test("kritische Tabellen benoetigen ihre Vertragsspalten", () => {
  assert.throws(() => validateTableValues("matches1", [["ID"]]), { code: "SHEET_SCHEMA" });
  assert.throws(() => validateTableValues("players", []), { code: "SHEET_SCHEMA" });
});

test("Personen-IDs, E-Mails und Rollen werden strukturell validiert", () => {
  const duplicate = peopleFixture();
  duplicate.push(["p1", "Duplicate", "ID", "ada@example.test", "c".repeat(64), "", "", "", "1", "invalid-role"]);
  assert.throws(() => validateTableValues("players", duplicate), { code: "SHEET_SCHEMA" });

  const valid = peopleFixture();
  assert.equal(validateTableValues("players", valid), valid);
});
