const test = require("node:test");
const assert = require("node:assert/strict");
const { peopleFixture, setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { assertUniquePlayerLogins, validateTableValues } = require("../tableSchemas.js");
const logger = require("../logger.js");
const { roleValue } = require("../validators.js");

test("kritische Tabellen benoetigen ihre Vertragsspalten", () => {
  assert.throws(() => validateTableValues("matches1", [["ID"]]), { code: "SHEET_SCHEMA" });
  assert.throws(() => validateTableValues("players", []), { code: "SHEET_SCHEMA" });
  assert.throws(() => validateTableValues("entryList", [["ID", "BewerbID", "PersonenID", "Datum"]]), { code: "SHEET_SCHEMA" });
  assert.throws(() => validateTableValues("matchtyp", [["ID", "Bezeichnung"]]), { code: "SHEET_SCHEMA" });
  const entryList = [["ID", "BewerbID", "PersonenID", "Entrydate"]];
  assert.equal(validateTableValues("entryList", entryList), entryList);
  const matchtyp = [["ID", "Gewinnsaetze", "Satzlaenge", "Satztiebreak", "Entscheidender Satz", "NoAd"], ["1", "2", "0-6", "6-6", "MT10", "N"]];
  assert.equal(validateTableValues("matchtyp", matchtyp), matchtyp);
  assert.throws(() => validateTableValues("rlPlatzierung", [["BewerbID", "PersonID", "Rang"]]), { code: "SHEET_SCHEMA" });
});

test("Rang null verlangt vollstaendige Raushaengedaten", () => {
  const header = ["ID", "BewerbID", "PersonID", "Rang", "RausgehangenAm", "RausgehangenLetztePlatzierung", "RausgehangenGrund"];
  const active = [header, ["r1", "ranking-1", "p1", "3", "", "", ""]];
  assert.equal(validateTableValues("rlPlatzierung", active), active);
  const withdrawn = [header, ["r1", "ranking-1", "p1", "0", "260829-1230", "3", "Verletzt"]];
  assert.equal(validateTableValues("rlPlatzierung", withdrawn), withdrawn);
  assert.throws(() => validateTableValues("rlPlatzierung", [header, ["r1", "ranking-1", "p1", "0", "", "3", "Verletzt"]]), { code: "SHEET_SCHEMA" });
  assert.throws(() => validateTableValues("rlPlatzierung", [header, ["r1", "ranking-1", "p1", "0", "260829-1230", "0", "Verletzt"]]), { code: "SHEET_SCHEMA" });
  assert.throws(() => validateTableValues("rlPlatzierung", [header, ["r1", "ranking-1", "p1", "0", "260829-1230", "3", "x"]]), { code: "SHEET_SCHEMA" });
  assert.throws(() => validateTableValues("rlPlatzierung", [header, ["r1", "ranking-1", "p1", "0", "261332-2599", "3", "Verletzt"]]), { code: "SHEET_SCHEMA" });
  assert.throws(() => validateTableValues("rlPlatzierung", [header, ["r1", "ranking-1", "p1", "2", "", "", ""], ["r2", "ranking-1", "p1", "3", "", "", ""]]), { code: "SHEET_SCHEMA" });
  assert.throws(() => validateTableValues("rlPlatzierung", [header, ["r1", "ranking-1", "p1", "2", "", "", ""], ["r2", "ranking-1", "p2", "2", "", "", ""]]), { code: "SHEET_SCHEMA" });
});

test("Bewerbe validieren Geschlechtslisten und Alterskategorien", () => {
  const header = ["ID", "Bezeichnung", "BewerbsartID", "Geschlecht", "Alterskategorie"];
  assert.equal(validateTableValues("bewerbe", [header, ["r1", "Offen", "2", "1, 2,3", "0+"]]).length, 2);
  assert.equal(validateTableValues("bewerbe", [header, ["r1", "Jugend", "2", "2", "18-"]]).length, 2);
  assert.throws(() => validateTableValues("bewerbe", [header, ["r1", "Falsch", "2", "1,4", "60+"]]), { code: "SHEET_SCHEMA" });
  assert.throws(() => validateTableValues("bewerbe", [header, ["r1", "Falsch", "2", "1", "Senioren"]]), { code: "SHEET_SCHEMA" });
});

function peopleWithLogin() {
  const values = peopleFixture();
  values[0].push("Login");
  values.slice(1).forEach((row) => row.push(row[3]));
  return values;
}

test("Personen-IDs bleiben fatal und Login ist eine Pflichtspalte", () => {
  const duplicate = peopleFixture();
  duplicate.push(["p1", "Duplicate", "ID", "ada@example.test", "c".repeat(64), "", "", "", "1", "admin"]);
  assert.throws(() => validateTableValues("players", duplicate), { code: "SHEET_SCHEMA" });

  const valid = peopleWithLogin();
  assert.equal(validateTableValues("players", valid), valid);
  assert.throws(() => validateTableValues("players", peopleFixture()), { code: "SHEET_SCHEMA" });

  const duplicateEmail = peopleWithLogin();
  duplicateEmail[2][3] = duplicateEmail[1][3];
  assert.equal(validateTableValues("players", duplicateEmail), duplicateEmail);
  assert.doesNotThrow(() => assertUniquePlayerLogins(duplicateEmail));

  duplicateEmail[2][duplicateEmail[0].indexOf("Login")] = duplicateEmail[1].at(-1).toUpperCase();
  assert.equal(validateTableValues("players", duplicateEmail), duplicateEmail);
  assert.throws(() => assertUniquePlayerLogins(duplicateEmail), { code: "LOGIN_CONFLICT" });
});

test("ungueltige Personen-Logins werden ohne Rohwerte identifizierbar geloggt und blockieren den Load nicht", (t) => {
  const events = [];
  t.mock.method(logger, "log", (level, event, fields) => events.push({ level, event, fields }));
  const invalidLogin = peopleWithLogin();
  invalidLogin[1][invalidLogin[0].indexOf("Login")] = " Ada Login ";
  invalidLogin.push([...invalidLogin[2]]);
  invalidLogin[3][0] = "p3";

  assert.equal(validateTableValues("players", invalidLogin), invalidLogin);
  for (let validation = 1; validation < 10; validation++) validateTableValues("players", invalidLogin);
  const validLogin = peopleWithLogin();
  assert.equal(validateTableValues("players", validLogin), validLogin);

  assert.deepEqual(events, [
    {
      level: "warn",
      event: "player_login_validation_issues",
      fields: {
        table: "players",
        affectedCount: 3,
        affected: [
          { rowNumber: 2, personId: "p1", reason: "INVALID_LOGIN" },
          { rowNumber: 3, personId: "p2", reason: "DUPLICATE_LOGIN" },
          { rowNumber: 4, personId: "p3", reason: "DUPLICATE_LOGIN" },
        ],
        omittedCount: 0,
      },
    },
    {
      level: "warn",
      event: "player_login_validation_summary",
      fields: {
        table: "players",
        affectedCount: 3,
        affected: [
          { rowNumber: 2, personId: "p1", reason: "INVALID_LOGIN" },
          { rowNumber: 3, personId: "p2", reason: "DUPLICATE_LOGIN" },
          { rowNumber: 4, personId: "p3", reason: "DUPLICATE_LOGIN" },
        ],
        omittedCount: 0,
      },
    },
    {
      level: "info",
      event: "player_login_validation_recovered",
      fields: { table: "players", previousAffectedCount: 3 },
    },
  ]);
});

test("ungueltige Personenrollen warnen einmalig und fallen auf player zurueck", (t) => {
  const warnings = [];
  t.mock.method(logger, "log", (level, event, fields) => warnings.push({ level, event, fields }));
  const invalid = peopleWithLogin();
  invalid[1][9] = "Court Boss";

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
