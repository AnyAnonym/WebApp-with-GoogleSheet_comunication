const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function loadAuthClient(fetchImplementation, { locks, restartConnection = async () => {} } = {}) {
  const windowListeners = new Map();
  const unrefTimeout = (callback, delay, ...args) => {
    const timer = setTimeout(callback, delay, ...args);
    timer.unref?.();
    return timer;
  };
  const context = vm.createContext({
    AbortController,
    TextEncoder,
    clearTimeout,
    console,
    crypto: globalThis.crypto,
    document: { hidden: false, addEventListener() {} },
    fetch: fetchImplementation,
    navigator: locks ? { locks } : {},
    __restartConnection: restartConnection,
    setInterval: () => 1,
    setTimeout: unrefTimeout,
    window: {
      addEventListener(type, callback) { windowListeners.set(type, callback); },
    },
  });
  context.globalThis = context;
  const filename = path.resolve(__dirname, "../../Frontend/JS/authClient.js");
  const exported = [];
  let source = `const restartConnection = globalThis.__restartConnection;\nconst diagnostic = { error() {} };\nconst applyDiagnosticPolicy = () => {};\n${fs.readFileSync(filename, "utf8")}`
    .replace(/^import .*$/gm, "")
    .replace(/\bexport\s+(async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g, (_match, asyncKeyword = "", name) => {
      exported.push(name);
      return `${asyncKeyword}function ${name}(`;
    })
    .replace("export const ready =", "const ready =");
  source += `\nglobalThis.__authClient = { ready, ${exported.join(", ")} };`;
  new vm.Script(source, { filename }).runInContext(context);
  return context.__authClient;
}

test("initialer Sessionfehler bleibt vom abgemeldeten Zustand unterscheidbar", async () => {
  const api = loadAuthClient(async () => { throw new Error("network unavailable"); });
  const states = [];
  api.subscribeAuth((user, state) => states.push({ user, status: state.status }));
  await api.ready;

  assert.equal(states.at(-1).user, undefined);
  assert.equal(states.at(-1).status, "unavailable");
  assert.equal(api.getAuthState().status, "unavailable");
  assert.equal(api.getUser(), null);
});

test("Login und Logout werden serialisiert, damit kein spaeter Login-Cookie den Logout ueberholt", async () => {
  let releaseLogin;
  const loginGate = new Promise((resolve) => { releaseLogin = resolve; });
  const calls = [];
  const response = (body) => ({ ok: true, status: 200, json: async () => body });
  const api = loadAuthClient(async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push(`${method} ${url}`);
    if (method === "GET") return response({ success: true, authenticated: false, user: null, expiresAt: null, serverTime: Date.now() });
    if (method === "POST" && url === "/api/session") {
      await loginGate;
      return response({ success: true, user: { id: "p1", role: "player" }, expiresAt: Date.now() + 60000, serverTime: Date.now() });
    }
    if (method === "DELETE") return response({ success: true });
    throw new Error(`unexpected request ${method} ${url}`);
  });
  await api.ready;

  const login = api.login("player@example.test", "secret");
  const logout = api.logout();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["GET /api/session", "POST /api/session"]);
  releaseLogin();
  await Promise.all([login, logout]);

  assert.deepEqual(calls, ["GET /api/session", "POST /api/session", "DELETE /api/session"]);
  assert.equal(api.getAuthState().status, "anonymous");
  assert.equal(api.getUser(), null);
});

test("Web Lock serialisiert Auth-Mutationen auch ueber zwei Dokumente", async () => {
  let lockQueue = Promise.resolve();
  const locks = {
    request(_name, _options, callback) {
      const operation = lockQueue.catch(() => {}).then(callback);
      lockQueue = operation.catch(() => {});
      return operation;
    },
  };
  let releaseLogin;
  const loginGate = new Promise((resolve) => { releaseLogin = resolve; });
  const calls = [];
  const response = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetchImplementation = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push(`${method} ${url}`);
    if (method === "GET") return response({ success: true, authenticated: false, user: null, expiresAt: null, serverTime: Date.now() });
    if (method === "POST") {
      await loginGate;
      return response({ success: true, user: { id: "p1", role: "player" }, expiresAt: Date.now() + 60000, serverTime: Date.now() });
    }
    return response({ success: true });
  };
  const firstTab = loadAuthClient(fetchImplementation, { locks });
  const secondTab = loadAuthClient(fetchImplementation, { locks });
  await Promise.all([firstTab.ready, secondTab.ready]);
  calls.length = 0;

  const login = firstTab.login("player@example.test", "secret");
  const logout = secondTab.logout();
  await waitFor(() => calls.length > 0, 1000, "Login hat den gemeinsamen Web Lock nicht erhalten");
  assert.deepEqual(calls, ["POST /api/session"]);
  releaseLogin();
  await Promise.all([login, logout]);
  assert.deepEqual(calls, ["POST /api/session", "DELETE /api/session"]);
});

test("Login und erstmalige Passwortvergabe senden Login statt E-Mail", async () => {
  const requests = [];
  const response = (body) => ({ ok: true, status: 200, json: async () => body });
  const api = loadAuthClient(async (url, options = {}) => {
    if ((options.method || "GET") === "GET") {
      return response({ success: true, authenticated: false, user: null, expiresAt: null, serverTime: Date.now() });
    }
    requests.push({ url, body: JSON.parse(options.body) });
    if (url === "/api/session") {
      return response({ success: true, user: { id: "p1", role: "player", login: "player1" }, expiresAt: Date.now() + 60000, serverTime: Date.now() });
    }
    return response({ success: true });
  });
  await api.ready;

  await api.login("player1", "secret");
  await api.setupPassword("new-player", "new-secret");

  assert.deepEqual(Object.keys(requests[0].body).sort(), ["login", "passwordHash"]);
  assert.equal(requests[0].body.login, "player1");
  assert.match(requests[0].body.passwordHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(requests[1].body).sort(), ["login", "newPasswordHash"]);
  assert.equal(requests[1].body.login, "new-player");
  assert.match(requests[1].body.newPasswordHash, /^[0-9a-f]{64}$/);
});

test("Login aendert Socketidentitaet, Kontakt-E-Mail aktualisiert nur das sichtbare Benutzerprofil", async () => {
  const expiresAt = Date.now() + 60000;
  const users = [
    { id: "p1", role: "player", login: "old-login", email: "old@example.test" },
    { id: "p1", role: "player", login: "new-login", email: "old@example.test" },
    { id: "p1", role: "player", login: "new-login", email: "contact@example.test" },
  ];
  let requestIndex = 0;
  let reconnects = 0;
  const api = loadAuthClient(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      authenticated: true,
      user: users[Math.min(requestIndex++, users.length - 1)],
      expiresAt,
      serverTime: Date.now(),
    }),
  }), { restartConnection: async () => { reconnects += 1; } });
  await api.ready;
  let notifications = 0;
  api.subscribeAuth(() => { notifications += 1; });

  await api.refreshSession({ reconnect: true });
  assert.equal(reconnects, 1);
  assert.equal(notifications, 2);
  assert.equal(api.getUser().login, "new-login");

  await api.refreshSession({ reconnect: true });
  assert.equal(reconnects, 1);
  assert.equal(notifications, 3);
  assert.equal(api.getUser().email, "contact@example.test");
});

test("Admin-Passwortsetzen sendet nur Ziel-ID und clientseitigen Hash", async () => {
  let request = null;
  const response = (body) => ({ ok: true, status: 200, json: async () => body });
  const api = loadAuthClient(async (url, options = {}) => {
    if ((options.method || "GET") === "GET") {
      return response({ success: true, authenticated: false, user: null, expiresAt: null, serverTime: Date.now() });
    }
    request = { url, options };
    return response({ success: true, personId: "p2" });
  });
  await api.ready;

  await api.setPasswordForPerson("p2", "temporary-secret");
  assert.equal(request.url, "/api/admin/password");
  const body = JSON.parse(request.options.body);
  assert.equal(body.personId, "p2");
  assert.match(body.newPasswordHash, /^[0-9a-f]{64}$/);
  assert.equal(request.options.body.includes("temporary-secret"), false);
});
