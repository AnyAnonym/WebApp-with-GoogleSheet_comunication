const test = require("node:test");
const assert = require("node:assert/strict");

const { projectScoreboardScores, snapshotMatchtypDisplayRules } = require("../scoreboardDisplay.js");

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
    courts: {
      "1": {
        matchId: "m1",
        bewerbId: "cup-1",
        matchtypId: matchtypId || "1",
        displayRules: snapshotMatchtypDisplayRules(matchtypen, matchtypId || "1"),
      },
    },
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

test("Persistierte Anzeigeregeln bestimmen Tie-Break und Entscheidungssatz", () => {
  const result = project(scores({
    satz2home: "3", satz2gast: "3",
    satz3home: "5", satz3gast: "4",
  }), "2");

  assert.equal(result.courts[0].satz3home, "0");
  assert.equal(result.courts[0].punktehome, "5");
  assert.equal(result.courts[0].punktegast, "4");
  assert.equal(result.courts[0].satz3matchtiebreak, true);
});

test("Projektion benoetigt nach dem Snapshot keine Matchtyp-Tabelle", () => {
  const displayRules = snapshotMatchtypDisplayRules(matchtypen, "2");
  const result = projectScoreboardScores(scores({
    satz2home: "3", satz2gast: "3",
    satz3home: "5", satz3gast: "4",
  }), { courts: { "1": { matchtypId: "2", displayRules } } });

  assert.equal(result.courts[0].punktehome, "5");
  assert.equal(result.courts[0].satz3matchtiebreak, true);
});

test("Ungueltige oder unpassende Anzeigeregeln werden nicht eingefroren oder angewendet", () => {
  const invalid = [["ID", "Satztiebreak", "Entscheidender Satz"], ["2", "3:3", "MT10"]];
  const asymmetric = [["ID", "Satztiebreak", "Entscheidender Satz"], ["2", "3-4", "MT10"]];
  const leadingZero = [["ID", "Satztiebreak", "Entscheidender Satz"], ["2", "03-03", "MT10"]];
  const mixedLeadingZero = [["ID", "Satztiebreak", "Entscheidender Satz"], ["2", "03-3", "MT10"]];
  assert.equal(snapshotMatchtypDisplayRules(invalid, "2"), null);
  assert.equal(snapshotMatchtypDisplayRules(asymmetric, "2"), null);
  assert.equal(snapshotMatchtypDisplayRules(leadingZero, "2").satztiebreak, "3-3");
  assert.equal(snapshotMatchtypDisplayRules(mixedLeadingZero, "2").satztiebreak, "3-3");

  const input = scores({ satz2home: "3", satz2gast: "3", satz3home: "5", satz3gast: "4" });
  const result = projectScoreboardScores(input, {
    courts: {
      "1": {
        matchtypId: "2",
        displayRules: { ...snapshotMatchtypDisplayRules(matchtypen, "2"), matchtypId: "1" },
      },
    },
  });
  assert.equal(result.courts[0].satz3home, "5");
  assert.equal(result.courts[0].punktehome, "15");
  assert.equal(result.courts[0].satz3matchtiebreak, false);
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
