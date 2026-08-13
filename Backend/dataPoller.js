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
const logger = require("./logger.js");
const metrics = require("./metrics.js");
const { validateTableValues } = require("./tableSchemas.js");

let sheetsClient = null;
let sheetsClientFactory = null;
let tickCount = 0;
let tickTimerId = null;
let activePoll = null;
let stopping = false;
const FAILURE_SUMMARY_EVERY = 10;
const failureLogs = new Map();

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
  const startedAt = Date.now();
  const readToken = dataStore.beginRead(tableName);
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
    }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
    const values = validateTableValues(tableName, response.data.values || []);
    const stored = dataStore.set(tableName, values, { source, readToken });
    const result = stored?.result || (stored?.ignored ? "ignored_stale" : "applied");
    const durationMs = Date.now() - startedAt;
    if (result === "recovered") {
      const failureLog = failureLogs.get(tableName);
      logger.log("info", "sheets_table_poll_recovered", {
        table: tableName,
        range,
        source,
        result,
        durationMs,
        errorCode: stored.recoveredErrorCode,
        errorSequence: stored.recoveredErrorSequence,
        outageDurationMs: stored.outageDurationMs,
        suppressedFailures: failureLog?.suppressedFailures || 0,
      });
      failureLogs.delete(tableName);
    } else {
      if (result === "applied") failureLogs.delete(tableName);
      logger.log("debug", "sheets_table_poll_completed", { table: tableName, range, source, result, durationMs });
    }
    metrics.recordSheetPoll({ table: tableName, result, durationMs });
    return {
      table: tableName,
      success: true,
      ignored: result === "ignored_stale",
      result,
      durationMs,
      errorCode: result === "recovered" ? stored.recoveredErrorCode : null,
      errorSequence: result === "recovered" ? stored.recoveredErrorSequence : 0,
      outageDurationMs: stored?.outageDurationMs || 0,
    };
  } catch (error) {
    const stored = dataStore.markError(tableName, error, readToken);
    const durationMs = Date.now() - startedAt;
    if (stored?.ignored) {
      logger.log("debug", "sheets_table_poll_completed", { table: tableName, range, source, result: "ignored_stale", durationMs });
      metrics.recordSheetPoll({ table: tableName, result: "ignored_stale", durationMs });
      return { table: tableName, success: true, ignored: true, result: "ignored_stale", durationMs, errorCode: null, errorSequence: 0, outageDurationMs: 0 };
    }
    const errorCode = stored?.lastError?.code || "SHEETS_POLL_FAILED";
    const previous = failureLogs.get(tableName);
    const sameError = previous?.errorCode === errorCode;
    const failureLog = sameError ? previous : { errorCode, occurrences: 0, suppressedFailures: 0 };
    failureLog.occurrences++;
    if (!sameError || stored.consecutiveErrors === 1) {
      logger.log("warn", "sheets_table_poll_failed", {
        table: tableName,
        range,
        source,
        result: "failed",
        durationMs,
        errorCode,
        errorSequence: stored.consecutiveErrors,
        outageDurationMs: stored.outageDurationMs,
        suppressedFailures: previous?.suppressedFailures || 0,
      });
      failureLog.suppressedFailures = 0;
    } else {
      failureLog.suppressedFailures++;
      if (failureLog.occurrences % FAILURE_SUMMARY_EVERY === 0) {
        logger.log("warn", "sheets_table_poll_failure_summary", {
          table: tableName,
          range,
          source,
          result: "failed",
          durationMs,
          errorCode,
          errorSequence: stored.consecutiveErrors,
          outageDurationMs: stored.outageDurationMs,
          suppressedFailures: failureLog.suppressedFailures,
        });
        failureLog.suppressedFailures = 0;
      }
    }
    failureLogs.set(tableName, failureLog);
    metrics.recordSheetPoll({ table: tableName, result: "failed", durationMs });
    return {
      table: tableName,
      success: false,
      ignored: false,
      result: "failed",
      durationMs,
      errorCode,
      errorSequence: stored?.consecutiveErrors || 1,
      outageDurationMs: stored?.outageDurationMs || 0,
      error: error.message,
    };
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
  let tickResult = "completed";
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
      const failed = results.filter((result) => result.result === "failed").length;
      logger.log("debug", "sheets_poll_tick_completed", {
        tick: tickCount,
        attempted: results.length,
        applied: results.filter((result) => result.result === "applied").length,
        ignoredStale: results.filter((result) => result.result === "ignored_stale").length,
        recovered: results.filter((result) => result.result === "recovered").length,
        failed,
      });
    }
    return results;
  })();
  try {
    return await activePoll;
  } catch (error) {
    tickResult = "failed";
    logger.log("error", "sheets_poll_tick_failed", { tick: tickCount, error });
    return null;
  } finally {
    metrics.recordSheetTick(tickResult);
    activePoll = null;
  }
}

async function initialLoad() {
  logger.log("info", "sheets_initial_load_started", { tableCount: Object.keys(TABLE_CONFIG).length });
  const startedAt = Date.now();
  let sheets;
  try {
    sheets = await getSheetsClient();
  } catch (error) {
    const results = Object.keys(TABLE_CONFIG).map((table) => {
      const stored = dataStore.markError(table, error);
      return {
        table,
        success: false,
        ignored: false,
        result: "failed",
        durationMs: Date.now() - startedAt,
        errorCode: stored.lastError.code,
        errorSequence: stored.consecutiveErrors,
        outageDurationMs: stored.outageDurationMs,
        error: error.message,
      };
    });
    for (const result of results) metrics.recordSheetPoll(result);
    logger.log("error", "sheets_client_initialization_failed", {
      tableCount: results.length,
      result: "failed",
      durationMs: Date.now() - startedAt,
      errorCode: results[0]?.errorCode || "SHEETS_CLIENT_INITIALIZATION_FAILED",
      errorSequence: Math.max(...results.map((result) => result.errorSequence)),
      outageDurationMs: Math.max(...results.map((result) => result.outageDurationMs)),
    });
    return { success: false, results };
  }
  const results = await Promise.all(Object.entries(TABLE_CONFIG).map(
    ([name, config]) => pollTable(sheets, name, config.range, "initial"),
  ));
  const failed = results.filter((result) => !result.success);
  logger.log(failed.length ? "warn" : "info", "sheets_initial_load_completed", {
    total: results.length,
    succeeded: results.length - failed.length,
    failed: failed.length,
    success: failed.length === 0,
  });
  return { success: failed.length === 0, results };
}

function start() {
  if (tickTimerId) return;
  stopping = false;
  tickCount = 0;
  tickTimerId = setInterval(runTick, POLL_BASE_INTERVAL);
  tickTimerId.unref?.();
  logger.log("info", "sheets_poller_started", { baseIntervalMs: POLL_BASE_INTERVAL, fastMultiplier: POLL_FAST_MULTIPLIER, slowMultiplier: POLL_SLOW_MULTIPLIER });
}

async function stop() {
  stopping = true;
  if (tickTimerId) clearInterval(tickTimerId);
  tickTimerId = null;
  if (activePoll) await activePoll.catch(() => {});
  logger.log("info", "sheets_poller_stopped", { tickCount });
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
  failureLogs.clear();
}

module.exports = { getStatus, initialLoad, refresh, runTick, setSheetsClientFactoryForTests, start, stop };
