const crypto = require("crypto");
const net = require("node:net");
const { AppError } = require("./errors.js");

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function hashPayload(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header = "") {
  const result = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }
  return result;
}

function serializeCookie(name, value, { maxAge, secure = true } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) parts.push("Secure");
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join("; ");
}

function clearCookie(name, secure = true) {
  return serializeCookie(name, "", { maxAge: 0, secure });
}

function normalizeIp(value) {
  let candidate = String(value || "").trim();
  const zoneIndex = candidate.indexOf("%");
  if (zoneIndex >= 0) {
    const withoutZone = candidate.slice(0, zoneIndex);
    if (net.isIP(withoutZone) !== 6) return "unknown";
    candidate = withoutZone;
  }
  if (candidate.startsWith("::ffff:") && net.isIP(candidate.slice(7)) === 4) candidate = candidate.slice(7);
  const family = net.isIP(candidate);
  if (family === 4) return candidate;
  if (family === 6) return new URL(`http://[${candidate}]/`).hostname.slice(1, -1);
  return "unknown";
}

function isLoopbackIp(value) {
  return value === "::1" || value === "127.0.0.1";
}

function getRequestIp(req) {
  const remote = normalizeIp(req.socket.remoteAddress);
  const forwarded = req.headers["x-forwarded-for"];
  if (isLoopbackIp(remote) && typeof forwarded === "string" && forwarded) {
    const client = normalizeIp(forwarded.split(",", 1)[0]);
    if (client !== "unknown") return client;
  }
  return remote;
}

function assertAllowedOrigin(req, allowedOrigins, { required = true } = {}) {
  const origin = req.headers.origin;
  if (!origin) {
    if (required) throw new AppError("ORIGIN_REQUIRED", "Origin-Header fehlt", 403);
    return null;
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new AppError("ORIGIN_INVALID", "Origin ist ungueltig", 403);
  }
  if (!allowedOrigins.has(parsed.origin)) {
    throw new AppError("ORIGIN_FORBIDDEN", "Origin ist nicht erlaubt", 403);
  }
  return parsed.origin;
}

function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      reject(new AppError("CONTENT_TYPE_REQUIRED", "Content-Type application/json erforderlich", 415));
      return;
    }
    const contentLength = Number(req.headers["content-length"] || 0);
    if (Number.isFinite(contentLength) && contentLength > limitBytes) {
      reject(new AppError("BODY_TOO_LARGE", "Request-Body ist zu gross", 413));
      req.resume();
      return;
    }
    let size = 0;
    const chunks = [];
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        settled = true;
        reject(new AppError("BODY_TOO_LARGE", "Request-Body ist zu gross", 413));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const value = text ? JSON.parse(text) : {};
        if (!value || Array.isArray(value) || typeof value !== "object") {
          throw new Error("JSON-Objekt erforderlich");
        }
        resolve(value);
      } catch (error) {
        reject(new AppError("INVALID_JSON", error.message, 400));
      }
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.on("aborted", () => {
      if (settled) return;
      settled = true;
      reject(new AppError("REQUEST_ABORTED", "Request wurde abgebrochen", 400));
    });
  });
}

class TokenBucketLimiter {
  constructor({ rate, burst, idleMs = 300000, maxEntries = 10000, now = Date.now }) {
    this.rate = rate;
    this.burst = burst;
    this.idleMs = idleMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.buckets = new Map();
  }

  take(key, amount = 1) {
    const now = this.now();
    if (!this.buckets.has(key) && this.buckets.size >= this.maxEntries) {
      this.cleanup(now);
      if (this.buckets.size >= this.maxEntries) {
        let oldestKey = null;
        let oldestTouched = Infinity;
        for (const [candidate, value] of this.buckets) {
          if (value.touched < oldestTouched) {
            oldestKey = candidate;
            oldestTouched = value.touched;
          }
        }
        if (oldestKey !== null) this.buckets.delete(oldestKey);
      }
    }
    const bucket = this.buckets.get(key) || { tokens: this.burst, at: now, touched: now };
    const elapsed = Math.max(0, now - bucket.at) / 1000;
    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.rate);
    bucket.at = now;
    bucket.touched = now;
    if (bucket.tokens < amount) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= amount;
    this.buckets.set(key, bucket);
    return true;
  }

  cleanup(now = this.now()) {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.touched > this.idleMs) this.buckets.delete(key);
    }
  }
}

module.exports = {
  TokenBucketLimiter,
  assertAllowedOrigin,
  clearCookie,
  getRequestIp,
  hashPayload,
  hashToken,
  normalizeIp,
  parseCookies,
  randomToken,
  readJsonBody,
  serializeCookie,
  stableStringify,
  timingSafeTextEqual,
};
