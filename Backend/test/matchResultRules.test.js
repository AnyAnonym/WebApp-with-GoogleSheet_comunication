const test = require("node:test");
const assert = require("node:assert/strict");

const {
  encodeCompletion,
  koRoundSuccessor,
  parseMatchTypeTable,
  parseParticipantId,
  resolveMatchType,
  validateCompletion,
} = require("../matchResultRules.js");

const matchTypes = parseMatchTypeTable([
  ["NoAd", "Entscheidender Satz", "Satzlaenge", "ID", "Satztiebreak", "Gewinnsaetze"],
  ["N", "MT10", "0-6", "1", "6-6", "2"],
  ["J", "vollstaendiger Satz", "0-4", "2", "3-3", "3"],
  ["N", "MT7", "0-6", "3", "6-6", "2"],
]);
const mt10 = matchTypes.get("1");
const shortBestOfFive = matchTypes.get("2");

test("Teilnehmer-IDs behalten die exakte Markerart und verlieren Setzmarker", () => {
  assert.deepEqual(parseParticipantId("  p1 [gesetzt] [wo] "), { id: "p1", marker: "wo" });
  assert.deepEqual(parseParticipantId("p2 [GESETZT] [ret]"), { id: "p2", marker: "ret" });
  assert.deepEqual(parseParticipantId("p3 [WO]"), { id: "p3 [WO]", marker: null });
});

test("Matchtyp-Tabelle wird streng und unabhaengig von der Spaltenreihenfolge gelesen", () => {
  assert.deepEqual(mt10, {
    id: "1", winningSets: 2, setLength: "0-6", setTarget: 6,
    setTiebreak: "6-6", decidingSet: "MT10", noAd: false,
  });
  assert.throws(() => parseMatchTypeTable([["ID"]]), { code: "MATCHTYPE_SCHEMA" });
  assert.throws(() => parseMatchTypeTable([
    ["ID", "Gewinnsaetze", "Satzlaenge", "Satztiebreak", "Entscheidender Satz", "NoAd"],
    ["4", "2", "0-4", "6-6", "MT10", "N"],
  ]), { code: "MATCHTYPE_RULES" });
  assert.throws(() => parseMatchTypeTable([
    ["ID", "Gewinnsaetze", "Satzlaenge", "Satztiebreak", "Entscheidender Satz", "NoAd"],
    ["4", "2", "4", "3-3", "MT10", "N"],
  ]), { code: "MATCHTYPE_RULES" });
});

test("Match-Ueberschreibung gewinnt vor dem Bewerbsstandard", () => {
  assert.deepEqual(resolveMatchType({ MatchtypID: "3" }, { "MatchtypID Standard": "1" }, matchTypes), {
    rules: matchTypes.get("3"), source: "match",
  });
  assert.deepEqual(resolveMatchType({}, { "MatchtypID Standard": "1" }, matchTypes), {
    rules: mt10, source: "competition",
  });
  assert.throws(() => resolveMatchType({}, { "MatchtypID Standard": "99" }, matchTypes), { code: "MATCHTYPE_NOT_FOUND" });
});

test("regulaere Ergebnisse verlangen vollstaendige gueltige Saetze und die Gewinnsatzanzahl", () => {
  const straight = validateCompletion({ kind: "regular", result: "6-3/7-6(5)" }, mt10);
  assert.equal(straight.valid, true);
  assert.equal(straight.winnerSide, 1);
  const matchTiebreak = validateCompletion({ kind: "regular", result: "6-4/3-6/10-8" }, mt10);
  assert.equal(matchTiebreak.valid, true);
  assert.equal(matchTiebreak.winnerSide, 1);
  assert.deepEqual(validateCompletion({ kind: "regular", result: "6-3" }, mt10), {
    valid: false, error: "MATCH_INCOMPLETE",
  });
  assert.equal(validateCompletion({ kind: "regular", result: "7-6/6-4" }, mt10).error, "SET_INVALID");
  assert.equal(validateCompletion({ kind: "regular", result: "6-4/4-6/10-9" }, mt10).error, "SET_INVALID");
  assert.equal(validateCompletion({ kind: "regular", result: "6-4//6-3" }, mt10).error, "RESULT_SYNTAX");
  assert.equal(validateCompletion({ kind: "regular", result: "06-3/6-4" }, mt10).error, "RESULT_SYNTAX");
  assert.equal(validateCompletion({ kind: "regular", result: "100-98/6-4" }, mt10).error, "RESULT_SYNTAX");
  assert.equal(validateCompletion({ kind: "regular", result: "7-6(05)/6-4" }, mt10).error, "RESULT_SYNTAX");
});

test("kurze Best-of-five-Saetze verwenden 3-3-Tiebreak und vollen Entscheidungssatz", () => {
  assert.equal(validateCompletion({ kind: "regular", result: "4-2/3-4(4)/4-0/4-3(8)" }, shortBestOfFive).valid, true);
  assert.equal(validateCompletion({ kind: "regular", result: "4-3/4-1/4-2" }, shortBestOfFive).error, "SET_INVALID");
});

test("Walkover verlangt Verliererseite ohne Ergebnis", () => {
  assert.deepEqual(validateCompletion({ kind: "walkover", losingSide: 1, result: "" }, mt10), {
    valid: true, kind: "walkover", result: "", losingSide: 1, winnerSide: 2, sets: [],
  });
  assert.equal(validateCompletion({ kind: "walkover", losingSide: 2, result: "0-6/0-6" }, mt10).error, "WALKOVER_RESULT");
  assert.equal(validateCompletion({ kind: "walkover", losingSide: 0 }, mt10).error, "LOSING_SIDE");
});

test("Retirement bestimmt den Gewinner und akzeptiert nur einen plausiblen Teilstand", () => {
  const retirement = validateCompletion({ kind: "retirement", losingSide: 2, result: "4-6/5-2" }, mt10);
  assert.equal(retirement.valid, true);
  assert.equal(retirement.winnerSide, 1);
  assert.equal(retirement.sets.at(-1).state, "partial");
  assert.equal(validateCompletion({ kind: "retirement", losingSide: 2, result: "6-4/6-3" }, mt10).error, "MATCH_ALREADY_COMPLETE");
  assert.equal(validateCompletion({ kind: "retirement", losingSide: 1, result: "5-2/3-1" }, mt10).error, "SET_INVALID");
  assert.equal(validateCompletion({ kind: "retirement", losingSide: 1, result: "3-3" }, mt10).valid, true);
  assert.equal(validateCompletion({ kind: "retirement", losingSide: 1, result: "" }, mt10).valid, true);
});

test("Kodierung entfernt alte Marker und markiert nur den ersten Spieler der Verliererseite", () => {
  const original = {
    ID: "m1", Spieler1ID: "p1 [gesetzt] [wo]", Spieler2ID: "p2 [ret]",
    Spieler3ID: "p3 [wo]", Spieler4ID: "p4 [ret]", Ergebnis: "6-0/6-0",
  };
  assert.deepEqual(encodeCompletion(original, { kind: "retirement", losingSide: 2, result: "6-3/2-1" }), {
    ID: "m1", Spieler1ID: "p1 [gesetzt]", Spieler2ID: "p2",
    Spieler3ID: "p3 [ret]", Spieler4ID: "p4", Ergebnis: "6-3/2-1",
  });
  assert.equal(original.Spieler3ID, "p3 [wo]");
  assert.equal(encodeCompletion(original, { kind: "walkover", losingSide: 1 }).Ergebnis, "");
});

test("KO-Nachfolger halbieren Slots und das Finale besitzt keinen Nachfolger", () => {
  assert.deepEqual(koRoundSuccessor("R1-P3", 32), { roundCode: "AF-P2", side: 1 });
  assert.deepEqual(koRoundSuccessor("R1-P4", 32), { roundCode: "AF-P2", side: 2 });
  assert.deepEqual(koRoundSuccessor("HF-P2", 8), { roundCode: "F", side: 2 });
  assert.equal(koRoundSuccessor("F", 8), null);
  assert.throws(() => koRoundSuccessor("AF-P9", 16), { code: "ROUND_CODE" });
  assert.throws(() => koRoundSuccessor("R1-P1", 12), { code: "RASTERFUNKTION" });
});
