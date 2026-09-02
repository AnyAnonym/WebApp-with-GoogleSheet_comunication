const test = require("node:test");
const assert = require("node:assert/strict");
const { requestContracts, validateEndpointRequest, validateEndpointResponse } = require("../contracts.js");

test("jeder RPC-Endpoint besitzt einen zentralen Requestvertrag", () => {
  assert.deepEqual(Object.keys(requestContracts).sort(), [
    "acknowledgeMessage", "addEntryList", "addMatch", "adminMemberReconciliation", "adminPeopleNormalization", "bewerbe", "bewerbsart", "competitionHistory", "courtAssign", "courtScores",
    "courtSetActive", "entryList", "getScoreboardCourts", "matches", "matches1",
    "memberDirectory", "monitorAck", "monitorList", "monitorNavigate", "monitorProvision",
    "monitorRevoke", "monitorRotate", "monitorScroll", "monitorTarget", "myMessage", "myMessageSummary", "myMessages", "myProfile", "navigator", "normalizePerson", "operationStatus",
    "players", "preMatches", "publicProfile", "rankingChallengeState", "readMatchRestrictions", "reconcilePerson", "refreshSheetData", "removeEntryList", "rlPlatzierung",
    "scoreboardSnapshot", "setRankingMatchDate", "sheetDataStatus", "withdrawFromRanking", "withdrawnRankingPlayers",
  ]);
});

test("Ranglistenspieltermin akzeptiert nur operationId, Match-ID und kompaktes Datum", () => {
  const operationId = "00000000-0000-4000-8000-000000000020";
  assert.deepEqual(validateEndpointRequest("setRankingMatchDate", {
    operationId,
    matchId: "match-1",
    matchDate: "260905-1830",
  }), { operationId, matchId: "match-1", matchDate: "260905-1830" });
  assert.throws(() => validateEndpointRequest("setRankingMatchDate", {
    operationId,
    matchId: "match-1",
    matchDate: "2026-09-05T18:30",
  }), { code: "VALIDATION_ERROR" });
});

test("Mitgliederabgleich besitzt getrennte geschlossene Aktionsvertraege", () => {
  const operationId = "00000000-0000-4000-8000-000000000019";
  assert.deepEqual(validateEndpointRequest("reconcilePerson", {
    operationId,
    action: "update",
    personId: "p1",
    expectedFingerprint: "A".repeat(64),
    externalId: "1000068",
    changes: { email: " ADA@EXAMPLE.TEST ", role: "PLAYER A" },
  }), {
    operationId,
    action: "update",
    personId: "p1",
    expectedFingerprint: "a".repeat(64),
    externalId: "1000068",
    changes: { email: "ada@example.test", role: "player A" },
  });
  assert.throws(() => validateEndpointRequest("reconcilePerson", {
    operationId,
    action: "update",
    personId: "p1",
    expectedFingerprint: "a".repeat(64),
    externalId: "1000068",
    changes: { login: "ada.login" },
  }), { code: "VALIDATION_ERROR" });
  assert.throws(() => validateEndpointRequest("reconcilePerson", {
    operationId,
    action: "deactivate",
    personId: "p1",
    expectedFingerprint: "a".repeat(64),
    changes: { active: "" },
  }), { code: "VALIDATION_ERROR" });
});

test("Personennormalisierung besitzt einen geschlossenen Aenderungsvertrag", () => {
  const params = {
    operationId: "00000000-0000-4000-8000-000000000009",
    personId: "p1",
    expectedFingerprint: "a".repeat(64),
    changes: { firstName: " Ada ", email: "ADA@example.test", login: "ADA.LOGIN", role: "player a" },
  };
  assert.deepEqual(validateEndpointRequest("normalizePerson", params), {
    ...params,
    expectedFingerprint: "a".repeat(64),
    changes: { firstName: "Ada", email: "ada@example.test", login: "ada.login", role: "player A" },
  });
  for (const changes of [
    {},
    { passwdHash: "x" },
    { active: "0" },
    { gender: "4" },
    { birthDate: "2020-01-01" },
    { login: "bad login" },
  ]) {
    assert.throws(
      () => validateEndpointRequest("normalizePerson", { ...params, changes }),
      (error) => error.code === "VALIDATION_ERROR",
    );
  }
});

test("Endpointvertraege normalisieren Parameter und lehnen unbekannte Felder ab", () => {
  assert.deepEqual(validateEndpointRequest("matches1", { bewerbId: " cup-1 " }), { bewerbId: "cup-1" });
  assert.deepEqual(validateEndpointRequest("competitionHistory", { limit: 25 }), { limit: 25 });
  assert.deepEqual(validateEndpointRequest("competitionHistory", { bewerbId: " cup-1 ", cursor: "YWxsAGV2ZW50LTE" }), {
    bewerbId: "cup-1",
    cursor: "YWxsAGV2ZW50LTE",
  });
  assert.throws(() => validateEndpointRequest("competitionHistory", { cursor: "ungueltig=" }), { code: "VALIDATION_ERROR" });
  assert.throws(
    () => validateEndpointRequest("players", { secret: true }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => validateEndpointRequest("monitorScroll", {
      operationId: "00000000-0000-4000-8000-000000000001",
      monitorId: "m1",
      direction: "left",
    }),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("Court-Zuweisung erlaubt genau Match, Spielerpaarung oder leeren Platz", () => {
  const base = {
    operationId: "00000000-0000-4000-8000-000000000003",
    court: "1",
    expectedRevision: 1,
  };
  assert.deepEqual(validateEndpointRequest("courtAssign", { ...base, empty: true }), { ...base, empty: true });
  assert.deepEqual(validateEndpointRequest("courtAssign", {
    ...base,
    homePlayerIds: ["p1"],
    guestPlayerIds: ["p2"],
  }), {
    ...base,
    homePlayerIds: ["p1"],
    guestPlayerIds: ["p2"],
  });
  assert.deepEqual(validateEndpointRequest("courtAssign", {
    ...base,
    homePlayerIds: ["p1", "p2"],
    guestPlayerIds: ["p3", "p4"],
  }), {
    ...base,
    homePlayerIds: ["p1", "p2"],
    guestPlayerIds: ["p3", "p4"],
  });
  for (const params of [
    base,
    { ...base, empty: false },
    { ...base, empty: true, matchId: "m1" },
    { ...base, homePlayerIds: ["p1"] },
  ]) {
    assert.throws(
      () => validateEndpointRequest("courtAssign", params),
      (error) => error.code === "VALIDATION_ERROR",
    );
  }
});

test("Endpointantworten benoetigen ein erfolgreiches Vertragsobjekt", () => {
  assert.deepEqual(validateEndpointResponse("players", { success: true, values: [] }), { success: true, values: [] });
  assert.throws(
    () => validateEndpointResponse("players", { values: [] }),
    (error) => error.code === "ENDPOINT_RESPONSE_INVALID",
  );
});
