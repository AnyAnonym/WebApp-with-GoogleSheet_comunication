const path = require("path");

function parseInteger(name, fallback, min, max) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} muss eine Ganzzahl zwischen ${min} und ${max} sein`);
  }
  return value;
}

function parseBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} muss true oder false sein`);
}

function parseOrigin(value, name) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} muss eine gueltige Origin sein`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} muss nur Schema, Host und optional Port enthalten`);
  }
  return url.origin;
}

const INSTANCE_ID = String(process.env.INSTANCE_ID || "development").trim();
if (!/^[a-z0-9_-]{1,32}$/i.test(INSTANCE_ID)) {
  throw new Error("INSTANCE_ID enthaelt ungueltige Zeichen");
}

const LOG_LEVEL = String(process.env.LOG_LEVEL || "info").trim().toLowerCase();
if (!["debug", "info", "warn", "error"].includes(LOG_LEVEL)) {
  throw new Error("LOG_LEVEL muss debug, info, warn oder error sein");
}

const PORT = parseInteger("PORT", 8080, 1, 65535);
const LISTEN_HOST = process.env.LISTEN_HOST || "127.0.0.1";
const PUBLIC_ORIGIN = parseOrigin(process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`, "PUBLIC_ORIGIN");
const ALLOW_INSECURE_TRANSPORT = parseBoolean("ALLOW_INSECURE_TRANSPORT", process.env.NODE_ENV !== "production");
if (PUBLIC_ORIGIN.startsWith("http:") && !ALLOW_INSECURE_TRANSPORT) {
  throw new Error("PUBLIC_ORIGIN muss HTTPS verwenden oder ALLOW_INSECURE_TRANSPORT=true setzen");
}

const additionalOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value, index) => parseOrigin(value, `ALLOWED_ORIGINS[${index}]`));
const ALLOWED_ORIGINS = new Set([PUBLIC_ORIGIN, ...additionalOrigins]);
if (!ALLOW_INSECURE_TRANSPORT && [...ALLOWED_ORIGINS].some((origin) => origin.startsWith("http:"))) {
  throw new Error("ALLOWED_ORIGINS duerfen ohne ALLOW_INSECURE_TRANSPORT nur HTTPS verwenden");
}

const SHEET_ID = process.env.SHEET_ID;
const COURT_URL = process.env.COURT_URL;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, ".state", `${INSTANCE_ID}.sqlite`);
const SCORELOG_FILE = process.env.SCORELOG_FILE || path.join(__dirname, ".state", `${INSTANCE_ID}-scorelog.sqlite`);
const AUDITLOG_FILE = process.env.AUDITLOG_FILE || path.join(__dirname, ".state", `${INSTANCE_ID}-audit.sqlite`);
const SCORE_LOG_JOURNAL = parseBoolean("SCORE_LOG_JOURNAL", true);
const AUDIT_LOG_JOURNAL = parseBoolean("AUDIT_LOG_JOURNAL", true);
const AUDIT_ACTIONS = new Set(String(process.env.AUDIT_ACTIONS || "*").split(",").map((value) => value.trim()).filter(Boolean));

const PROTOCOL_VERSION = 2;
const SESSION_TTL_MS = parseInteger("SESSION_TTL_SECONDS", 28800, 300, 604800) * 1000;
const PASSWORD_RESET_TTL_MS = parseInteger("PASSWORD_RESET_TTL_SECONDS", 900, 300, 3600) * 1000;
const SESSION_COOKIE = `epiber_${INSTANCE_ID}_session`;
const MONITOR_COOKIE = `epiber_${INSTANCE_ID}_monitor`;
const COOKIE_SECURE = PUBLIC_ORIGIN.startsWith("https:");

const HTTP_BODY_LIMIT_BYTES = parseInteger("HTTP_BODY_LIMIT_BYTES", 8192, 512, 65536);
const HTTP_REQUEST_TIMEOUT_MS = parseInteger("HTTP_REQUEST_TIMEOUT_MS", 30000, 5000, 120000);
const HTTP_HEADERS_TIMEOUT_MS = parseInteger("HTTP_HEADERS_TIMEOUT_MS", 10000, 2000, 60000);
const HTTP_KEEP_ALIVE_TIMEOUT_MS = parseInteger("HTTP_KEEP_ALIVE_TIMEOUT_MS", 5000, 1000, 30000);
const WS_MAX_PAYLOAD_BYTES = parseInteger("WS_MAX_PAYLOAD_BYTES", 16384, 1024, 1048576);
const WS_MAX_INFLIGHT = parseInteger("WS_MAX_INFLIGHT", 8, 1, 64);
const WS_MAX_SUBSCRIPTIONS = parseInteger("WS_MAX_SUBSCRIPTIONS", 32, 1, 100);
const WS_REQUEST_RATE = parseInteger("WS_REQUEST_RATE", 20, 1, 200);
const WS_REQUEST_BURST = parseInteger("WS_REQUEST_BURST", 40, 1, 400);
const WS_MAX_CONNECTIONS = parseInteger("WS_MAX_CONNECTIONS", 200, 1, 5000);
const WS_MAX_CONNECTIONS_PER_IP = parseInteger("WS_MAX_CONNECTIONS_PER_IP", 20, 1, 500);
const WS_MAX_BUFFERED_BYTES = parseInteger("WS_MAX_BUFFERED_BYTES", 1048576, 65536, 16777216);
const WS_HANDSHAKE_TIMEOUT_MS = parseInteger("WS_HANDSHAKE_TIMEOUT_MS", 10000, 1000, 30000);
const WS_PING_INTERVAL_MS = parseInteger("WS_PING_INTERVAL_MS", 25000, 5000, 120000);
const WS_DEAD_CLIENT_MS = parseInteger("WS_DEAD_CLIENT_MS", 75000, 15000, 300000);

const GOOGLE_REQUEST_TIMEOUT_MS = parseInteger("GOOGLE_REQUEST_TIMEOUT_MS", 10000, 1000, 10000);
const COURT_POLL_INTERVAL = parseInteger("COURT_POLL_INTERVAL_MS", 2000, 500, 60000);
const COURT_FETCH_TIMEOUT_MS = parseInteger("COURT_FETCH_TIMEOUT_MS", 5000, 500, 60000);
const COURT_MAX_RESPONSE_BYTES = parseInteger("COURT_MAX_RESPONSE_BYTES", 262144, 1024, 2097152);
const COURT_MAX_BACKOFF_MS = parseInteger("COURT_MAX_BACKOFF_MS", 30000, 2000, 300000);

const POLL_BASE_INTERVAL = parseInteger("POLL_BASE_INTERVAL_MS", 5000, 1000, 60000);
const POLL_FAST_MULTIPLIER = parseInteger("POLL_FAST_MULTIPLIER", 2, 1, 60);
const POLL_SLOW_MULTIPLIER = parseInteger("POLL_SLOW_MULTIPLIER", 6, 1, 120);
const READINESS_FAST_MAX_AGE_MS = parseInteger("READINESS_FAST_MAX_AGE_MS", 30000, 5000, 600000);
const READINESS_SLOW_MAX_AGE_MS = parseInteger("READINESS_SLOW_MAX_AGE_MS", 90000, 10000, 1800000);
const SHUTDOWN_GRACE_MS = parseInteger("SHUTDOWN_GRACE_MS", 90000, 1000, 120000);

const TABLE_CONFIG = {
  players:       { range: "Personen",       category: "slow" },
  bewerbe:       { range: "Bewerb",         category: "slow" },
  bewerbsart:    { range: "Bewerbsart",     category: "slow" },
  matchtyp:      { range: "Matchtyp",        category: "slow" },
  matches1:      { range: "Matches1",       category: "fast" },
  rlPlatzierung: { range: "RL-Platzierung", category: "fast" },
  navigator:     { range: "Navigator",       category: "slow" },
  entryList:     { range: "EntryList",       category: "fast" },
};

function validateRuntimeConfig() {
  const errors = [];
  if (!["127.0.0.1", "::1", "localhost"].includes(LISTEN_HOST)) {
    errors.push("LISTEN_HOST muss auf Loopback zeigen");
  }
  if (!SHEET_ID) errors.push("SHEET_ID fehlt");
  if (!COURT_URL) {
    errors.push("COURT_URL fehlt");
  } else {
    try {
      const url = new URL(COURT_URL);
      if (url.protocol !== "https:") errors.push("COURT_URL muss HTTPS verwenden");
    } catch {
      errors.push("COURT_URL ist ungueltig");
    }
  }
  if (!path.isAbsolute(STATE_FILE) && STATE_FILE !== ":memory:") {
    errors.push("STATE_FILE muss absolut sein");
  }
  for (const [name, filename] of [["SCORELOG_FILE", SCORELOG_FILE], ["AUDITLOG_FILE", AUDITLOG_FILE]]) {
    if (!path.isAbsolute(filename) && filename !== ":memory:") errors.push(`${name} muss absolut sein`);
  }
  const persistentFiles = [STATE_FILE, SCORELOG_FILE, AUDITLOG_FILE].filter((value) => value !== ":memory:");
  if (new Set(persistentFiles).size !== persistentFiles.length) errors.push("STATE_FILE, SCORELOG_FILE und AUDITLOG_FILE muessen getrennte Dateien sein");
  if (READINESS_FAST_MAX_AGE_MS < POLL_BASE_INTERVAL * POLL_FAST_MULTIPLIER + GOOGLE_REQUEST_TIMEOUT_MS) {
    errors.push("READINESS_FAST_MAX_AGE_MS muss den schnellen Pollingabstand inklusive Timeout abdecken");
  }
  if (READINESS_SLOW_MAX_AGE_MS < POLL_BASE_INTERVAL * POLL_SLOW_MULTIPLIER + GOOGLE_REQUEST_TIMEOUT_MS) {
    errors.push("READINESS_SLOW_MAX_AGE_MS muss den langsamen Pollingabstand inklusive Timeout abdecken");
  }
  if (WS_DEAD_CLIENT_MS < WS_PING_INTERVAL_MS + 5000) {
    errors.push("WS_DEAD_CLIENT_MS muss mindestens 5000 ms ueber WS_PING_INTERVAL_MS liegen");
  }
  if (errors.length) throw new Error(errors.join("; "));
}

module.exports = {
  ALLOWED_ORIGINS,
  ALLOW_INSECURE_TRANSPORT,
  AUDIT_ACTIONS,
  AUDITLOG_FILE,
  AUDIT_LOG_JOURNAL,
  COOKIE_SECURE,
  COURT_FETCH_TIMEOUT_MS,
  COURT_MAX_BACKOFF_MS,
  COURT_MAX_RESPONSE_BYTES,
  COURT_POLL_INTERVAL,
  COURT_URL,
  GOOGLE_REQUEST_TIMEOUT_MS,
  HTTP_BODY_LIMIT_BYTES,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  INSTANCE_ID,
  LISTEN_HOST,
  LOG_LEVEL,
  MONITOR_COOKIE,
  PASSWORD_RESET_TTL_MS,
  POLL_BASE_INTERVAL,
  POLL_FAST_MULTIPLIER,
  POLL_SLOW_MULTIPLIER,
  PORT,
  PROTOCOL_VERSION,
  PUBLIC_ORIGIN,
  READINESS_FAST_MAX_AGE_MS,
  READINESS_SLOW_MAX_AGE_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SHEET_ID,
  SCORELOG_FILE,
  SCORE_LOG_JOURNAL,
  SHUTDOWN_GRACE_MS,
  STATE_FILE,
  TABLE_CONFIG,
  WS_DEAD_CLIENT_MS,
  WS_HANDSHAKE_TIMEOUT_MS,
  WS_MAX_BUFFERED_BYTES,
  WS_MAX_CONNECTIONS,
  WS_MAX_CONNECTIONS_PER_IP,
  WS_MAX_INFLIGHT,
  WS_MAX_PAYLOAD_BYTES,
  WS_MAX_SUBSCRIPTIONS,
  WS_PING_INTERVAL_MS,
  WS_REQUEST_BURST,
  WS_REQUEST_RATE,
  validateRuntimeConfig,
};
