const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadAuthClient(fetchImplementation, { locks } = {}) {
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
    setInterval: () => 1,
    setTimeout: unrefTimeout,
    window: {
      addEventListener(type, callback) { windowListeners.set(type, callback); },
    },
  });
  context.globalThis = context;
  const filename = path.resolve(__dirname, "../../Frontend/JS/authClient.js");
  const exported = [];
  let source = fs.readFileSync(filename, "utf8")
    .replace(/^import .*$/m, "const restartConnection = async () => {};" )
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
  for (let attempt = 0; attempt < 20 && calls.length === 0; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(calls, ["POST /api/session"]);
  releaseLogin();
  await Promise.all([login, logout]);
  assert.deepEqual(calls, ["POST /api/session", "DELETE /api/session"]);
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
