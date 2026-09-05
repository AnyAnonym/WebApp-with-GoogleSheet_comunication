const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { analyzeMatchRules, parseParticipant } = require("../matchRules.js");

const header = [
  "Ignore", "ID", "MatchDate", "MatchEnde", "ForderungDate", "BewerbID", "BewerbRunde",
  "Spieler1ID", "Spieler2ID", "Spieler3ID", "Spieler4ID", "Ergebnis",
];

test("Matchregeln verwenden das neueste gueltige Ergebnis und ignorieren markierte Zeilen", () => {
  const values = [
    header,
    ["", "new", "260727-1200", "260727-1400", "", "cup-1", "", "p1", "", "p3", "", "4-6/4-6"],
    ["", "old", "260725-1200", "260725-1400", "", "cup-1", "", "p1", "", "p2", "", "6-4/6-4"],
    ["1", "ignored", "260728-1100", "260728-1200", "", "cup-1", "", "p1", "", "p3", "", "6-0/6-0"],
    ["", "walkover", "260727-1300", "260727-1310", "", "cup-1", "", "p4 [wo]", "", "p5", "", ""],
    ["", "open", "", "", "260728-1000", "cup-1", "", "p6", "", "p7", "", ""],
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

test("Matchmarker akzeptieren ausschliesslich die exakten Schreibweisen [wo] und [ret]", () => {
  assert.deepEqual(parseParticipant("p1 [wo]"), { id: "p1", retired: true });
  assert.deepEqual(parseParticipant("p2 [ret]"), { id: "p2", retired: true });
  assert.deepEqual(parseParticipant("p3 [w.o.]"), { id: "p3 [w.o.]", retired: false });
  assert.deepEqual(parseParticipant("p4 [WO]"), { id: "p4 [WO]", retired: false });
  assert.deepEqual(parseParticipant("p5 [RET]"), { id: "p5 [RET]", retired: false });
  assert.deepEqual(parseParticipant("p6 [wo] text"), { id: "p6 [wo] text", retired: false });
});

test("nicht kanonische Walkover-Schreibweisen schliessen ein Match nicht ab", () => {
  const rules = analyzeMatchRules([
    header,
    ["", "legacy", "260727-1300", "", "", "cup-1", "", "p1 [w.o.]", "", "p2", "", ""],
  ], "cup-1", new Date(2026, 6, 28, 12, 0));

  assert.deepEqual([...rules.busyIds].sort(), ["p1 [w.o.]", "p2"]);
  assert.equal(rules.protection.size, 0);
  assert.equal(rules.blocked.size, 0);
});

test("Abschlussmarker eines Doppelpartners beenden das Match fuer beide Teams", () => {
  const rules = analyzeMatchRules([
    header,
    ["", "double", "260727-1300", "260727-1400", "", "cup-1", "", "p1", "p2 [ret]", "p3", "p4", ""],
  ], "cup-1", new Date(2026, 6, 28, 12, 0));

  assert.deepEqual([...rules.busyIds], []);
  assert.deepEqual([...rules.blocked.keys()].sort(), ["p1", "p2"]);
  assert.deepEqual([...rules.protection.keys()].sort(), ["p3", "p4"]);
});

test("MatchEnde hat fuer abgeschlossene Matches Vorrang vor MatchDate", () => {
  const rules = analyzeMatchRules([
    header,
    ["", "completed", "260701-1200", "260727-1400", "", "cup-1", "", "p1", "", "p2", "", "6-0/6-0"],
  ], "cup-1", new Date(2026, 6, 28, 12, 0));

  assert.equal(rules.protection.has("p1"), true);
  assert.equal(rules.blocked.has("p2"), true);
});

test("historische abgeschlossene Matches ohne MatchEnde verwenden MatchDate", () => {
  const rules = analyzeMatchRules([
    header,
    ["", "legacy", "260727-1400", "", "", "cup-1", "", "p1", "", "p2", "", "6-0/6-0"],
  ], "cup-1", new Date(2026, 6, 28, 12, 0));

  assert.equal(rules.protection.has("p1"), true);
  assert.equal(rules.blocked.has("p2"), true);
});

test("ungueltiges nichtleeres MatchEnde faellt nicht auf MatchDate zurueck", () => {
  assert.throws(() => analyzeMatchRules([
    header,
    ["", "bad", "260727-1200", "invalid", "", "cup-1", "", "p1", "", "p2", "", "6-0/6-0"],
  ], "cup-1"), { code: "MATCH_DATA_INVALID" });
});

test("abgeschlossene Matches ohne MatchEnde und MatchDate sperren die Regelauswertung", () => {
  assert.throws(() => analyzeMatchRules([
    header,
    ["", "bad", "", "", "", "cup-1", "", "p1 [wo]", "", "p2", "", ""],
  ], "cup-1"), { code: "MATCH_DATA_INVALID" });
});
