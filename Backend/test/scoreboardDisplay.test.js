const test = require("node:test");
const assert = require("node:assert/strict");

const { projectScoreboardScores } = require("../scoreboardDisplay.js");

const matchtypen = [
  ["ID", "Bezeichnung", "Satztiebreak", "Entscheidender Satz"],
  ["1", "Normal", "6-6", "vollstaendiger Satz"],
  ["2", "Kurzsatz", "3-3", "MT10"],
  ["3", "Match-Tie-Break 7", "6-6", "MT7"],
];

function scores(overrides = {}) {
  return {
    revision: 3,
    source: { active: true },
    courts: [{
      platz: "1",
      satz1home: "0", satz1gast: "0",
      satz2home: "0", satz2gast: "0",
      satz3home: "0", satz3gast: "0",
      punktehome: "15", punktegast: "30",
      ...overrides,
    }],
  };
}

function project(scoreSnapshot, matchtypId = "") {
  return projectScoreboardScores(scoreSnapshot, {
    courts: { "1": { matchId: "m1", bewerbId: "cup-1", matchtypId: matchtypId || "1" } },
    matchtypen,
  });
}

test("Satz-Tie-Break verwendet die dritte Drehspalte als Punktestand", () => {
  const input = scores({
    satz1home: "6", satz1gast: "6",
    satz3home: "4", satz3gast: "2",
  });

  const result = project(input);

  assert.equal(result.courts[0].satz3home, "0");
  assert.equal(result.courts[0].satz3gast, "0");
  assert.equal(result.courts[0].punktehome, "4");
  assert.equal(result.courts[0].punktegast, "2");
  assert.equal(input.courts[0].satz3home, "4");
  assert.equal(input.courts[0].punktehome, "15");
});

test("Persistierter Matchtyp bestimmt die Tie-Break-Regel", () => {
  const result = project(scores({
    satz2home: "3", satz2gast: "3",
    satz3home: "5", satz3gast: "4",
  }), "2");

  assert.equal(result.courts[0].satz3home, "0");
  assert.equal(result.courts[0].punktehome, "5");
  assert.equal(result.courts[0].punktegast, "4");
  assert.equal(result.courts[0].satz3matchtiebreak, true);
});

test("MT7 markiert den dritten Satz ebenfalls als Match-Tie-Break", () => {
  assert.equal(project(scores(), "3").courts[0].satz3matchtiebreak, true);
});

test("Dritter Entscheidungssatz und normale Punkte bleiben unveraendert", () => {
  const input = scores({
    satz1home: "6", satz1gast: "4",
    satz2home: "4", satz2gast: "6",
    satz3home: "6", satz3gast: "6",
  });

  assert.deepEqual(project(input), {
    ...input,
    courts: [{ ...input.courts[0], satz3matchtiebreak: false }],
  });
});
