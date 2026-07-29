const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { analyzeMatchRules } = require("../matchRules.js");

const header = [
  "Ignore", "ID", "MatchDate", "ForderungDate", "BewerbID", "BewerbRunde",
  "Spieler1ID", "Spieler2ID", "Spieler3ID", "Spieler4ID", "Ergebnis",
];

test("Matchregeln verwenden das neueste gueltige Ergebnis und ignorieren markierte Zeilen", () => {
  const values = [
    header,
    ["", "new", "260727-1200", "", "cup-1", "", "p1", "", "p3", "", "4-6/4-6"],
    ["", "old", "260725-1200", "", "cup-1", "", "p1", "", "p2", "", "6-4/6-4"],
    ["1", "ignored", "260728-1100", "", "cup-1", "", "p1", "", "p3", "", "6-0/6-0"],
    ["", "walkover", "260727-1300", "", "cup-1", "", "p4 [w.o.]", "", "p5", "", ""],
    ["", "open", "", "260728-1000", "cup-1", "", "p6", "", "p7", "", ""],
  ];
  const rules = analyzeMatchRules(values, "cup-1", new Date(2026, 6, 28, 12, 0));

  assert.equal(rules.blocked.has("p1"), true);
  assert.equal(rules.protection.has("p1"), false);
  assert.equal(rules.blocked.has("p2"), true);
  assert.equal(rules.protection.has("p3"), true);
  assert.equal(rules.blocked.has("p4"), true);
  assert.equal(rules.protection.has("p5"), true);
  assert.deepEqual([...rules.busyIds].sort(), ["p6", "p7"]);
});

test("gespielte Matches mit ungueltigem Datum sperren die Regelauswertung", () => {
  assert.throws(() => analyzeMatchRules([
    header,
    ["", "bad", "invalid", "", "cup-1", "", "p1", "", "p2", "", "6-0/6-0"],
  ], "cup-1"), { code: "MATCH_DATA_INVALID" });
});
