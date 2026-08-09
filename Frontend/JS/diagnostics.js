const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 50 });
const REDACTED = "[REDACTED]";
const SENSITIVE_KEYS = new Set([
  "address", "authorization", "birthdate", "body", "clientid", "contact", "cookie", "cookies",
  "credential", "credentials", "details", "deviceid", "email", "firstname", "fullname", "lastname", "message",
  "monitortoken", "name", "params", "password", "passwordhash", "payload", "personid", "phone", "playerid",
  "privatekey", "profile", "reason", "request", "resettoken", "response", "secret", "sessionid", "sessiontoken",
  "setcookie", "sid", "stack", "token", "user", "userid",
]);
const ERROR_CATEGORIES = new Set([
  "application", "authentication", "authorization", "network", "protocol", "timeout", "validation", "unknown",
]);
const CATEGORY_MESSAGES = Object.freeze({
  application: "Der Vorgang ist fehlgeschlagen.",
  authentication: "Die Anmeldung ist fehlgeschlagen.",
  authorization: "Der Zugriff ist fehlgeschlagen.",
  network: "Die Verbindung ist fehlgeschlagen.",
  protocol: "Die Kommunikation ist fehlgeschlagen.",
  timeout: "Der Vorgang hat zu lange gedauert.",
  validation: "Der Vorgang konnte nicht verarbeitet werden.",
  unknown: "Der Vorgang ist fehlgeschlagen.",
});
const TRANSPORT_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const MAX_QUEUE_SIZE = 100;
const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  level: "warn",
  targeted: false,
  expiresAt: null,
  sampleRatePercent: 0,
  batchSize: 10,
  flushIntervalMs: 5000,
});
const TRANSPORT_FIELDS = Object.freeze([
  "attempt", "attemptCount", "closeCode", "durationMs", "endpoint", "nextState",
  "online", "outcome", "phase", "previousState", "reconnectAttempt", "resourceType",
]);

let transportPolicy = { ...DEFAULT_POLICY };
let transportQueue = [];
let flushTimer = null;
let flushPromise = null;
let retryDelayMs = 1000;
let expiryTimer = null;
let policyReceived = false;
let policyReceivedAt = 0;
let policyRefreshTimer = null;

function randomUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) {
    for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const clientSessionId = randomUuid();

function pageType() {
  return globalThis.location?.pathname?.split("/").pop()?.replace(/\.html$/i, "") || "index";
}

function appVersion() {
  const value = globalThis.APP_VERSION;
  return typeof value === "string" && value ? value : "...";
}

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function scrubText(value, maxLength) {
  return String(value)
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, `Bearer ${REDACTED}`)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED)
    .replace(/\b(?:password|passwd|token|secret|cookie|authorization)\s*[=:]\s*[^\s,;]+/gi, REDACTED)
    .slice(0, maxLength);
}

function boundedToken(value, pattern, fallback = "") {
  const text = typeof value === "string" ? value : "";
  return pattern.test(text) ? text : fallback;
}

function errorCategory(error, code) {
  const explicit = boundedToken(error?.category, /^[a-z]{1,32}$/);
  if (ERROR_CATEGORIES.has(explicit)) return explicit;
  if (/TIMEOUT/.test(code)) return "timeout";
  if (/AUTH|LOGIN|SESSION/.test(code)) return "authentication";
  if (/FORBIDDEN|PERMISSION|ROLE/.test(code)) return "authorization";
  if (/PROTOCOL|INVALID_RESPONSE|MISMATCH/.test(code)) return "protocol";
  if (/VALID|MISSING|INVALID|REQUIRED/.test(code)) return "validation";
  if (/CONNECTION|NETWORK|OFFLINE|TRANSPORT|SOCKET/.test(code)) return "network";
  return code === "UNEXPECTED_ERROR" ? "unknown" : "application";
}

export function projectDiagnosticError(error) {
  const code = boundedToken(error?.code, /^[A-Z][A-Z0-9_]{0,63}$/, "UNEXPECTED_ERROR");
  const category = errorCategory(error, code);
  const supportId = boundedToken(error?.supportId, /^[A-Za-z0-9_.:-]{1,128}$/);
  return {
    code,
    category,
    ...(supportId ? { supportId } : {}),
    message: CATEGORY_MESSAGES[category],
  };
}

function safeValue(value, options, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return scrubText(value, options.maxStringLength);
  if (typeof value === "function" || typeof value === "symbol") return "[UNSUPPORTED]";
  if (value instanceof Error || Object.prototype.toString.call(value) === "[object Error]") return projectDiagnosticError(value);
  if (depth >= options.maxDepth) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, options.maxEntries).map((entry) => safeValue(entry, options, depth + 1, seen));
  }
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, options.maxEntries)) {
    if (key.length > 64) continue;
    const normalized = normalizedKey(key);
    if (normalized === "error") result[key] = projectDiagnosticError(entry);
    else result[key] = SENSITIVE_KEYS.has(normalized) ? REDACTED : safeValue(entry, options, depth + 1, seen);
  }
  return result;
}

export function createDiagnosticAdapter({
  level = "warn",
  maxDepth = 4,
  maxEntries = 20,
  maxStringLength = 256,
  now = () => new Date(),
  write = (logLevel, entry) => {
    const method = typeof console[logLevel] === "function" ? console[logLevel] : console.log;
    method.call(console, entry);
  },
} = {}) {
  let currentLevel = Object.hasOwn(LEVELS, level) ? level : "warn";
  const options = { maxDepth, maxEntries, maxStringLength };

  function setLevel(nextLevel) {
    if (!Object.hasOwn(LEVELS, nextLevel)) return false;
    currentLevel = nextLevel;
    return true;
  }

  function log(logLevel, event, fields = {}) {
    if (!Object.hasOwn(LEVELS, logLevel) || logLevel === "silent") return false;
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(event)) return false;
    if (LEVELS[logLevel] < LEVELS[currentLevel]) return false;
    try {
      const safeFields = safeValue(fields, options);
      write(logLevel, {
        ...(safeFields && typeof safeFields === "object" && !Array.isArray(safeFields) ? safeFields : { value: safeFields }),
        timestamp: now().toISOString(),
        level: logLevel,
        event,
      });
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, error, fields = {}) => log("error", event, { ...fields, error: projectDiagnosticError(error) }),
    log,
    setLevel,
  });
}

const configuredLevel = typeof globalThis.EPIBER_FRONTEND_LOG_LEVEL === "string"
  ? globalThis.EPIBER_FRONTEND_LOG_LEVEL
  : "warn";

function writeConsole(logLevel, entry) {
  const method = typeof console[logLevel] === "function" ? console[logLevel] : console.log;
  method.call(console, entry);
}

function projectTransportEntry(entry) {
  const error = entry?.error && typeof entry.error === "object" ? entry.error : null;
  const projected = {
    event: entry.event,
    level: entry.level,
    timestamp: entry.timestamp,
  };
  for (const key of TRANSPORT_FIELDS) {
    if (entry[key] !== undefined && entry[key] !== null) projected[key] = entry[key];
  }
  const count = [entry.count, entry.playerCount, entry.busyCount, entry.challengeableCount]
    .find((value) => Number.isInteger(value) && value >= 0);
  if (count !== undefined) projected.count = count;
  const code = error?.code || entry.code;
  const category = error?.category || entry.category;
  const supportId = error?.supportId || entry.supportId;
  if (code) projected.code = code;
  if (category) projected.category = category;
  if (supportId) projected.supportId = supportId;
  return projected;
}

function clearFlushTimer() {
  if (flushTimer !== null) globalThis.clearTimeout?.(flushTimer);
  flushTimer = null;
}

function scheduleFlush(delayMs = transportPolicy.flushIntervalMs) {
  if (flushTimer !== null || !transportPolicy.enabled || !transportQueue.length) return;
  flushTimer = globalThis.setTimeout?.(() => {
    flushTimer = null;
    flushDiagnosticEvents();
  }, delayMs) ?? null;
}

function shouldTransport(entry) {
  if (!transportPolicy.enabled || !Object.hasOwn(TRANSPORT_LEVELS, entry.level)) return false;
  if (TRANSPORT_LEVELS[entry.level] < TRANSPORT_LEVELS[transportPolicy.level]) return false;
  return true;
}

function enqueueTransport(entry) {
  if (!shouldTransport(entry)) return;
  if (transportQueue.length >= MAX_QUEUE_SIZE) transportQueue.shift();
  transportQueue.push(projectTransportEntry(entry));
  if (transportQueue.length >= transportPolicy.batchSize) flushDiagnosticEvents();
  else scheduleFlush();
}

function transportWrite(logLevel, entry) {
  writeConsole(logLevel, entry);
  enqueueTransport(entry);
}

export async function flushDiagnosticEvents({ keepalive = false } = {}) {
  clearFlushTimer();
  if (flushPromise) return flushPromise;
  if (!transportPolicy.enabled || !transportQueue.length || typeof globalThis.fetch !== "function") return false;
  const events = transportQueue.splice(0, transportPolicy.batchSize);
  let nextDelayMs = transportPolicy.flushIntervalMs;
  const operation = (async () => {
    try {
      const response = await globalThis.fetch("/api/frontend-events", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        keepalive,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appVersion: appVersion(),
          clientSessionId,
          pageType: pageType(),
          events,
        }),
      });
      if (response.status === 429 || response.status >= 500) throw new Error("Frontend event collector unavailable");
      retryDelayMs = 1000;
      return response.ok;
    } catch {
      transportQueue = [...events, ...transportQueue].slice(0, MAX_QUEUE_SIZE);
      nextDelayMs = retryDelayMs;
      retryDelayMs = Math.min(30000, retryDelayMs * 2);
      return false;
    }
  })();
  flushPromise = operation;
  try {
    return await operation;
  } finally {
    if (flushPromise === operation) flushPromise = null;
    if (transportQueue.length) {
      scheduleFlush(transportQueue.length >= transportPolicy.batchSize ? Math.min(nextDelayMs, 1000) : nextDelayMs);
    }
  }
}

function pagehideFlush() {
  const navigator = globalThis.navigator;
  if (!transportPolicy.enabled || !transportQueue.length || typeof navigator?.sendBeacon !== "function" || typeof globalThis.Blob !== "function") {
    flushDiagnosticEvents({ keepalive: true });
    return;
  }
  const events = transportQueue.splice(0, 20);
  const payload = new globalThis.Blob([JSON.stringify({
    appVersion: appVersion(),
    clientSessionId,
    pageType: pageType(),
    events,
  })], { type: "application/json" });
  if (!navigator.sendBeacon("/api/frontend-events", payload)) {
    transportQueue = [...events, ...transportQueue].slice(0, MAX_QUEUE_SIZE);
  }
}

function normalizedPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_POLICY };
  const level = Object.hasOwn(TRANSPORT_LEVELS, value.level) ? value.level : DEFAULT_POLICY.level;
  const hasExpiry = value.expiresAt !== null && value.expiresAt !== undefined && Number.isFinite(Number(value.expiresAt));
  const expiresAt = hasExpiry ? Number(value.expiresAt) : null;
  const enabled = value.enabled === true && (!hasExpiry || expiresAt > Date.now());
  return {
    enabled,
    level,
    targeted: enabled && value.targeted === true,
    expiresAt: expiresAt && expiresAt > 0 ? expiresAt : null,
    sampleRatePercent: Number.isInteger(value.sampleRatePercent) ? Math.max(0, Math.min(100, value.sampleRatePercent)) : 0,
    batchSize: Number.isInteger(value.batchSize) ? Math.max(1, Math.min(20, value.batchSize)) : DEFAULT_POLICY.batchSize,
    flushIntervalMs: Number.isInteger(value.flushIntervalMs) ? Math.max(1000, Math.min(30000, value.flushIntervalMs)) : DEFAULT_POLICY.flushIntervalMs,
  };
}

function renderTargetedNotice() {
  const document = globalThis.document;
  if (!document?.body) return;
  let notice = document.getElementById("diagnostic-mode-notice");
  if (!transportPolicy.enabled || !transportPolicy.targeted) {
    notice?.remove();
    return;
  }
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "diagnostic-mode-notice";
    notice.className = "diagnostic-mode-notice";
    notice.setAttribute("role", "status");
    document.body.appendChild(notice);
  }
  const expiresAt = transportPolicy.expiresAt
    ? new Intl.DateTimeFormat("de-AT", { dateStyle: "short", timeStyle: "short" }).format(new Date(transportPolicy.expiresAt))
    : null;
  notice.textContent = expiresAt
    ? `Temporäre technische Diagnose ist bis ${expiresAt} aktiv.`
    : "Temporäre technische Diagnose ist aktiv.";
}

export function applyDiagnosticPolicy(value) {
  policyReceived = true;
  policyReceivedAt = Date.now();
  transportPolicy = normalizedPolicy(value);
  renderTargetedNotice();
  if (expiryTimer !== null) globalThis.clearTimeout?.(expiryTimer);
  expiryTimer = null;
  diagnostic.setLevel(transportPolicy.enabled ? transportPolicy.level : configuredLevel);
  if (!transportPolicy.enabled) {
    transportQueue = [];
    clearFlushTimer();
    return { ...transportPolicy };
  }
  if (transportPolicy.expiresAt) {
    expiryTimer = globalThis.setTimeout?.(() => {
      applyDiagnosticPolicy(DEFAULT_POLICY);
      refreshDiagnosticPolicy();
    }, Math.max(0, transportPolicy.expiresAt - Date.now())) ?? null;
  }
  scheduleFlush();
  return { ...transportPolicy };
}

export function getDiagnosticPolicy() {
  return { ...transportPolicy };
}

export async function refreshDiagnosticPolicy() {
  if (typeof globalThis.fetch !== "function") return false;
  try {
    const response = await globalThis.fetch("/api/frontend-logging-policy", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return false;
    const body = await response.json();
    applyDiagnosticPolicy(body?.frontendLogging);
    return true;
  } catch {
    return false;
  }
}

export const diagnostic = createDiagnosticAdapter({ level: configuredLevel, write: transportWrite });

function installGlobalDiagnostics() {
  if (typeof globalThis.addEventListener !== "function") return;
  globalThis.addEventListener("error", (event) => {
    const target = event.target;
    if (target && target !== globalThis) {
      diagnostic.error("frontend_resource_load_failed", { code: "RESOURCE_LOAD_FAILED", category: "network" }, {
        resourceType: String(target.tagName || "resource").toLowerCase().slice(0, 32),
      });
      return;
    }
    diagnostic.error("frontend_unhandled_error", event.error || { code: "UNHANDLED_ERROR", category: "application" });
  }, true);
  globalThis.addEventListener("unhandledrejection", (event) => {
    diagnostic.error("frontend_unhandled_rejection", event.reason || { code: "UNHANDLED_REJECTION", category: "application" });
  });
  globalThis.addEventListener("load", () => {
    const durationMs = Math.max(0, Math.round(globalThis.performance?.now?.() || 0));
    diagnostic.info("frontend_page_loaded", { durationMs });
  }, { once: true });
  globalThis.addEventListener("pagehide", (event) => {
    pagehideFlush();
    if (!event.persisted && policyRefreshTimer !== null) globalThis.clearInterval?.(policyRefreshTimer);
  });
  globalThis.document?.addEventListener?.("visibilitychange", () => {
    if (!globalThis.document.hidden && Date.now() - policyReceivedAt > 60000) refreshDiagnosticPolicy();
  });
  if (!globalThis.document?.body) {
    globalThis.document?.addEventListener?.("DOMContentLoaded", renderTargetedNotice, { once: true });
  }
  globalThis.setTimeout?.(() => {
    if (!policyReceived) refreshDiagnosticPolicy();
  }, 2000);
  policyRefreshTimer = globalThis.setInterval?.(() => {
    if (!globalThis.document?.hidden && Date.now() - policyReceivedAt > 70000) refreshDiagnosticPolicy();
  }, 15000) ?? null;
}

installGlobalDiagnostics();
