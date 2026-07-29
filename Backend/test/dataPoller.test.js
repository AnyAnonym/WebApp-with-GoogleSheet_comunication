const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { TABLE_CONFIG } = require("../config.js");
const dataPoller = require("../dataPoller.js");
const dataStore = require("../dataStore.js");
const { REQUIRED_HEADERS } = require("../tableSchemas.js");

test("Initialload meldet Clientfehler ohne den Prozessstart zu blockieren und kann sich erholen", async () => {
  dataStore.resetForTests();
  dataPoller.setSheetsClientFactoryForTests(async () => {
    throw new Error("credentials unavailable");
  });
  const failed = await dataPoller.initialLoad();
  assert.equal(failed.success, false);
  assert.equal(failed.results.length, Object.keys(TABLE_CONFIG).length);
  assert.equal(dataStore.getReadiness().ready, false);

  dataPoller.setSheetsClientFactoryForTests(async () => ({
    spreadsheets: {
      values: {
        async get({ range }) {
          const tableName = Object.entries(TABLE_CONFIG).find(([, config]) => config.range === range)[0];
          return { data: { values: [REQUIRED_HEADERS[tableName], [`${range}-1`]] } };
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
