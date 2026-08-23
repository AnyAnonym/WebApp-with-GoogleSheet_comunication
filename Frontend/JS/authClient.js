import { restartConnection } from "./dataClient.js";
import { applyDiagnosticPolicy, diagnostic } from "./diagnostics.js";

let user = undefined;
let expiresAt = 0;
let expiryTimer = null;
let refreshGeneration = 0;
let authMutationQueue = Promise.resolve();
let serverClockOffset = 0;
let authStatus = "loading";
let authError = null;
const listeners = new Set();
const channel = "BroadcastChannel" in window ? new BroadcastChannel("epiber-auth") : null;

function runAuthMutation(callback) {
  const execute = () => navigator.locks?.request
    ? navigator.locks.request("epiber-auth-mutation", { mode: "exclusive" }, callback)
    : callback();
  const operation = authMutationQueue.catch(() => {}).then(execute);
  authMutationQueue = operation.catch(() => {});
  return operation;
}

function notify() {
  for (const listener of listeners) {
    try { listener(user, { status: authStatus, error: authError }); } catch (error) { diagnostic.error("auth_listener_failed", error); }
  }
}

function authIdentityFingerprint(value, expiry = expiresAt) {
  return value ? `${value.id || ""}:${value.role || ""}:${value.login || ""}:${expiry || 0}` : "anonymous";
}

function userFingerprint(value, expiry = expiresAt) {
  return value ? `${authIdentityFingerprint(value, expiry)}:${value.email || ""}` : "anonymous";
}

function updateServerClock(result) {
  const serverTime = Number(result?.serverTime);
  if (Number.isFinite(serverTime) && serverTime > 0) serverClockOffset = serverTime - Date.now();
}

function scheduleExpiry(retryMs = 0) {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  if (retryMs > 0) {
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      refreshSession({ reconnect: true }).catch(() => {});
    }, retryMs);
    return;
  }
  if (!expiresAt) return;
  const delay = Math.max(50, expiresAt - (Date.now() + serverClockOffset) + 50);
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    refreshSession({ reconnect: true }).catch(() => {});
  }, delay);
}

async function jsonRequest(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 80000);
  let response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error("Anfrage hat zu lange gedauert");
      timeoutError.code = "HTTP_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.json().catch(() => ({ success: false, error: { code: "INVALID_RESPONSE", message: "Ungueltige Serverantwort" } }));
  if (body?.frontendLogging) applyDiagnosticPolicy(body.frontendLogging);
  if (!response.ok) {
    const supportSuffix = body.supportId ? ` (Referenz: ${body.supportId})` : "";
    const error = new Error(`${body.error?.message || "Anfrage fehlgeschlagen"}${supportSuffix}`);
    error.code = body.error?.code || "HTTP_ERROR";
    error.status = response.status;
    error.details = body.error?.details;
    error.supportId = body.supportId;
    throw error;
  }
  return body;
}

function fallbackSha256(ascii) {
  const rightRotate = (value, amount) => (value >>> amount) | (value << (32 - amount));
  const maxWord = 2 ** 32;
  const words = [];
  const asciiBitLength = ascii.length * 8;
  const hash = fallbackSha256.h || [];
  const constants = fallbackSha256.k || [];
  let primeCounter = constants.length;
  const isComposite = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (isComposite[candidate]) continue;
    for (let multiple = candidate * candidate; multiple < 313; multiple += candidate) isComposite[multiple] = candidate;
    if (primeCounter < 8) hash[primeCounter] = (candidate ** 0.5 * maxWord) | 0;
    constants[primeCounter++] = (candidate ** (1 / 3) * maxWord) | 0;
  }
  fallbackSha256.h = hash;
  fallbackSha256.k = constants;
  ascii += "\x80";
  while (ascii.length % 64 !== 56) ascii += "\x00";
  for (let index = 0; index < ascii.length; index++) {
    const code = ascii.charCodeAt(index);
    if (code > 255) throw new Error("SHA-256 erwartet UTF-8-Bytes");
    words[index >> 2] |= code << ((3 - index) % 4) * 8;
  }
  words.push((asciiBitLength / maxWord) | 0, asciiBitLength);
  let currentHash = hash.slice(0, 8);
  for (let block = 0; block < words.length; block += 16) {
    const schedule = words.slice(block, block + 16);
    const oldHash = currentHash.slice();
    for (let round = 0; round < 64; round++) {
      const w15 = schedule[round - 15];
      const w2 = schedule[round - 2];
      const a = currentHash[0];
      const e = currentHash[4];
      const temp1 = (currentHash[7]
        + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
        + ((e & currentHash[5]) ^ ((~e) & currentHash[6]))
        + constants[round]
        + (schedule[round] = round < 16 ? schedule[round] : (
          schedule[round - 16]
          + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
          + schedule[round - 7]
          + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
        ) | 0)) | 0;
      const temp2 = ((rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
        + ((a & currentHash[1]) ^ (a & currentHash[2]) ^ (currentHash[1] & currentHash[2]))) | 0;
      currentHash = [(temp1 + temp2) | 0, a, currentHash[1], currentHash[2], (currentHash[3] + temp1) | 0, e, currentHash[5], currentHash[6]];
    }
    currentHash = currentHash.map((value, index) => (value + oldHash[index]) | 0);
  }
  return currentHash.map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
}

export async function hashPassword(password) {
  const bytes = new TextEncoder().encode(password);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return fallbackSha256(binary);
}

export async function refreshSession({ reconnect = false, forceReconnect = false } = {}) {
  const generation = ++refreshGeneration;
  const previousIdentityFingerprint = user === undefined ? null : authIdentityFingerprint(user);
  const previousUserFingerprint = user === undefined ? null : userFingerprint(user);
  let retryMs = 0;
  try {
    const result = await jsonRequest("/api/session");
    if (generation !== refreshGeneration) return user;
    updateServerClock(result);
    user = result.authenticated ? result.user : null;
    expiresAt = result.authenticated ? Number(result.expiresAt || 0) : 0;
    authStatus = result.authenticated ? "authenticated" : "anonymous";
    authError = null;
  } catch (error) {
    if (generation !== refreshGeneration) return user;
    retryMs = 30000;
    authStatus = "unavailable";
    authError = error;
    diagnostic.error("auth_session_refresh_failed", error);
  }
  scheduleExpiry(retryMs);
  const identityChanged = previousIdentityFingerprint === null || previousIdentityFingerprint !== authIdentityFingerprint(user);
  const userChanged = previousUserFingerprint === null || previousUserFingerprint !== userFingerprint(user);
  if (reconnect && (identityChanged || forceReconnect)) await restartConnection().catch((error) => diagnostic.error("auth_socket_reauthentication_failed", error));
  if (userChanged) notify();
  return user;
}

export const ready = refreshSession();

export function login(login, password) {
  return runAuthMutation(async () => {
  refreshGeneration++;
  const passwordHash = await hashPassword(password);
  const result = await jsonRequest("/api/session", {
    method: "POST",
    body: JSON.stringify({ login, passwordHash }),
  });
  refreshGeneration++;
  updateServerClock(result);
  user = result.user;
  expiresAt = Number(result.expiresAt || 0);
  authStatus = "authenticated";
  authError = null;
  scheduleExpiry();
  await restartConnection().catch((error) => diagnostic.error("auth_socket_reauthentication_failed", error));
  notify();
  channel?.postMessage("changed");
  return user;
  });
}

export function logout() {
  return runAuthMutation(async () => {
  refreshGeneration++;
  await jsonRequest("/api/session", { method: "DELETE" });
  refreshGeneration++;
  user = null;
  expiresAt = 0;
  authStatus = "anonymous";
  authError = null;
  scheduleExpiry();
  notify();
  channel?.postMessage("changed");
  await restartConnection().catch(() => {});
  });
}

export function changePassword(currentPassword, newPassword) {
  return runAuthMutation(async () => {
  const [currentPasswordHash, newPasswordHash] = await Promise.all([hashPassword(currentPassword), hashPassword(newPassword)]);
  let result;
  try {
    result = await jsonRequest("/api/password", {
      method: "POST",
      body: JSON.stringify({ currentPasswordHash, newPasswordHash }),
    });
  } catch (error) {
    if (error.details?.sessionInvalidated) {
      user = null;
      expiresAt = 0;
      authStatus = "anonymous";
      authError = null;
      scheduleExpiry();
      await restartConnection().catch(() => {});
      notify();
      channel?.postMessage("changed");
    }
    throw error;
  }
  updateServerClock(result);
  user = result.user;
  expiresAt = Number(result.expiresAt || 0);
  authStatus = "authenticated";
  authError = null;
  scheduleExpiry();
  await restartConnection().catch((error) => diagnostic.error("auth_socket_reauthentication_failed", error));
  notify();
  channel?.postMessage("changed");
  return result;
  });
}

export async function createPasswordReset(personId) {
  return jsonRequest("/api/admin/password-reset", {
    method: "POST",
    body: JSON.stringify({ personId }),
  });
}

export async function setPasswordSetupAllowed(personId, allowed) {
  return jsonRequest("/api/admin/password-setup", {
    method: "POST",
    body: JSON.stringify({ personId, allowed }),
  });
}

export async function setPasswordForPerson(personId, newPassword) {
  const newPasswordHash = await hashPassword(newPassword);
  return jsonRequest("/api/admin/password", {
    method: "POST",
    body: JSON.stringify({ personId, newPasswordHash }),
  });
}

export async function resetPassword(resetToken, newPassword) {
  const newPasswordHash = await hashPassword(newPassword);
  return jsonRequest("/api/password-reset", {
    method: "POST",
    body: JSON.stringify({ resetToken, newPasswordHash }),
  });
}

export async function setupPassword(login, newPassword) {
  const newPasswordHash = await hashPassword(newPassword);
  return jsonRequest("/api/password-setup", {
    method: "POST",
    body: JSON.stringify({ login, newPasswordHash }),
  });
}

export function getUser() {
  return user || null;
}

export function isAuthenticated() {
  return !!user;
}

export function hasRole(...roles) {
  return !!user && roles.includes(user.role);
}

export function subscribeAuth(callback) {
  listeners.add(callback);
  callback(user, { status: authStatus, error: authError });
  return () => listeners.delete(callback);
}

export function getAuthState() {
  return { user, status: authStatus, error: authError };
}

channel?.addEventListener("message", () => refreshSession({ reconnect: true, forceReconnect: true }));
window.addEventListener("pageshow", (event) => { if (event.persisted) refreshSession({ reconnect: true }); });
window.addEventListener("epiber:auth-invalid", () => refreshSession({ reconnect: true }).catch(() => {}));
window.addEventListener("online", () => refreshSession().catch(() => {}));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshSession({ reconnect: true }).catch(() => {});
});
const sessionValidationTimer = setInterval(() => {
  if (!document.hidden) refreshSession().catch(() => {});
}, 60000);
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) clearInterval(sessionValidationTimer);
}, { once: true });
