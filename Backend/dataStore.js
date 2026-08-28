const { TABLE_CONFIG } = require("./config.js");
const { hashPayload } = require("./security.js");
const logger = require("./logger.js");

const store = {};
const listeners = new Set();

for (const key of Object.keys(TABLE_CONFIG)) {
  store[key] = {
    values: [],
    fingerprint: hashPayload([]),
    revision: 0,
    lastAttempt: 0,
    lastUpdate: 0,
    lastMutation: 0,
    lastError: null,
    loadCount: 0,
    readSequence: 0,
    appliedReadSequence: 0,
    mutationVersion: 0,
    staleResultCount: 0,
    consecutiveErrors: 0,
    failureStartedAt: 0,
  };
}

function errorCodeOf(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  if (/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  const status = Number(error?.response?.status || error?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) return `HTTP_${status}`;
  return error?.name === "AbortError" ? "ABORTED" : "SHEETS_READ_FAILED";
}

function set(tableName, values, {
  source = "read",
  readToken = null,
  authoritative = true,
  fence = source.startsWith("write"),
  mutation = source === "write" || source === "write-local",
  notify = true,
} = {}) {
  const entry = store[tableName];
  if (!entry) return null;
  if (readToken && (
    readToken.mutationVersion !== entry.mutationVersion ||
    readToken.sequence < entry.appliedReadSequence
  )) {
    entry.staleResultCount++;
    return { ...getMeta(tableName), result: "ignored_stale", ignored: true };
  }
  if (readToken) entry.appliedReadSequence = readToken.sequence;
  if (fence) entry.mutationVersion++;
  const nextValues = Array.isArray(values) ? values : [];
  const fingerprint = hashPayload(nextValues);
  const changed = fingerprint !== entry.fingerprint;
  const recovered = authoritative && entry.consecutiveErrors > 0;
  const recoveredErrorCode = entry.lastError?.code || null;
  const recoveredErrorSequence = entry.consecutiveErrors;
  const now = Date.now();
  const outageDurationMs = recovered ? Math.max(0, now - entry.failureStartedAt) : 0;
  entry.values = nextValues;
  entry.fingerprint = fingerprint;
  entry.lastAttempt = now;
  if (mutation) entry.lastMutation = now;
  if (authoritative) {
    entry.lastUpdate = entry.lastAttempt;
    entry.lastError = null;
    entry.consecutiveErrors = 0;
    entry.failureStartedAt = 0;
    entry.loadCount++;
  }
  if (changed) entry.revision++;
  const snapshot = {
    ...getMeta(tableName),
    changed,
    result: recovered ? "recovered" : "applied",
    recoveredErrorCode,
    recoveredErrorSequence,
    outageDurationMs,
  };
  if (notify && (changed || recovered)) notifyListeners(tableName, source, changed, recovered, snapshot);
  return snapshot;
}

function notifyListeners(tableName, source, changed, recovered, snapshot) {
  for (const listener of listeners) {
    try {
      listener({ table: tableName, source, changed, recovered, current: isTableCurrent(tableName), ...snapshot });
    } catch (error) {
      logger.log("error", "data_change_listener_failed", { table: tableName, source, error });
    }
  }
}

function setAllAuthoritative(valuesByTable, { source = "refresh", readTokens = {} } = {}) {
  const tableNames = Object.keys(TABLE_CONFIG);
  if (!valuesByTable || tableNames.some((tableName) => !Array.isArray(valuesByTable[tableName]))) return null;
  const results = [];
  for (const tableName of tableNames) {
    const result = set(tableName, valuesByTable[tableName], {
      source,
      readToken: readTokens[tableName] || null,
      notify: false,
    });
    if (!result || result.ignored) return null;
    results.push({ table: tableName, ...result });
  }
  for (const result of results) {
    if (result.changed || result.result === "recovered") {
      notifyListeners(result.table, source, result.changed, result.result === "recovered", result);
    }
  }
  return results;
}

function beginRead(tableName) {
  const entry = store[tableName];
  if (!entry) return null;
  entry.lastAttempt = Date.now();
  entry.readSequence++;
  return { sequence: entry.readSequence, mutationVersion: entry.mutationVersion };
}

function markError(tableName, error, readToken = null) {
  const entry = store[tableName];
  if (!entry) return;
  if (readToken && (
    readToken.mutationVersion !== entry.mutationVersion
    || readToken.sequence < entry.appliedReadSequence
  )) {
    entry.staleResultCount++;
    return { ...getMeta(tableName), result: "ignored_stale", ignored: true };
  }
  if (readToken) entry.appliedReadSequence = readToken.sequence;
  entry.lastAttempt = Date.now();
  if (entry.consecutiveErrors === 0) entry.failureStartedAt = entry.lastAttempt;
  entry.consecutiveErrors++;
  entry.lastError = {
    at: entry.lastAttempt,
    code: errorCodeOf(error),
    message: String(error?.message || error || "Unbekannter Fehler").slice(0, 300),
  };
  const snapshot = { ...getMeta(tableName), result: "failed" };
  for (const listener of listeners) {
    try {
      listener({ table: tableName, source: "read-error", changed: false, recovered: false, current: isTableCurrent(tableName), ...snapshot });
    } catch (listenerError) {
      logger.log("error", "data_error_listener_failed", { table: tableName, error: listenerError });
    }
  }
  return snapshot;
}

function get(tableName) {
  return store[tableName]?.values || [];
}

function getMeta(tableName) {
  const entry = store[tableName];
  if (!entry) return null;
  return {
    lastAttempt: entry.lastAttempt,
    lastUpdate: entry.lastUpdate,
    lastMutation: entry.lastMutation,
    lastError: entry.lastError,
    loadCount: entry.loadCount,
    revision: entry.revision,
    rowCount: entry.values.length,
    staleResultCount: entry.staleResultCount,
    consecutiveErrors: entry.consecutiveErrors,
    failureStartedAt: entry.failureStartedAt,
    outageDurationMs: entry.failureStartedAt ? Math.max(0, Date.now() - entry.failureStartedAt) : 0,
  };
}

function getAll() {
  return Object.fromEntries(Object.keys(store).map((key) => [key, getMeta(key)]));
}

function isReady() {
  return Object.values(store).every((entry) => entry.lastUpdate > 0);
}

function isTableCurrent(tableName) {
  const entry = store[tableName];
  return Boolean(entry?.lastUpdate);
}

function getReadiness(now = Date.now()) {
  const tables = {};
  let ready = true;
  for (const name of Object.keys(TABLE_CONFIG)) {
    const meta = getMeta(name);
    const ageMs = meta.lastUpdate ? now - meta.lastUpdate : null;
    const current = meta.lastUpdate > 0;
    tables[name] = { available: current, current, ageMs, maxAge: null, lastError: meta.lastError, revision: meta.revision, consecutiveErrors: meta.consecutiveErrors };
    if (!current) ready = false;
  }
  return { ready, tables };
}

function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function resetForTests() {
  for (const key of Object.keys(store)) {
    store[key] = {
      values: [],
      fingerprint: hashPayload([]),
      revision: 0,
      lastAttempt: 0,
      lastUpdate: 0,
      lastMutation: 0,
      lastError: null,
      loadCount: 0,
      readSequence: 0,
      appliedReadSequence: 0,
      mutationVersion: 0,
      staleResultCount: 0,
      consecutiveErrors: 0,
      failureStartedAt: 0,
    };
  }
}

module.exports = { beginRead, get, getAll, getMeta, getReadiness, isReady, isTableCurrent, markError, onChange, resetForTests, set, setAllAuthoritative };
