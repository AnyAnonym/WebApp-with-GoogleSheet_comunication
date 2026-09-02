import { diagnostic } from "./diagnostics.js";

const PROTOCOL_VERSION = 2;
const REQUEST_TIMEOUT_MS = 45000;
const CONNECT_TIMEOUT_MS = 10000;
const STALE_AFTER_MS = 70000;
const MAX_BACKOFF_MS = 30000;
const APP_VERSION_UNKNOWN = "...";
const APP_VERSION_FETCH_TIMEOUT_MS = 2500;
const VERSION_MISMATCH_CODE = 4406;
const VERSION_MISMATCH_RELOAD_KEY = "epiber-app-version-reload";

let socket = null;
let socketGeneration = 0;
let state = "idle";
let stopped = false;
let reconnectTimer = null;
let connectTimer = null;
let staleTimer = null;
let stableTimer = null;
let connectAttempt = 0;
let requestCounter = 0;
let lastMessageAt = 0;
let lastPingAt = 0;
let lastPongAt = 0;
let lastClose = null;
let welcome = null;
let connectedOnce = false;
let terminallyStopped = false;
let connectWaiters = [];
const pendingRequests = new Map();
const stateListeners = new Set();
const resyncListeners = new Set();
const eventListeners = new Map();
const desiredTopics = new Set();
const retainedOperationIds = new Map();
let appVersionPromise = null;
function getStoredAppVersion() {
  return typeof window.APP_VERSION === "string" ? window.APP_VERSION : null;
}

function isKnownAppVersion(raw) {
  return typeof raw === "string" && raw !== APP_VERSION_UNKNOWN;
}

function setFooterVersion(version) {
  const footer = document.getElementById("footer-version");
  if (!footer || !version) return;
  footer.textContent = `v${version}`;
}

function fetchAppVersion() {
  return new Promise((resolve) => {
    if (!window.fetch) {
      resolve(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), APP_VERSION_FETCH_TIMEOUT_MS);
    fetch("/version", { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Version endpoint failed"))))
      .then((data) => {
        const next = typeof data?.version === "string" ? data.version : null;
        if (next) {
          window.APP_VERSION = next;
          setFooterVersion(next);
        }
        resolve(next);
      })
      .catch(() => resolve(getStoredAppVersion()))
      .finally(() => clearTimeout(timer));
  });
}

function getAppVersionForHello() {
  if (!appVersionPromise) {
    const stored = getStoredAppVersion();
    if (isKnownAppVersion(stored)) {
      appVersionPromise = Promise.resolve(stored);
    } else {
      appVersionPromise = fetchAppVersion().then((value) => (isKnownAppVersion(value) ? value : APP_VERSION_UNKNOWN));
    }
  }
  return appVersionPromise;
}

function shouldReloadForVersionMismatch() {
  try {
    const storage = window.sessionStorage;
    if (!storage || storage.getItem(VERSION_MISMATCH_RELOAD_KEY)) return false;
    storage.setItem(VERSION_MISMATCH_RELOAD_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

function clearVersionMismatchReloadMarker() {
  try {
    window.sessionStorage?.removeItem(VERSION_MISMATCH_RELOAD_KEY);
  } catch {}
}

function isVersionMismatchClose(code, reason = "") {
  const text = typeof reason === "string" ? reason : reason?.toString?.() || "";
  return code === VERSION_MISMATCH_CODE && /app[- ]?version/i.test(text);
}
const TERMINAL_CLOSE_CODES = new Set([1008, 4003, 4009, VERSION_MISMATCH_CODE]);
const USER_FACING_STATE_TEXT = {
  idle: "Verbinden...",
  connecting: "Verbinden...",
  connected: "Verbunden",
  stale: "Daten werden aktualisiert",
  backoff: "Bitte kurz warten",
  offline: "Keine Verbindung",
  stopped: "Bitte kurz warten",
};

function sanitizeCloseReason(code, reason = "") {
  if (isVersionMismatchClose(code, reason)) return "updates-required";
  if (code === VERSION_MISMATCH_CODE) return "connection-incompatible";
  if (code === 4408 || code === 4000 || code === 4002) return "connection-timeout";
  return typeof reason === "string" && reason.trim() ? "connection-closed" : "connection-lost";
}

function resolveConnectionText(currentState, details = {}) {
  if (currentState === "stopped" && (details.closeCode || lastClose?.code) === VERSION_MISMATCH_CODE) {
    return "Seite neu laden";
  }
  return USER_FACING_STATE_TEXT[currentState] || USER_FACING_STATE_TEXT.idle;
}
const UNCERTAIN_OPERATION_ERRORS = new Set([
  "ACK_TIMEOUT",
  "CONNECTION_LOST",
  "MONITOR_OFFLINE",
  "REQUEST_TIMEOUT",
  "SHUTTING_DOWN",
  "TRANSPORT_FAILED",
  "WRITE_OUTCOME_UNKNOWN",
]);
const READ_ENDPOINTS = new Set([
  "players", "publicProfile", "bewerbe", "bewerbsart", "matches1", "preMatches", "matches",
  "rlPlatzierung", "entryList", "readMatchRestrictions", "withdrawnRankingPlayers", "getScoreboardCourts", "courtScores",
  "scoreboardSnapshot", "memberDirectory", "myProfile", "myMessageSummary", "myMessages", "myMessage", "competitionHistory",
  "operationStatus", "navigator", "monitorList",
  "monitorTarget", "adminPeopleNormalization", "adminMemberReconciliation", "sheetDataStatus",
]);
const ALLOWED_TRANSITIONS = {
  idle: new Set(["connecting", "offline", "stopped"]),
  connecting: new Set(["connected", "backoff", "offline", "idle", "stopped"]),
  connected: new Set(["stale", "backoff", "offline", "idle", "stopped"]),
  stale: new Set(["backoff", "offline", "idle", "stopped"]),
  backoff: new Set(["connecting", "offline", "idle", "stopped"]),
  offline: new Set(["idle", "connecting", "stopped"]),
  stopped: new Set(["idle"]),
};

function currentStaleAfterMs() {
  return Number(welcome?.timing?.staleAfterMs) || STALE_AFTER_MS;
}

function startStaleWatchdog() {
  if (staleTimer) return;
  staleTimer = setInterval(() => {
    const staleAfterMs = currentStaleAfterMs();
    if (state === "connected" && lastMessageAt && Date.now() - lastMessageAt > staleAfterMs) {
      setState("stale");
      socket?.close(4001, "Stale connection");
    }
  }, 5000);
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const clientId = randomId();
const pageType = window.location.pathname.split("/").pop()?.replace(/\.html$/i, "") || "index";
let deviceId;
try {
  deviceId = localStorage.getItem("epiberDeviceId") || randomId();
  localStorage.setItem("epiberDeviceId", deviceId);
} catch {
  deviceId = randomId();
}

function websocketUrl() {
  const url = new URL("/ws", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function setState(next, details = {}) {
  if (state === next && !Object.keys(details).length) return;
  if (state === "stopped" && next === "backoff") return;
  if (state !== next && !ALLOWED_TRANSITIONS[state]?.has(next)) {
    throw new Error(`Ungueltiger WebSocket-Zustandswechsel: ${state} -> ${next}`);
  }
  const previousState = state;
  state = next;
  if (previousState !== next) {
    diagnostic.debug("websocket_state_changed", {
      previousState,
      nextState: next,
      reconnectAttempt: connectAttempt,
      online: navigator.onLine,
    });
  }
  const snapshot = getConnectionStatus(details);
  for (const listener of stateListeners) {
    try { listener(snapshot); } catch (error) { diagnostic.error("data_client_state_listener_failed", error); }
  }
}

function getConnectionStatus(details = {}) {
  return {
    state,
    connected: state === "connected",
    synchronized: state === "connected" && !!welcome,
    lastMessageAt,
    lastPingAt,
    lastPongAt,
    lastClose,
    reconnectAttempt: connectAttempt,
    statusText: resolveConnectionText(state, details),
    principal: welcome?.principal || null,
    ...details,
  };
}

function resolveConnectWaiters(error = null) {
  const waiters = connectWaiters;
  connectWaiters = [];
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error); else waiter.resolve(welcome);
  }
}

function rejectPending(error) {
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(error);
    pendingRequests.delete(id);
  }
}

function connectionError(message) {
  const error = new Error(message);
  error.code = "CONNECTION_LOST";
  return error;
}

function offlineError() {
  const error = new Error("WebSocket-Anfrage kann offline nicht gesendet werden");
  error.code = "OFFLINE";
  return error;
}

function cleanupSocket(expectedSocket) {
  if (socket !== expectedSocket) return;
  socket = null;
  welcome = null;
  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = null;
  if (stableTimer) clearTimeout(stableTimer);
  stableTimer = null;
  rejectPending(connectionError("WebSocket-Verbindung wurde getrennt"));
}

function scheduleReconnect() {
  if (stopped || state === "stopped" || !navigator.onLine || reconnectTimer) return;
  const base = Math.min(MAX_BACKOFF_MS, 1000 * (2 ** Math.min(connectAttempt, 5)));
  const delay = Math.floor(base * (0.8 + Math.random() * 0.4));
  setState("backoff", { retryInMs: delay });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN || state !== "connected") {
    throw new Error("WebSocket ist nicht verbunden");
  }
  try {
    socket.send(JSON.stringify({ ...message, v: PROTOCOL_VERSION }));
  } catch (error) {
    if (socket.readyState !== WebSocket.CLOSED) socket.close();
    throw error;
  }
}

function sendOnSocket(currentSocket, message) {
  if (currentSocket !== socket || currentSocket.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket ist nicht verbunden");
  }
  try {
    currentSocket.send(JSON.stringify({ ...message, v: PROTOCOL_VERSION }));
  } catch (error) {
    if (currentSocket.readyState !== WebSocket.CLOSED) currentSocket.close();
    throw error;
  }
}

function sendSubscriptions() {
  if (!desiredTopics.size || state !== "connected") return;
  const topics = [...desiredTopics];
  for (let index = 0; index < topics.length; index += 20) {
    send({ type: "subscribe", topics: topics.slice(index, index + 20) });
  }
}

function dispatchEvent(topic, data) {
  const listeners = eventListeners.get(topic);
  if (!listeners) return;
  for (const listener of listeners) {
    try { listener(data); } catch (error) { diagnostic.error("data_client_event_listener_failed", error); }
  }
}

function handleMessage(event, generation, currentSocket) {
  if (generation !== socketGeneration || currentSocket !== socket) return;
  lastMessageAt = Date.now();
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    currentSocket.close(1002, "Invalid JSON");
    return;
  }

  if (message.v !== PROTOCOL_VERSION) {
    currentSocket.close(4406, "Protocol mismatch");
    return;
  }
  if (message.type === "ping") {
    lastPingAt = Date.now();
    try {
      sendOnSocket(currentSocket, { type: "pong", ts: message.ts });
      lastPongAt = Date.now();
    } catch {}
    return;
  }
  if (message.type === "welcome") {
    if (message.protocol !== PROTOCOL_VERSION) {
      currentSocket.close(4406, "Protocol mismatch");
      return;
    }
    clearVersionMismatchReloadMarker();
    welcome = message;
    setState("connected");
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      if (currentSocket === socket && state === "connected") connectAttempt = 0;
      stableTimer = null;
    }, 30000);
    resolveConnectWaiters();
    sendSubscriptions();
    const wasReconnect = connectedOnce;
    connectedOnce = true;
    if (wasReconnect) {
      diagnostic.info("websocket_connection_recovered", { reconnectAttempt: connectAttempt, online: navigator.onLine });
    }
    for (const listener of resyncListeners) {
      try { listener({ reconnect: wasReconnect, welcome }); } catch (error) { diagnostic.error("data_client_resync_listener_failed", error); }
    }
    return;
  }
  if (message.type === "response" && message.id) {
    const pending = pendingRequests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRequests.delete(message.id);
    if (message.endpoint !== pending.endpoint) {
      const error = new Error(`Response-Endpoint stimmt nicht mit ${pending.endpoint} ueberein`);
      error.code = "PROTOCOL_MISMATCH";
      pending.reject(error);
      currentSocket.close(4406, "Response endpoint mismatch");
      return;
    }
    if (message.data?.success === false) {
      const supportSuffix = message.supportId ? ` (Referenz: ${message.supportId})` : "";
      const error = new Error(`${message.data.error?.message || "Serveroperation fehlgeschlagen"}${supportSuffix}`);
      error.code = message.data.error?.code || "SERVER_ERROR";
      error.details = message.data.error?.details;
      error.supportId = message.supportId;
      if (["AUTH_REQUIRED", "FORBIDDEN"].includes(error.code)) {
        window.dispatchEvent(new CustomEvent("epiber:auth-invalid", { detail: { code: error.code } }));
      }
      pending.reject(error);
    } else {
      pending.resolve(message.data);
    }
    return;
  }
  if (message.type === "event" && message.topic) {
    dispatchEvent(message.topic, message.data);
    return;
  }
  if (message.type === "error") {
    diagnostic.error("data_client_protocol_error", message.error);
  }
}

function connect() {
  if (stopped || socket || reconnectTimer || !navigator.onLine) {
    if (!navigator.onLine) setState("offline");
    return;
  }
  startStaleWatchdog();
  const generation = ++socketGeneration;
  connectAttempt++;
  setState("connecting");
  let currentSocket;
  try {
    currentSocket = new WebSocket(websocketUrl());
  } catch (error) {
    setState("backoff", { error: error.message });
    scheduleReconnect();
    return;
  }
  socket = currentSocket;
  connectTimer = setTimeout(() => {
    if (socket === currentSocket && state !== "connected") currentSocket.close(4000, "Connect timeout");
  }, CONNECT_TIMEOUT_MS);

  currentSocket.addEventListener("open", () => {
    if (generation !== socketGeneration || currentSocket !== socket) return;
    lastMessageAt = Date.now();
    getAppVersionForHello()
      .then((appVersion) => {
        sendOnSocket(currentSocket, {
          type: "hello",
          protocol: PROTOCOL_VERSION,
          clientId,
          deviceId,
          pageType,
          appVersion,
        });
      })
      .catch(() => {
        cleanupSocket(currentSocket);
        setState("backoff");
        scheduleReconnect();
      });
  });
  currentSocket.addEventListener("message", (event) => handleMessage(event, generation, currentSocket));
  currentSocket.addEventListener("close", (event) => {
    if (generation !== socketGeneration) return;
    cleanupSocket(currentSocket);
    lastClose = { code: event.code, reason: event.reason, at: Date.now() };
    if (stopped) {
      setState("stopped", { closeCode: event.code, closeReason: sanitizeCloseReason(event.code, event.reason) });
      return;
    }
    if (isVersionMismatchClose(event.code, event.reason)) {
      if (shouldReloadForVersionMismatch()) {
        location.reload();
        return;
      }
      stopped = true;
      terminallyStopped = true;
      resolveConnectWaiters(new Error(`WebSocket dauerhaft geschlossen wegen Versionskonflikt (${event.code})`));
      setState("stopped", {
        closeCode: event.code,
        closeReason: sanitizeCloseReason(event.code, event.reason),
        terminalReason: "version-mismatch",
      });
      return;
    }
    if (TERMINAL_CLOSE_CODES.has(event.code)) {
      stopped = true;
      terminallyStopped = true;
      resolveConnectWaiters(new Error(`WebSocket dauerhaft getrennt (${event.code})`));
      setState("stopped", { closeCode: event.code, closeReason: sanitizeCloseReason(event.code, event.reason) });
      return;
    }
    if (state !== "stopped") {
      setState(navigator.onLine ? "backoff" : "offline", {
        closeCode: event.code,
        closeReason: sanitizeCloseReason(event.code, event.reason),
      });
    }
    scheduleReconnect();
  });
  currentSocket.addEventListener("error", () => {});
}

function waitForConnection() {
  if (!navigator.onLine || state === "offline") return Promise.reject(offlineError());
  if (state === "connected" && welcome) return Promise.resolve(welcome);
  if (stopped) return Promise.reject(new Error("WebSocket-Client wurde gestoppt"));
  connect();
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      connectWaiters = connectWaiters.filter((entry) => entry !== waiter);
      reject(connectionError("WebSocket konnte nicht innerhalb des Wiederverbindungsfensters verbunden werden"));
    }, CONNECT_TIMEOUT_MS + Math.ceil(MAX_BACKOFF_MS * 1.2));
    connectWaiters.push(waiter);
  });
}

async function requestOnce(endpoint, params) {
  await waitForConnection();
  const id = `${clientId}:${++requestCounter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      const error = new Error(`Request Timeout: ${endpoint}`);
      error.code = "REQUEST_TIMEOUT";
      reject(error);
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, reject, timer, endpoint });
    try {
      send({ type: "request", id, endpoint, params });
    } catch (error) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(error);
    }
  });
}

export async function request(endpoint, params = {}) {
  const retryable = READ_ENDPOINTS.has(endpoint);
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await requestOnce(endpoint, params);
      diagnostic.debug("rpc_request_completed", {
        endpoint,
        durationMs: Date.now() - startedAt,
        attemptCount: attempt,
        outcome: "success",
      });
      return result;
    } catch (error) {
      const canRetry = retryable
        && attempt < 3
        && ["REQUEST_TIMEOUT", "SHUTTING_DOWN"].includes(error.code);
      if (!canRetry) {
        diagnostic.warn("rpc_request_failed", {
          endpoint,
          durationMs: Date.now() - startedAt,
          attemptCount: attempt,
          outcome: "failed",
          error,
        });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
    }
  }
}

export function createEndpoint(endpoint) {
  return async (params = {}) => ({ data: await request(endpoint, params) });
}

export function subscribe(topic, callback) {
  if (!eventListeners.has(topic)) eventListeners.set(topic, new Set());
  eventListeners.get(topic).add(callback);
  desiredTopics.add(topic);
  if (state === "connected") send({ type: "subscribe", topics: [topic] });
  return () => {
    const listeners = eventListeners.get(topic);
    listeners?.delete(callback);
    if (listeners?.size) return;
    eventListeners.delete(topic);
    desiredTopics.delete(topic);
    if (state === "connected") send({ type: "unsubscribe", topics: [topic] });
  };
}

export function subscribeInvalidations(topics, callback, { delayMs = 100 } = {}) {
  const uniqueTopics = [...new Set(topics)];
  let timer = null;
  let running = false;
  let pending = false;

  const drain = async () => {
    timer = null;
    if (running || !pending) return;
    pending = false;
    running = true;
    try {
      await callback();
    } catch (error) {
      diagnostic.error("data_client_live_refresh_failed", error);
    } finally {
      running = false;
      if (pending && !timer) timer = setTimeout(drain, delayMs);
    }
  };

  const schedule = () => {
    pending = true;
    if (!running && !timer) timer = setTimeout(drain, delayMs);
  };
  const unsubscribers = uniqueTopics.map((topic) => subscribe(topic, schedule));
  return () => {
    pending = false;
    if (timer) clearTimeout(timer);
    timer = null;
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

export function setOnScoreChange(callback) {
  return subscribe("scores", callback);
}

export function onConnectionState(callback) {
  stateListeners.add(callback);
  callback(getConnectionStatus());
  return () => stateListeners.delete(callback);
}

export function onResync(callback) {
  resyncListeners.add(callback);
  return () => resyncListeners.delete(callback);
}

export function getPrincipal() {
  return welcome?.principal || null;
}

export function isConnected() {
  return state === "connected";
}

export function createOperationId() {
  return randomId();
}

export function getOperationId(key) {
  const normalized = String(key);
  if (!retainedOperationIds.has(normalized)) {
    if (retainedOperationIds.size >= 100) retainedOperationIds.delete(retainedOperationIds.keys().next().value);
    retainedOperationIds.set(normalized, createOperationId());
  }
  return retainedOperationIds.get(normalized);
}

export function releaseOperationId(key, error = null) {
  if (!error || !UNCERTAIN_OPERATION_ERRORS.has(error.code)) retainedOperationIds.delete(String(key));
}

export function restartConnection({ allowTerminal = false } = {}) {
  if (terminallyStopped && !allowTerminal) {
    const error = new Error("WebSocket-Verbindung wurde dauerhaft beendet");
    error.code = "TERMINAL_CONNECTION";
    return Promise.reject(error);
  }
  terminallyStopped = false;
  stopped = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = null;
  const current = socket;
  socket = null;
  socketGeneration++;
  welcome = null;
  rejectPending(connectionError("WebSocket wird neu authentifiziert"));
  if (current && current.readyState < WebSocket.CLOSING) current.close(1000, "Session changed");
  setState("idle");
  connect();
  return waitForConnection();
}

export function disconnect() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = null;
  if (staleTimer) clearInterval(staleTimer);
  staleTimer = null;
  if (stableTimer) clearTimeout(stableTimer);
  stableTimer = null;
  const current = socket;
  socket = null;
  socketGeneration++;
  welcome = null;
  lastClose = { code: 1000, reason: "Client stopped", at: Date.now() };
  rejectPending(new Error("WebSocket-Client wurde gestoppt"));
  resolveConnectWaiters(new Error("WebSocket-Client wurde gestoppt"));
  if (current && current.readyState < WebSocket.CLOSING) current.close(1000, "Client stopped");
  setState("stopped");
}

window.addEventListener("offline", () => {
  if (state === "stopped") return;
  setState("offline");
  resolveConnectWaiters(offlineError());
  socket?.close(4002, "Browser offline");
});
window.addEventListener("online", () => restartConnection().catch(() => {}));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state === "connected" && Date.now() - lastMessageAt > currentStaleAfterMs() / 2) {
    restartConnection().catch(() => {});
  }
});
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) disconnect();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) restartConnection().catch(() => {});
});

connect();
