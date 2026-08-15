const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { TABLE_CONFIG } = require("../config.js");
const dataPoller = require("../dataPoller.js");
const dataStore = require("../dataStore.js");
const logger = require("../logger.js");
const { REQUIRED_HEADERS } = require("../tableSchemas.js");

function tableForRange(range) {
  return Object.entries(TABLE_CONFIG).find(([, config]) => config.range === range)[0];
}

function valuesFor(tableName, value = `${tableName}-1`) {
  return [REQUIRED_HEADERS[tableName], [value]];
}

test("Initialload meldet Clientfehler ohne den Prozessstart zu blockieren und kann sich erholen", async () => {
  dataStore.resetForTests();
  dataPoller.setSheetsClientFactoryForTests(async () => {
    throw new Error("credentials unavailable");
  });
  const failed = await dataPoller.initialLoad();
  assert.equal(failed.success, false);
  assert.equal(failed.results.length, Object.keys(TABLE_CONFIG).length);
  assert.equal(failed.results.every((result) => result.result === "failed"), true);
  assert.equal(failed.results.every((result) => typeof result.durationMs === "number"), true);
  assert.equal(failed.results.every((result) => result.errorCode === "SHEETS_POLL_FAILED"), true);
  assert.equal(dataStore.getReadiness().ready, false);

  dataPoller.setSheetsClientFactoryForTests(async () => ({
    spreadsheets: {
      values: {
        async get({ range }) {
          const tableName = tableForRange(range);
          return { data: { values: valuesFor(tableName, `${range}-1`) } };
        },
      },
    },
  }));
  const recovered = await dataPoller.initialLoad();
  assert.equal(recovered.success, true);
  assert.equal(dataStore.getReadiness().ready, true);
  dataPoller.start();
  assert.equal(dataPoller.getStatus().running, true);
  await dataPoller.stop();
});

test("ueberlappende Sheet-Loads melden ein gezaeuntes Ergebnis als ignored_stale", async () => {
  dataStore.resetForTests();
  let entryListCalls = 0;
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  dataPoller.setSheetsClientFactoryForTests(async () => ({
    spreadsheets: {
      values: {
        async get({ range }) {
          const tableName = tableForRange(range);
          if (tableName !== "entryList") return { data: { values: valuesFor(tableName) } };
          entryListCalls++;
          if (entryListCalls === 1) {
            firstStarted();
            await gate;
            return { data: { values: valuesFor(tableName, "older") } };
          }
          return { data: { values: valuesFor(tableName, "newer") } };
        },
      },
    },
  }));

  const olderLoad = dataPoller.initialLoad();
  await started;
  const newerLoad = await dataPoller.initialLoad();
  releaseFirst();
  const fencedLoad = await olderLoad;
  const olderResult = fencedLoad.results.find(({ table }) => table === "entryList");
  const newerResult = newerLoad.results.find(({ table }) => table === "entryList");

  assert.equal(olderResult.result, "ignored_stale");
  assert.equal(olderResult.success, true);
  assert.equal(newerResult.result, "applied");
  assert.deepEqual(dataStore.get("entryList"), valuesFor("entryList", "newer"));
});

test("identische Sheet-Fehler werden unterdrueckt, zusammengefasst und einmalig als Recovery geloggt", async (t) => {
  dataStore.resetForTests();
  let failing = true;
  const events = [];
  const originalLog = logger.log;
  logger.log = (level, event, fields) => {
    events.push({ level, event, fields });
    return true;
  };
  t.after(() => { logger.log = originalLog; });
  dataPoller.setSheetsClientFactoryForTests(async () => ({
    spreadsheets: {
      values: {
        async get({ range }) {
          const tableName = tableForRange(range);
          if (tableName === "entryList" && failing) {
            throw Object.assign(new Error("temporarily unavailable"), { code: "ETIMEDOUT" });
          }
          return { data: { values: valuesFor(tableName) } };
        },
      },
    },
  }));

  let failedResult;
  for (let attempt = 0; attempt < 10; attempt++) {
    const load = await dataPoller.initialLoad();
    failedResult = load.results.find(({ table }) => table === "entryList");
  }
  assert.equal(failedResult.result, "failed");
  assert.equal(failedResult.errorCode, "ETIMEDOUT");
  assert.equal(failedResult.errorSequence, 10);

  failing = false;
  const recoveredLoad = await dataPoller.initialLoad();
  const recovered = recoveredLoad.results.find(({ table }) => table === "entryList");
  assert.equal(recovered.result, "recovered");
  assert.equal(recovered.errorSequence, 10);
  assert.equal(events.filter(({ event }) => event === "sheets_table_poll_failed").length, 1);
  assert.equal(events.filter(({ event }) => event === "sheets_table_poll_failure_summary").length, 1);
  assert.equal(events.filter(({ event }) => event === "sheets_table_poll_recovered").length, 1);
});
