const test = require("node:test");
const assert = require("node:assert/strict");
const { requestContracts, validateEndpointRequest, validateEndpointResponse } = require("../contracts.js");

test("jeder RPC-Endpoint besitzt einen zentralen Requestvertrag", () => {
  assert.deepEqual(Object.keys(requestContracts).sort(), [
    "addEntryList", "addMatch", "bewerbe", "bewerbsart", "courtAssign", "courtScores",
    "courtSetActive", "entryList", "getScoreboardCourts", "matches", "matches1",
    "memberDirectory", "monitorAck", "monitorList", "monitorNavigate", "monitorProvision",
    "monitorRevoke", "monitorRotate", "monitorScroll", "monitorTarget", "myProfile", "navigator", "operationStatus",
    "players", "preMatches", "publicProfile", "readMatchRestrictions", "removeEntryList", "rlPlatzierung",
    "scoreboardSnapshot", "withdrawFromRanking",
  ]);
});

test("Endpointvertraege normalisieren Parameter und lehnen unbekannte Felder ab", () => {
  assert.deepEqual(validateEndpointRequest("matches1", { bewerbId: " cup-1 " }), { bewerbId: "cup-1" });
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

test("Endpointantworten benoetigen ein erfolgreiches Vertragsobjekt", () => {
  assert.deepEqual(validateEndpointResponse("players", { success: true, values: [] }), { success: true, values: [] });
  assert.throws(
    () => validateEndpointResponse("players", { values: [] }),
    (error) => error.code === "ENDPOINT_RESPONSE_INVALID",
  );
});
