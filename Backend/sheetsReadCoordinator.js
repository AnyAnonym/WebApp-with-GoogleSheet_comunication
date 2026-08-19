const { GOOGLE_REQUEST_TIMEOUT_MS } = require("./config.js");
const { AppError } = require("./errors.js");
const metrics = require("./metrics.js");

const RATE_LIMIT_MESSAGE = "Die Google-Sheets-Schnittstelle hat ihr Zugriffslimit erreicht. Bitte etwa eine Minute warten und danach erneut versuchen.";
const RATE_LIMIT_COOLDOWN_MS = 60000;
const RETRY_STATUS_RANGES = Object.freeze([[100, 199], [408, 408], [500, 599]]);

let cooldownUntil = 0;
let now = Date.now;
const activeTables = new Map();

function statusOf(error) {
  return Number(error?.response?.status || error?.status || error?.code || 0);
}

function rateLimitError(retryAfterMs = RATE_LIMIT_COOLDOWN_MS) {
  return new AppError("SHEETS_RATE_LIMITED", RATE_LIMIT_MESSAGE, 429, {
    retryAfterMs: Math.max(1, Math.ceil(Number(retryAfterMs) || RATE_LIMIT_COOLDOWN_MS)),
  });
}

function remainingCooldown() {
  return Math.max(0, cooldownUntil - now());
}

async function executeSheetRead({ method, purpose, call }) {
  const startedAt = now();
  const remaining = remainingCooldown();
  if (remaining > 0) {
    metrics.recordSheetApiRequest({ method, purpose, result: "rate_limited", durationMs: 0 });
    throw rateLimitError(remaining);
  }

  metrics.recordSheetApiAttempt({ method, purpose, kind: "initial" });
  try {
    const result = await call({
      timeout: GOOGLE_REQUEST_TIMEOUT_MS,
      retryConfig: {
        statusCodesToRetry: RETRY_STATUS_RANGES,
        onRetryAttempt() {
          metrics.recordSheetApiAttempt({ method, purpose, kind: "retry" });
        },
      },
    });
    metrics.recordSheetApiRequest({ method, purpose, result: "success", durationMs: now() - startedAt });
    return result;
  } catch (error) {
    if (statusOf(error) === 429) {
      cooldownUntil = Math.max(cooldownUntil, now() + RATE_LIMIT_COOLDOWN_MS);
      metrics.recordSheetApiRequest({ method, purpose, result: "rate_limited", durationMs: now() - startedAt });
      throw rateLimitError();
    }
    metrics.recordSheetApiRequest({ method, purpose, result: "failed", durationMs: now() - startedAt });
    throw error;
  }
}

function getSheetReadStatus() {
  return { cooldownUntil, retryAfterMs: remainingCooldown() };
}

function beginSheetTableActivity(tableName) {
  activeTables.set(tableName, (activeTables.get(tableName) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeTables.get(tableName) || 1) - 1;
    if (remaining > 0) activeTables.set(tableName, remaining);
    else activeTables.delete(tableName);
  };
}

function isSheetTableActive(tableName) {
  return activeTables.has(tableName);
}

function resetSheetReadCoordinatorForTests() {
  cooldownUntil = 0;
  now = Date.now;
  activeTables.clear();
}

function setSheetReadNowForTests(callback) {
  now = callback;
}

module.exports = {
  beginSheetTableActivity,
  executeSheetRead,
  getSheetReadStatus,
  isSheetTableActive,
  rateLimitError,
  resetSheetReadCoordinatorForTests,
  setSheetReadNowForTests,
};
