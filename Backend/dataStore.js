const { TABLE_CONFIG, READINESS_FAST_MAX_AGE_MS, READINESS_SLOW_MAX_AGE_MS } = require("./config.js");
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
    lastError: null,
    pollCount: 0,
    readSequence: 0,
    appliedReadSequence: 0,
    mutationVersion: 0,
    staleResultCount: 0,
  };
}

function set(tableName, values, { source = "poll", readToken = null } = {}) {
  const entry = store[tableName];
  if (!entry) return null;
  if (readToken && (
    readToken.mutationVersion !== entry.mutationVersion ||
    readToken.sequence < entry.appliedReadSequence
  )) {
    entry.staleResultCount++;
    return { ...getMeta(tableName), ignored: true };
  }
  if (readToken) entry.appliedReadSequence = readToken.sequence;
  if (source === "write") entry.mutationVersion++;
  const nextValues = Array.isArray(values) ? values : [];
  const fingerprint = hashPayload(nextValues);
  const changed = fingerprint !== entry.fingerprint;
  const recovered = entry.lastError !== null;
  entry.values = nextValues;
  entry.fingerprint = fingerprint;
  entry.lastAttempt = Date.now();
  entry.lastUpdate = entry.lastAttempt;
  entry.lastError = null;
  entry.pollCount++;
  if (changed) entry.revision++;
  const snapshot = getMeta(tableName);
  if (changed || recovered) {
    for (const listener of listeners) {
      try {
        listener({ table: tableName, source, changed, recovered, current: true, ...snapshot });
      } catch (error) {
        logger.log("error", "data_change_listener_failed", { table: tableName, source, error });
      }
    }
  }
  return snapshot;
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
    return { ...getMeta(tableName), ignored: true };
  }
  if (readToken) entry.appliedReadSequence = readToken.sequence;
  entry.lastAttempt = Date.now();
  entry.lastError = {
    at: entry.lastAttempt,
    message: String(error?.message || error || "Unbekannter Fehler").slice(0, 300),
  };
  const snapshot = getMeta(tableName);
  for (const listener of listeners) {
    try {
      listener({ table: tableName, source: "poll-error", changed: false, recovered: false, current: isTableCurrent(tableName), ...snapshot });
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
    lastError: entry.lastError,
    pollCount: entry.pollCount,
    revision: entry.revision,
    rowCount: entry.values.length,
    staleResultCount: entry.staleResultCount,
  };
}

function getAll() {
  return Object.fromEntries(Object.keys(store).map((key) => [key, getMeta(key)]));
}

function isReady() {
  return Object.values(store).every((entry) => entry.lastUpdate > 0);
}

function isTableCurrent(tableName, now = Date.now()) {
  const config = TABLE_CONFIG[tableName];
  const entry = store[tableName];
  if (!config || !entry?.lastUpdate) return false;
  const maxAge = config.category === "fast" ? READINESS_FAST_MAX_AGE_MS : READINESS_SLOW_MAX_AGE_MS;
  return now - entry.lastUpdate <= maxAge;
}

function getReadiness(now = Date.now()) {
  const tables = {};
  let ready = true;
  for (const [name, config] of Object.entries(TABLE_CONFIG)) {
    const meta = getMeta(name);
    const maxAge = config.category === "fast" ? READINESS_FAST_MAX_AGE_MS : READINESS_SLOW_MAX_AGE_MS;
    const ageMs = meta.lastUpdate ? now - meta.lastUpdate : null;
    const current = meta.lastUpdate > 0 && ageMs <= maxAge;
    tables[name] = { current, ageMs, maxAge, lastError: meta.lastError, revision: meta.revision };
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
      lastError: null,
      pollCount: 0,
      readSequence: 0,
      appliedReadSequence: 0,
      mutationVersion: 0,
      staleResultCount: 0,
    };
  }
}

module.exports = { beginRead, get, getAll, getMeta, getReadiness, isReady, isTableCurrent, markError, onChange, resetForTests, set };
