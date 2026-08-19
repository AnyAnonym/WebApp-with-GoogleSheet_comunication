const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const {
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
    purpose: "poll",
    call: async () => { calls++; },
  }), (error) => error.code === "SHEETS_RATE_LIMITED" && error.details.retryAfterMs === 60000);
  assert.equal(calls, 1);

  now += 60000;
  const result = await executeSheetRead({
    method: "values_batch_get",
    purpose: "poll",
    call: async () => { calls++; return "ok"; },
  });
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});
