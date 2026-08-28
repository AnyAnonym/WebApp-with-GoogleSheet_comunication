const { google } = require("googleapis");
const {
  SHEET_ID,
  SHEET_STARTUP_RETRY_BASE_MS,
  SHEET_STARTUP_RETRY_MAX_MS,
  TABLE_CONFIG,
} = require("./config.js");
const dataStore = require("./dataStore.js");
const { AppError } = require("./errors.js");
const logger = require("./logger.js");
const metrics = require("./metrics.js");
const {
  acquireExclusiveSheetActivity,
  executeSheetRead,
  resetSheetReadCoordinatorForTests,
} = require("./sheetsReadCoordinator.js");
const { validateTableValues } = require("./tableSchemas.js");

const TABLE_NAMES = Object.freeze(Object.keys(TABLE_CONFIG));
let sheetsClient = null;
let sheetsClientFactory = null;
let recoveryTimer = null;
let recoveryAttempt = 0;
let activeLoad = null;
let stopping = false;
let lastAttemptAt = 0;
let lastSuccessAt = 0;
let lastFailure = null;

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

function errorCodeOf(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  if (/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  const status = Number(error?.response?.status || error?.status || 0);
  if (Number.isInteger(status) && status >= 100 && status <= 599) return `HTTP_${status}`;
  return "SHEETS_REFRESH_FAILED";
}

function purposeFor(trigger) {
  if (trigger === "startup") return "initial";
  if (trigger === "startup_recovery") return "startup_recovery";
  return "admin_refresh";
}

async function fetchAllTables(trigger) {
  const sheets = await getSheetsClient();
  const response = await executeSheetRead({
    method: "values_batch_get",
    purpose: purposeFor(trigger),
    call: (options) => sheets.spreadsheets.values.batchGet({
      spreadsheetId: SHEET_ID,
      ranges: TABLE_NAMES.map((tableName) => TABLE_CONFIG[tableName].range),
    }, options),
  });
  const valueRanges = response.data.valueRanges || [];
  if (valueRanges.length !== TABLE_NAMES.length) {
    throw new AppError("SHEET_SCHEMA", "Die Tabellenantwort ist unvollstaendig", 503);
  }
  return Object.fromEntries(TABLE_NAMES.map((tableName, index) => [
    tableName,
    validateTableValues(tableName, valueRanges[index]?.values || []),
  ]));
}

function markStartupFailure(error) {
  const startedAt = Date.now();
  return TABLE_NAMES.map((table) => {
    const stored = dataStore.markError(table, error);
    const result = {
      table,
      success: false,
      result: "failed",
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode: stored.lastError.code,
      errorSequence: stored.consecutiveErrors,
      outageDurationMs: stored.outageDurationMs,
    };
    metrics.recordSheetTableLoad(result);
    return result;
  });
}

async function loadAll(trigger, { preserveLastGood = false } = {}) {
  if (stopping) throw new AppError("SHUTTING_DOWN", "Server wird beendet", 503);
  if (activeLoad) throw new AppError("REFRESH_IN_PROGRESS", "Eine Datenaktualisierung laeuft bereits", 409);
  const startedAt = Date.now();
  lastAttemptAt = startedAt;
  logger.log("info", "sheets_full_refresh_started", { trigger, tableCount: TABLE_NAMES.length });
  activeLoad = (async () => {
    const release = await acquireExclusiveSheetActivity();
    try {
      const valuesByTable = await fetchAllTables(trigger);
      const results = dataStore.setAllAuthoritative(valuesByTable, { source: trigger });
      if (!results) throw new AppError("DATA_REFRESH_CONFLICT", "Datenaktualisierung kollidierte mit einer neueren Aenderung", 409);
      const refreshedAt = Date.now();
      lastSuccessAt = refreshedAt;
      lastFailure = null;
      if (trigger === "admin" && recoveryTimer) {
        clearTimeout(recoveryTimer);
        recoveryTimer = null;
        recoveryAttempt = 0;
      }
      for (const result of results) {
        metrics.recordSheetTableLoad({ table: result.table, result: result.result, durationMs: refreshedAt - startedAt });
      }
      const changedTables = results.filter((result) => result.changed).map((result) => result.table);
      metrics.recordSheetRefresh({ trigger, result: "success", durationMs: refreshedAt - startedAt });
      logger.log("info", "sheets_full_refresh_completed", {
        trigger,
        result: "success",
        tableCount: results.length,
        changedTables,
        durationMs: refreshedAt - startedAt,
      });
      return { success: true, results, refreshedAt, tableCount: results.length, changedTables };
    } catch (error) {
      const errorCode = errorCodeOf(error);
      lastFailure = {
        at: Date.now(),
        code: errorCode,
        message: "Die Sheet-Daten konnten nicht aktualisiert werden.",
        supportId: null,
      };
      const results = preserveLastGood ? [] : markStartupFailure(error);
      metrics.recordSheetRefresh({ trigger, result: "failed", durationMs: Date.now() - startedAt });
      logger.log("warn", "sheets_full_refresh_failed", {
        trigger,
        result: "failed",
        tableCount: TABLE_NAMES.length,
        durationMs: Date.now() - startedAt,
        errorCode,
        retainedLastGood: preserveLastGood && dataStore.isReady(),
      });
      if (preserveLastGood) {
        throw new AppError("DATA_REFRESH_FAILED", "Datenaktualisierung fehlgeschlagen; der letzte gueltige Stand bleibt aktiv", 503, {
          lastSuccessfulRefreshAt: lastSuccessAt || null,
        });
      }
      return { success: false, results, errorCode };
    } finally {
      release();
    }
  })();
  try {
    return await activeLoad;
  } finally {
    activeLoad = null;
  }
}

async function initialLoad() {
  return loadAll("startup");
}

function retryDelay() {
  const exponential = Math.min(SHEET_STARTUP_RETRY_MAX_MS, SHEET_STARTUP_RETRY_BASE_MS * (2 ** Math.max(0, recoveryAttempt - 1)));
  return Math.round(exponential * (0.8 + Math.random() * 0.4));
}

function scheduleRecovery() {
  if (stopping || recoveryTimer || dataStore.isReady()) return;
  recoveryAttempt++;
  const delayMs = retryDelay();
  recoveryTimer = setTimeout(async () => {
    recoveryTimer = null;
    try {
      const result = await loadAll("startup_recovery");
      if (result.success) {
        const attempts = recoveryAttempt;
        recoveryAttempt = 0;
        logger.log("info", "sheets_startup_recovery_completed", { result: "success", attempts, tableCount: TABLE_NAMES.length });
        return;
      }
    } catch (error) {
      if (error.code !== "SHUTTING_DOWN") logger.log("warn", "sheets_startup_recovery_failed", { errorCode: error.code || "SHEETS_REFRESH_FAILED" });
    }
    scheduleRecovery();
  }, delayMs);
  recoveryTimer.unref?.();
  logger.log("info", "sheets_startup_recovery_scheduled", { attempt: recoveryAttempt, delayMs });
}

function start(initialResult = null) {
  stopping = false;
  if (initialResult?.success === false || !dataStore.isReady()) scheduleRecovery();
}

async function refreshAll(trigger = "admin") {
  return loadAll(trigger, { preserveLastGood: true });
}

async function refresh(tableName, source = "write_refresh") {
  const config = TABLE_CONFIG[tableName];
  if (!config) throw new AppError("TABLE_UNKNOWN", `Tabelle ${tableName} ist unbekannt`, 500);
  const sheets = await getSheetsClient();
  const response = await executeSheetRead({
    method: "values_get",
    purpose: source,
    call: (options) => sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: config.range }, options),
  });
  const values = validateTableValues(tableName, response.data.values || []);
  dataStore.set(tableName, values, { source });
  return values;
}

async function stop() {
  stopping = true;
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = null;
  if (activeLoad) await activeLoad.catch(() => {});
  logger.log("info", "sheets_refresh_manager_stopped", { recoveryAttempt });
}

function getStatus() {
  const now = Date.now();
  return {
    running: Boolean(recoveryTimer),
    bootstrapRecoveryActive: Boolean(recoveryTimer) || (!dataStore.isReady() && !stopping),
    recoveryAttempt,
    isPolling: false,
    inProgress: activeLoad ? { startedAt: lastAttemptAt } : null,
    lastAttemptAt: lastAttemptAt || null,
    lastSuccessfulRefreshAt: lastSuccessAt || null,
    dataAgeMs: lastSuccessAt ? Math.max(0, now - lastSuccessAt) : null,
    lastControlledFailure: lastFailure,
    tables: dataStore.getAll(),
  };
}

function setSheetsClientFactoryForTests(factory) {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = null;
  sheetsClientFactory = factory;
  sheetsClient = null;
  recoveryAttempt = 0;
  activeLoad = null;
  stopping = false;
  lastAttemptAt = 0;
  lastSuccessAt = 0;
  lastFailure = null;
  resetSheetReadCoordinatorForTests();
}

module.exports = { getStatus, initialLoad, refresh, refreshAll, setSheetsClientFactoryForTests, start, stop };
