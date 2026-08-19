const { google } = require("googleapis");
const {
  POLL_BASE_INTERVAL,
  POLL_FAST_MULTIPLIER,
  POLL_SLOW_MULTIPLIER,
  SHEET_ID,
  TABLE_CONFIG,
} = require("./config.js");
const dataStore = require("./dataStore.js");
const logger = require("./logger.js");
const metrics = require("./metrics.js");
const { executeSheetRead, isSheetTableActive, resetSheetReadCoordinatorForTests } = require("./sheetsReadCoordinator.js");
const { validateTableValues } = require("./tableSchemas.js");

let sheetsClient = null;
let sheetsClientFactory = null;
let tickCount = 0;
let tickTimerId = null;
let activePoll = null;
let stopping = false;
const FAILURE_SUMMARY_EVERY = 10;
const failureLogs = new Map();
const nextDueAt = new Map();

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

function pollCompleted(tableName, range, source, startedAt, readToken, rawValues) {
  try {
    const values = validateTableValues(tableName, rawValues || []);
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
    return pollFailed(tableName, range, source, startedAt, readToken, error);
  }
}

function pollFailed(tableName, range, source, startedAt, readToken, error) {
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

function purposeFor(source) {
  if (source === "initial") return "initial";
  if (source === "refresh") return "refresh";
  return "poll";
}

function statusOf(error) {
  return Number(error?.response?.status || error?.status || 0);
}

async function pollTables(sheets, tableNames, source = "poll") {
  if (!tableNames.length) return [];
  const startedAt = Date.now();
  const entries = tableNames.map((tableName) => ({
    tableName,
    range: TABLE_CONFIG[tableName].range,
    readToken: dataStore.beginRead(tableName),
  }));
  let response;
  try {
    response = await executeSheetRead({
      method: "values_batch_get",
      purpose: purposeFor(source),
      call: (options) => sheets.spreadsheets.values.batchGet({
        spreadsheetId: SHEET_ID,
        ranges: entries.map(({ range }) => range),
      }, options),
    });
  } catch (error) {
    if (entries.length > 1 && statusOf(error) === 400) {
      const middle = Math.ceil(tableNames.length / 2);
      const groups = await Promise.all([
        pollTables(sheets, tableNames.slice(0, middle), source),
        pollTables(sheets, tableNames.slice(middle), source),
      ]);
      return groups.flat();
    }
    return entries.map(({ tableName, range, readToken }) => pollFailed(tableName, range, source, startedAt, readToken, error));
  }
  const valueRanges = response.data.valueRanges || [];
  return entries.map(({ tableName, range, readToken }, index) => {
    const valueRange = valueRanges[index];
    if (!valueRange) {
      return pollFailed(tableName, range, source, startedAt, readToken, new Error(`Batchantwort fuer ${tableName} fehlt`));
    }
    return pollCompleted(tableName, range, source, startedAt, readToken, valueRange.values || []);
  });
}

async function pollTable(sheets, tableName, _range, source = "poll") {
  return (await pollTables(sheets, [tableName], source))[0];
}

async function refresh(tableName, source = "refresh") {
  const config = TABLE_CONFIG[tableName];
  if (!config) throw new Error(`Unbekannte Tabelle: ${tableName}`);
  const sheets = await getSheetsClient();
  const result = await pollTable(sheets, tableName, config.range, source);
  if (!result.success) throw new Error(result.error);
  return dataStore.get(tableName);
}

function pollInterval(tableName) {
  return POLL_BASE_INTERVAL * (TABLE_CONFIG[tableName].category === "fast" ? POLL_FAST_MULTIPLIER : POLL_SLOW_MULTIPLIER);
}

function scheduleNext(results, completedAt = Date.now()) {
  for (const result of results) {
    nextDueAt.set(result.table, completedAt + (result.success ? pollInterval(result.table) : POLL_BASE_INTERVAL));
  }
}

function synchronizeDueWithAuthoritativeReads() {
  for (const tableName of Object.keys(TABLE_CONFIG)) {
    const lastUpdate = dataStore.getMeta(tableName)?.lastUpdate || 0;
    if (!lastUpdate) continue;
    const dueFromRead = lastUpdate + pollInterval(tableName);
    if (!nextDueAt.has(tableName) || dueFromRead > nextDueAt.get(tableName)) nextDueAt.set(tableName, dueFromRead);
  }
}

async function runTick() {
  if (activePoll || stopping) return null;
  tickCount++;
  let tickResult = "completed";
  activePoll = (async () => {
    const sheets = await getSheetsClient();
    const currentTime = Date.now();
    synchronizeDueWithAuthoritativeReads();
    const dueTables = Object.keys(TABLE_CONFIG).filter((tableName) => (
      (!nextDueAt.has(tableName) || currentTime >= nextDueAt.get(tableName)) && !isSheetTableActive(tableName)
    ));
    const results = await pollTables(sheets, dueTables);
    scheduleNext(results);
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
  const results = await pollTables(sheets, Object.keys(TABLE_CONFIG), "initial");
  scheduleNext(results);
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
  nextDueAt.clear();
  resetSheetReadCoordinatorForTests();
}

module.exports = { getStatus, initialLoad, refresh, runTick, setSheetsClientFactoryForTests, start, stop };
