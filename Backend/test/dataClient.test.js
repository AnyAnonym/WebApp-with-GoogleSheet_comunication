const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.listeners = new Map();
    this.closeCode = null;
    this.closeReason = "";
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }

  dispatch(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) callback(event);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open");
  }

  send(value) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket closed");
    this.sent.push(JSON.parse(value));
  }

  receive(message) {
    this.dispatch("message", { data: JSON.stringify(message) });
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code, reason });
  }
}

function loadDataClient({ cryptoImplementation } = {}) {
  FakeWebSocket.instances = [];
  const intervals = new Set();
  const timeouts = new Set();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const localValues = new Map();
  const trackedSetTimeout = (callback, delay, ...args) => {
    const timer = setTimeout(() => {
      timeouts.delete(timer);
      callback(...args);
    }, delay);
    timeouts.add(timer);
    return timer;
  };
  const trackedClearTimeout = (timer) => {
    timeouts.delete(timer);
    clearTimeout(timer);
  };
  const trackedSetInterval = (callback, delay, ...args) => {
    const timer = setInterval(callback, delay, ...args);
    intervals.add(timer);
    return timer;
  };
  const trackedClearInterval = (timer) => {
    intervals.delete(timer);
    clearInterval(timer);
  };
  let uuidCounter = 0;
  const context = vm.createContext({
    URL,
    WebSocket: FakeWebSocket,
    clearInterval: trackedClearInterval,
    clearTimeout: trackedClearTimeout,
    console,
    crypto: cryptoImplementation || { randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}` },
    document: {
      hidden: false,
      addEventListener(type, callback) { documentListeners.set(type, callback); },
    },
    localStorage: {
      getItem(key) { return localValues.get(key) || null; },
      setItem(key, value) { localValues.set(key, String(value)); },
    },
    navigator: { onLine: true },
    setInterval: trackedSetInterval,
    setTimeout: trackedSetTimeout,
    window: {
      APP_VERSION: "test",
      location: { href: "http://test.local/scoreboard.html", pathname: "/scoreboard.html", protocol: "http:" },
      addEventListener(type, callback) { windowListeners.set(type, callback); },
    },
  });
  const filename = path.resolve(__dirname, "../../Frontend/JS/dataClient.js");
  const exported = [];
  let source = fs.readFileSync(filename, "utf8").replace(
    /\bexport\s+(async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g,
    (_match, asyncKeyword = "", name) => {
      exported.push(name);
      return `${asyncKeyword}function ${name}(`;
    },
  );
  source += `\nglobalThis.__dataClientExports = { ${exported.join(", ")} };`;
  new vm.Script(source, { filename }).runInContext(context);
  return {
    api: context.__dataClientExports,
    intervals,
    sockets: FakeWebSocket.instances,
    timeouts,
    windowListeners,
  };
}

test("dataClient korreliert Requests, propagiert Fehler und stellt Subscriptions wieder her", async (t) => {
  const runtime = loadDataClient();
  const { api, sockets } = runtime;
  t.after(() => api.disconnect());
  assert.equal(sockets.length, 1);
  const firstSocket = sockets[0];
  assert.equal(firstSocket.url, "ws://test.local/ws");
  firstSocket.open();
  await Promise.resolve();
  assert.equal(firstSocket.sent[0].type, "hello");
  assert.equal(firstSocket.sent[0].v, 2);
  firstSocket.receive({
    type: "welcome",
    v: 2,
    protocol: 2,
    principal: { type: "anonymous", role: "anonymous" },
  });
  assert.equal(api.isConnected(), true);

  let invalidationRefreshes = 0;
  const stopInvalidations = api.subscribeInvalidations(["matches"], () => {
    invalidationRefreshes += 1;
  }, { delayMs: 1 });
  firstSocket.receive({ type: "event", v: 2, topic: "matches", data: { revision: 1 } });
  firstSocket.receive({ type: "event", v: 2, topic: "matches", data: { revision: 2 } });
  firstSocket.receive({ type: "event", v: 2, topic: "matches", data: { revision: 3 } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(invalidationRefreshes, 1);

  const requestPromise = api.request("players", {});
  await Promise.resolve();
  const requestMessage = firstSocket.sent.find((message) => message.type === "request");
  assert.equal(requestMessage.v, 2);
  firstSocket.receive({
    type: "response",
    v: 2,
    id: requestMessage.id,
    endpoint: "players",
    supportId: "support-1",
    data: { success: false, error: { code: "TEST_ERROR", message: "Testfehler" } },
  });
  await assert.rejects(requestPromise, (error) => {
    assert.equal(error.code, "TEST_ERROR");
    assert.equal(error.supportId, "support-1");
    return true;
  });

  const scoreEvents = [];
  const unsubscribe = api.subscribe("scores", (data) => scoreEvents.push(data));
  assert.equal(firstSocket.sent.at(-1).type, "subscribe");
  const reconnecting = api.restartConnection();
  assert.equal(sockets.length, 2);
  const secondSocket = sockets[1];
  secondSocket.open();
  secondSocket.receive({
    type: "welcome",
    v: 2,
    protocol: 2,
    principal: { type: "anonymous", role: "anonymous" },
  });
  await reconnecting;
  const secondSubscribe = secondSocket.sent.filter((message) => message.type === "subscribe").at(-1);
  assert.deepEqual([...secondSubscribe.topics].sort(), ["matches", "scores"]);
  secondSocket.receive({ type: "event", v: 2, topic: "scores", data: { revision: 7 } });
  assert.equal(scoreEvents[0].revision, 7);

  secondSocket.receive({ type: "ping", v: 2, ts: Date.now() });
  secondSocket.close(1008, "policy violation");
  assert.equal(secondSocket.closeCode, 1008);
  stopInvalidations();
  unsubscribe();
  api.disconnect();
  assert.equal(api.isConnected(), false);
  assert.equal(runtime.intervals.size, 0);
  assert.equal(runtime.timeouts.size, 0);
});

test("dataClient lehnt Pending Requests bei Verbindungsabbruch sofort ab", async (t) => {
  const runtime = loadDataClient();
  t.after(() => runtime.api.disconnect());
  const socket = runtime.sockets[0];
  socket.open();
  socket.receive({ type: "welcome", v: 2, protocol: 2, principal: { type: "anonymous", role: "anonymous" } });
  const pending = runtime.api.request("players", {});
  await Promise.resolve();
  socket.close(1006, "network lost");
  await assert.rejects(pending, /getrennt/);
  runtime.api.disconnect();
  assert.equal(runtime.intervals.size, 0);
  assert.equal(runtime.timeouts.size, 0);
});

test("operationId bleibt ohne randomUUID ein gueltiger UUID-v4-Wert", (t) => {
  let next = 0;
  const runtime = loadDataClient({
    cryptoImplementation: {
      getRandomValues(bytes) {
        for (let index = 0; index < bytes.length; index++) bytes[index] = next++;
        return bytes;
      },
    },
  });
  t.after(() => runtime.api.disconnect());
  assert.match(runtime.api.createOperationId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("Writes werden nach einem temporaeren Fehler nicht automatisch wiederholt", async (t) => {
  const runtime = loadDataClient();
  t.after(() => runtime.api.disconnect());
  const socket = runtime.sockets[0];
  socket.open();
  socket.receive({ type: "welcome", v: 2, protocol: 2, principal: { type: "user", role: "operator" } });
  const params = { operationId: "00000000-0000-4000-8000-000000000230", monitorId: "monitor-1", direction: "down" };
  const pending = runtime.api.request("monitorScroll", params);
  await Promise.resolve();
  const first = socket.sent.find((message) => message.type === "request");
  socket.receive({
    type: "response",
    v: 2,
    id: first.id,
    endpoint: "monitorScroll",
    data: { success: false, error: { code: "MONITOR_OFFLINE", message: "offline" } },
  });
  await assert.rejects(pending, (error) => error.code === "MONITOR_OFFLINE");
  const requests = socket.sent.filter((message) => message.type === "request");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].params.operationId, params.operationId);
});

test("dataClient lehnt Responses mit falschem Endpoint ab", async (t) => {
  const runtime = loadDataClient();
  t.after(() => runtime.api.disconnect());
  const socket = runtime.sockets[0];
  socket.open();
  socket.receive({ type: "welcome", v: 2, protocol: 2, principal: { type: "anonymous", role: "anonymous" } });
  const pending = runtime.api.request("players", {});
  await Promise.resolve();
  const request = socket.sent.find((message) => message.type === "request");
  socket.receive({ type: "response", v: 2, id: request.id, endpoint: "matches1", data: { success: true } });
  await assert.rejects(pending, (error) => error.code === "PROTOCOL_MISMATCH");
  assert.equal(socket.closeCode, 4406);
});

test("Reconnect stellt mehr als zwanzig Subscriptions in mehreren Batches wieder her", async (t) => {
  const runtime = loadDataClient();
  t.after(() => runtime.api.disconnect());
  const first = runtime.sockets[0];
  first.open();
  first.receive({ type: "welcome", v: 2, protocol: 2, principal: { type: "user", role: "operator" } });
  const unsubscribers = Array.from({ length: 25 }, (_, index) => runtime.api.subscribe(`monitor-status:m-${index}`, () => {}));

  const reconnecting = runtime.api.restartConnection();
  const second = runtime.sockets[1];
  second.open();
  second.receive({ type: "welcome", v: 2, protocol: 2, principal: { type: "user", role: "operator" } });
  await reconnecting;
  const batches = second.sent.filter((message) => message.type === "subscribe").map((message) => message.topics.length);
  assert.deepEqual(batches, [20, 5]);
  for (const unsubscribe of unsubscribers) unsubscribe();
});

test("terminale Close-Codes koennen durch Lifecycle-Events nicht neu gestartet werden", async (t) => {
  const runtime = loadDataClient();
  const unhandled = [];
  const unhandledListener = (error) => unhandled.push(error);
  const uncaughtListener = (error) => unhandled.push(error);
  process.on("uncaughtException", uncaughtListener);
  process.on("unhandledRejection", unhandledListener);
  const socket = runtime.sockets[0];
  socket.open();
  socket.receive({ type: "welcome", v: 2, protocol: 2, principal: { type: "anonymous", role: "anonymous" } });
  socket.close(1008, "policy violation");

  await assert.rejects(runtime.api.restartConnection(), (error) => error.code === "TERMINAL_CONNECTION");
  assert.equal(runtime.sockets.length, 1);
  const recovery = runtime.api.restartConnection({ allowTerminal: true });
  const replacement = runtime.sockets[1];
  replacement.open();
  replacement.receive({ type: "welcome", v: 2, protocol: 2, principal: { type: "anonymous", role: "anonymous" } });
  await recovery;
  assert.equal(runtime.api.isConnected(), true);
  runtime.api.disconnect();
  assert.equal(runtime.api.isConnected(), false);
  assert.equal(runtime.intervals.size, 0);
  assert.equal(runtime.timeouts.size, 0);
  process.off("unhandledRejection", unhandledListener);
  process.off("uncaughtException", uncaughtListener);
  if (unhandled.length) {
    throw unhandled[0];
  }
});
