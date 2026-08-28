const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const {
  acquireExclusiveSheetActivity,
  acquireSheetTableActivity,
  executeSheetRead,
  getSheetReadStatus,
  resetSheetReadCoordinatorForTests,
  setSheetReadNowForTests,
} = require("../sheetsReadCoordinator.js");

test.beforeEach(() => resetSheetReadCoordinatorForTests());

test("Google-429 startet einen gemeinsamen Cooldown ohne weitere API-Versuche", async () => {
  let now = 1000;
  let calls = 0;
  let options;
  setSheetReadNowForTests(() => now);
  await assert.rejects(executeSheetRead({
    method: "values_get",
    purpose: "write_precondition",
    call: async (requestOptions) => {
      calls++;
      options = requestOptions;
      throw Object.assign(new Error("quota"), { response: { status: 429 } });
    },
  }), (error) => error.code === "SHEETS_RATE_LIMITED" && error.details.retryAfterMs === 60000);
  assert.deepEqual(options.retryConfig.statusCodesToRetry, [[100, 199], [408, 408], [500, 599]]);
  assert.equal(getSheetReadStatus().retryAfterMs, 60000);

  await assert.rejects(executeSheetRead({
    method: "values_batch_get",
    purpose: "initial",
    call: async () => { calls++; },
  }), (error) => error.code === "SHEETS_RATE_LIMITED" && error.details.retryAfterMs === 60000);
  assert.equal(calls, 1);

  now += 60000;
  const result = await executeSheetRead({
    method: "values_batch_get",
    purpose: "initial",
    call: async () => { calls++; return "ok"; },
  });
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("exklusiver Gesamtimport wartet auf Writes und blockiert neue Tabellenarbeit", async () => {
  const releaseWrite = await acquireSheetTableActivity("players");
  let exclusiveAcquired = false;
  const exclusive = acquireExclusiveSheetActivity().then((release) => {
    exclusiveAcquired = true;
    return release;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exclusiveAcquired, false);

  let secondWriteAcquired = false;
  const secondWrite = acquireSheetTableActivity("entryList").then((release) => {
    secondWriteAcquired = true;
    return release;
  });
  releaseWrite();
  const releaseExclusive = await exclusive;
  assert.equal(secondWriteAcquired, false);
  releaseExclusive();
  const releaseSecondWrite = await secondWrite;
  assert.equal(secondWriteAcquired, true);
  releaseSecondWrite();
});
