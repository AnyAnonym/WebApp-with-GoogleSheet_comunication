const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { TABLE_CONFIG } = require("../config.js");
const dataPoller = require("../dataPoller.js");
const dataStore = require("../dataStore.js");
const { REQUIRED_HEADERS } = require("../tableSchemas.js");

function tableForRange(range) {
  return Object.entries(TABLE_CONFIG).find(([, config]) => config.range === range)[0];
}

function valuesFor(tableName, value = `${tableName}-1`) {
  return [REQUIRED_HEADERS[tableName], [value]];
}

function clientWithValues(valueForTable = (tableName) => valuesFor(tableName)) {
  return {
    spreadsheets: {
      values: {
        async batchGet({ ranges }) {
          return { data: { valueRanges: ranges.map((range) => ({ values: valueForTable(tableForRange(range)) })) } };
        },
        async get({ range }) {
          return { data: { values: valueForTable(tableForRange(range)) } };
        },
      },
    },
  };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Bedingung wurde nicht rechtzeitig erfuellt");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test.beforeEach(async () => {
  await dataPoller.stop();
  dataStore.resetForTests();
});

test("fehlgeschlagener Startimport wird automatisch bis zum ersten Gesamterfolg wiederholt", async () => {
  let calls = 0;
  dataPoller.setSheetsClientFactoryForTests(async () => {
    calls++;
    if (calls === 1) throw new Error("credentials unavailable");
    return clientWithValues();
  });

  const failed = await dataPoller.initialLoad();
  assert.equal(failed.success, false);
  assert.equal(dataStore.getReadiness().ready, false);
  dataPoller.start(failed);

  await waitFor(() => dataStore.getReadiness().ready);
  assert.equal(calls, 2);
  assert.equal(dataPoller.getStatus().bootstrapRecoveryActive, false);
});

test("erfolgreicher Startimport erzeugt kein periodisches Polling", async () => {
  let calls = 0;
  dataPoller.setSheetsClientFactoryForTests(async () => ({
    spreadsheets: { values: { async batchGet({ ranges }) {
      calls++;
      return { data: { valueRanges: ranges.map((range) => ({ values: valuesFor(tableForRange(range)) })) } };
    } } },
  }));

  const result = await dataPoller.initialLoad();
  dataPoller.start(result);
  await new Promise((resolve) => setTimeout(resolve, 75));

  assert.equal(result.success, true);
  assert.equal(calls, 1);
  assert.equal(dataPoller.getStatus().running, false);
  assert.equal(dataPoller.getStatus().isPolling, false);
});

test("manueller Erfolg beendet eine geplante Bootstrap-Recovery", async () => {
  let calls = 0;
  dataPoller.setSheetsClientFactoryForTests(async () => {
    calls++;
    if (calls === 1) throw new Error("credentials unavailable");
    return clientWithValues();
  });

  const failed = await dataPoller.initialLoad();
  dataPoller.start(failed);
  assert.equal(dataPoller.getStatus().bootstrapRecoveryActive, true);
  await dataPoller.refreshAll("admin");
  await new Promise((resolve) => setTimeout(resolve, 75));

  assert.equal(calls, 2);
  assert.equal(dataPoller.getStatus().bootstrapRecoveryActive, false);
  assert.equal(dataPoller.getStatus().recoveryAttempt, 0);
});

test("manueller Gesamtimport uebernimmt alle validierten Tabellen atomar", async () => {
  let suffix = "old";
  dataPoller.setSheetsClientFactoryForTests(async () => clientWithValues((tableName) => valuesFor(tableName, `${tableName}-${suffix}`)));
  await dataPoller.initialLoad();
  suffix = "new";

  const result = await dataPoller.refreshAll("admin");

  assert.equal(result.success, true);
  assert.equal(result.tableCount, Object.keys(TABLE_CONFIG).length);
  assert.deepEqual(new Set(result.changedTables), new Set(Object.keys(TABLE_CONFIG)));
  assert.deepEqual(dataStore.get("players"), valuesFor("players", "players-new"));
  assert.equal(dataPoller.getStatus().lastControlledFailure, null);
});

test("fehlgeschlagener manueller Gesamtimport behaelt den vollstaendigen Last-good-Stand", async () => {
  let invalid = false;
  dataPoller.setSheetsClientFactoryForTests(async () => clientWithValues((tableName) => (
    invalid && tableName === "navigator" ? [] : valuesFor(tableName, invalid ? "new" : "old")
  )));
  await dataPoller.initialLoad();
  const before = Object.fromEntries(Object.keys(TABLE_CONFIG).map((table) => [table, structuredClone(dataStore.get(table))]));
  invalid = true;

  await assert.rejects(dataPoller.refreshAll("admin"), (error) => error.code === "DATA_REFRESH_FAILED");

  for (const table of Object.keys(TABLE_CONFIG)) assert.deepEqual(dataStore.get(table), before[table]);
  assert.equal(dataStore.getReadiness().ready, true);
  assert.equal(dataPoller.getStatus().lastControlledFailure.code, "SHEET_SCHEMA");
});

test("paralleler Gesamtimport wird kontrolliert abgewiesen", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  dataPoller.setSheetsClientFactoryForTests(async () => ({
    spreadsheets: { values: { async batchGet({ ranges }) {
      started();
      await gate;
      return { data: { valueRanges: ranges.map((range) => ({ values: valuesFor(tableForRange(range)) })) } };
    } } },
  }));

  const first = dataPoller.initialLoad();
  await firstStarted;
  await assert.rejects(dataPoller.refreshAll("admin"), (error) => error.code === "REFRESH_IN_PROGRESS");
  release();
  assert.equal((await first).success, true);
});

test("globaler Spreadsheet-Fehler wird nur einmal angefragt", async () => {
  let calls = 0;
  dataPoller.setSheetsClientFactoryForTests(async () => ({
    spreadsheets: { values: { async batchGet() {
      calls++;
      throw Object.assign(new Error("spreadsheet missing"), { response: { status: 404 } });
    } } },
  }));

  const result = await dataPoller.initialLoad();
  assert.equal(result.results.every(({ errorCode }) => errorCode === "HTTP_404"), true);
  assert.equal(calls, 1);
});
