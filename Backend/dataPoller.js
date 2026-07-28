const { google } = require("googleapis");
const {
  GOOGLE_REQUEST_TIMEOUT_MS,
  POLL_BASE_INTERVAL,
  POLL_FAST_MULTIPLIER,
  POLL_SLOW_MULTIPLIER,
  SHEET_ID,
  TABLE_CONFIG,
} = require("./config.js");
const dataStore = require("./dataStore.js");
const { validateTableValues } = require("./tableSchemas.js");

let sheetsClient = null;
let sheetsClientFactory = null;
let tickCount = 0;
let tickTimerId = null;
let activePoll = null;
let stopping = false;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (sheetsClientFactory) {
    sheetsClient = await sheetsClientFactory();
    return sheetsClient;
  }
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

async function pollTable(sheets, tableName, range, source = "poll") {
  const readToken = dataStore.beginRead(tableName);
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
    }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
    const values = validateTableValues(tableName, response.data.values || []);
    const applied = dataStore.set(tableName, values, { source, readToken });
    return { table: tableName, success: true, ignored: !!applied?.ignored };
  } catch (error) {
    const marked = dataStore.markError(tableName, error, readToken);
    console.error(`dataPoller: Fehler beim Lesen von ${tableName} (${range}):`, error.message);
    return { table: tableName, success: false, ignored: !!marked?.ignored, error: error.message };
  }
}

async function refresh(tableName, source = "refresh") {
  const config = TABLE_CONFIG[tableName];
  if (!config) throw new Error(`Unbekannte Tabelle: ${tableName}`);
  const sheets = await getSheetsClient();
  const result = await pollTable(sheets, tableName, config.range, source);
  if (!result.success) throw new Error(result.error);
  return dataStore.get(tableName);
}

async function pollCategory(sheets, category) {
  const tables = Object.entries(TABLE_CONFIG).filter(([, config]) => config.category === category);
  return Promise.all(tables.map(([name, config]) => pollTable(sheets, name, config.range)));
}

async function runTick() {
  if (activePoll || stopping) return null;
  tickCount++;
  activePoll = (async () => {
    const sheets = await getSheetsClient();
    const fast = tickCount === 1 || tickCount % POLL_FAST_MULTIPLIER === 0;
    const slow = tickCount === 1 || tickCount % POLL_SLOW_MULTIPLIER === 0;
    let results = [];
    if (slow) {
      const groups = await Promise.all([pollCategory(sheets, "fast"), pollCategory(sheets, "slow")]);
      results = groups.flat();
    } else if (fast) {
      results = await pollCategory(sheets, "fast");
    }
    if (results.length) {
      const failed = results.filter((result) => !result.success).length;
      console.log(`dataPoller: Tick #${tickCount}, ${results.length - failed}/${results.length} Tabellen aktualisiert`);
    }
    return results;
  })();
  try {
    return await activePoll;
  } catch (error) {
    console.error("dataPoller: Tick-Fehler:", error.message);
    return null;
  } finally {
    activePoll = null;
  }
}

async function initialLoad() {
  console.log("dataPoller: Initiales Laden aller Tabellen...");
  let sheets;
  try {
    sheets = await getSheetsClient();
  } catch (error) {
    const results = Object.keys(TABLE_CONFIG).map((table) => {
      dataStore.markError(table, error);
      return { table, success: false, error: error.message };
    });
    console.error("dataPoller: Google-Client konnte nicht initialisiert werden:", error.message);
    return { success: false, results };
  }
  const results = await Promise.all(Object.entries(TABLE_CONFIG).map(
    ([name, config]) => pollTable(sheets, name, config.range, "initial"),
  ));
  const failed = results.filter((result) => !result.success);
  console.log(`dataPoller: Initiales Laden abgeschlossen (${results.length - failed.length}/${results.length}).`);
  return { success: failed.length === 0, results };
}

function start() {
  if (tickTimerId) return;
  stopping = false;
  tickCount = 0;
  tickTimerId = setInterval(runTick, POLL_BASE_INTERVAL);
  tickTimerId.unref?.();
  console.log(`dataPoller: Gestartet (Grundtakt ${POLL_BASE_INTERVAL}ms)`);
}

async function stop() {
  stopping = true;
  if (tickTimerId) clearInterval(tickTimerId);
  tickTimerId = null;
  if (activePoll) await activePoll.catch(() => {});
  console.log("dataPoller: Gestoppt");
}

function getStatus() {
  return {
    running: !!tickTimerId,
    tickCount,
    isPolling: !!activePoll,
    tables: dataStore.getAll(),
  };
}

function setSheetsClientFactoryForTests(factory) {
  sheetsClientFactory = factory;
  sheetsClient = null;
}

module.exports = { getStatus, initialLoad, refresh, runTick, setSheetsClientFactoryForTests, start, stop };
