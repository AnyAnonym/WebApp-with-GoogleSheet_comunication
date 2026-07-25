// ══════════════════════════════════════════════════════
// dataClient.js — Frontend WebSocket-Client
// Zentrale Verbindung zum ePiber-Backend
// Ersetzt httpsCallable-Aufrufe für Lesezugriffe
// ══════════════════════════════════════════════════════

import { BACKEND_WS_URL } from "./SDK.js";

// ── Konfiguration ──
const RECONNECT_DELAY = 3000;
const REQUEST_TIMEOUT = 15000;

// ── State ──
let ws = null;
let connected = false;
let requestIdCounter = 0;
const pendingRequests = new Map(); // id → { resolve, reject, timer }
let onScoreChange = null;
let reconnectTimer = null;

// ── Verbindung ──

function connect() {
  if (ws) return;
  if (!BACKEND_WS_URL) { console.error("dataClient: BACKEND_WS_URL nicht konfiguriert"); return; }

  try {
    ws = new WebSocket(BACKEND_WS_URL);
  } catch (err) {
    console.error("dataClient: WebSocket Fehler:", err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connected = true;
    console.log("dataClient: verbunden");
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      // Ping vom Server → Pong antworten (KeepAlive)
      if (msg.type === "ping") {
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "pong" }));
        }
        return;
      }

      // Score-Push
      if (msg.type === "scores" && onScoreChange) {
        onScoreChange(msg.data);
        return;
      }

      // Response auf Request
      if (msg.type === "response" && msg.id) {
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.id);
          pending.resolve(msg.data);
        }
      }
    } catch (err) {
      // silent
    }
  };

  ws.onclose = () => {
    connected = false;
    ws = null;
    console.log("dataClient: getrennt");
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose wird danach aufgerufen
  };
}

function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { const w = ws; ws = null; connected = false; w.close(); }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!connected) connect();
  }, RECONNECT_DELAY);
}

// ── Request an Service ──

const MAX_CONNECT_WAIT = 10000; // Max 10s auf Verbindung warten
const CONNECT_CHECK_INTERVAL = 200;

export function request(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    if (ws && connected) {
      sendRequest(endpoint, params, resolve, reject);
      return;
    }

    // Verbindung noch nicht da → verbinden und warten
    connect();
    let waited = 0;
    const checkInterval = setInterval(() => {
      waited += CONNECT_CHECK_INTERVAL;
      if (ws && connected) {
        clearInterval(checkInterval);
        sendRequest(endpoint, params, resolve, reject);
      } else if (waited >= MAX_CONNECT_WAIT) {
        clearInterval(checkInterval);
        reject(new Error("WebSocket nicht verbunden nach " + (MAX_CONNECT_WAIT / 1000) + "s"));
      }
    }, CONNECT_CHECK_INTERVAL);
  });
}

function sendRequest(endpoint, params, resolve, reject) {
  requestIdCounter++;
  const id = "req-" + requestIdCounter;

  const timer = setTimeout(() => {
    pendingRequests.delete(id);
    reject(new Error(`Request Timeout: ${endpoint}`));
  }, REQUEST_TIMEOUT);

  pendingRequests.set(id, { resolve, reject, timer });

  ws.send(JSON.stringify({ type: "request", id, endpoint, params }));
}

// ── Wrapper für Kompatibilität mit bestehendem Code ──
// Gibt { data: { success, values, ... } } zurück wie httpsCallable

export function createEndpoint(endpoint) {
  return async function(params = {}) {
    const data = await request(endpoint, params);
    return { data };
  };
}

// ── Score-Listener ──

export function setOnScoreChange(callback) {
  onScoreChange = callback;
}

// ── Status ──

export function isConnected() {
  return connected;
}

// ── Auto-Connect ──
connect();
