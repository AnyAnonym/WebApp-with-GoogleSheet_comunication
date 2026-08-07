const { version } = require("./package.json");
const { INSTANCE_ID, LOG_LEVEL } = require("./config.js");
const { once } = require("node:events");

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const REDACTED = "[REDACTED]";
const SENSITIVE_KEYS = new Set([
  "authorization", "clientsecret", "cookie", "cookies", "credential", "credentials",
  "currentpasswordhash", "email", "newpasswordhash", "password", "passwordhash",
  "passwdhash", "privatekey", "resettoken", "secret", "sessionid", "sessiontoken",
  "setcookie", "sid", "token", "monitortoken",
]);

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function scrubText(value, maxLength) {
  return String(value)
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, `Bearer ${REDACTED}`)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED)
    .slice(0, maxLength);
}

function safeValue(value, options, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return scrubText(value, options.maxStringLength);
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (value instanceof Error) {
    return {
      name: scrubText(value.name || "Error", 100),
      ...(value.code === undefined ? {} : { code: scrubText(value.code, 100) }),
      message: scrubText(value.message || "", options.maxStringLength),
      ...(value.stack ? { stack: scrubText(value.stack, options.maxStackLength) } : {}),
    };
  }
  if (depth >= options.maxDepth) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, options.maxEntries).map((entry) => safeValue(entry, options, depth + 1, seen));
  }
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, options.maxEntries)) {
    result[key] = SENSITIVE_KEYS.has(normalizedKey(key)) ? REDACTED : safeValue(entry, options, depth + 1, seen);
  }
  return result;
}

function createLogger({
  level = "info",
  service = "epiber-backend",
  instance = "development",
  appVersion = version,
  now = () => new Date(),
  write = (logLevel, line) => {
    const stream = LEVELS[logLevel] >= LEVELS.warn ? process.stderr : process.stdout;
    return stream.write(line) ? null : once(stream, "drain");
  },
  maxStringLength = 1000,
  maxStackLength = 8000,
  maxDepth = 6,
  maxEntries = 100,
} = {}) {
  if (!Object.hasOwn(LEVELS, level)) throw new Error(`Ungueltiges Log-Level: ${level}`);
  const options = { maxStringLength, maxStackLength, maxDepth, maxEntries };
  let pending = Promise.resolve();

  function emit(logLevel, event, fields = {}) {
    if (!Object.hasOwn(LEVELS, logLevel)) throw new Error(`Ungueltiges Log-Level: ${logLevel}`);
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(event)) throw new Error(`Ungueltiger Log-Eventname: ${event}`);
    if (LEVELS[logLevel] < LEVELS[level]) return false;
    let line;
    try {
      const safeFields = safeValue(fields, options);
      line = `${JSON.stringify({
        ...(safeFields && typeof safeFields === "object" && !Array.isArray(safeFields) ? safeFields : { value: safeFields }),
        timestamp: now().toISOString(),
        level: logLevel,
        service,
        instance,
        version: appVersion,
        event,
      })}\n`;
    } catch {
      line = `${JSON.stringify({
        timestamp: now().toISOString(), level: "error", service, instance, version: appVersion, event: "logger_serialization_failed",
      })}\n`;
    }
    try {
      const result = write(logLevel, line);
      if (result && typeof result.then === "function") pending = pending.then(() => result).catch(() => {});
    } catch {
      return false;
    }
    return true;
  }

  return { flush: () => pending, log: emit };
}

const defaultLogger = createLogger({ level: LOG_LEVEL, instance: INSTANCE_ID });

module.exports = {
  createLogger,
  flush: defaultLogger.flush,
  log: defaultLogger.log,
};
