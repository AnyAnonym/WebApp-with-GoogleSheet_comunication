const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadFrontendModule(relativePath, exportNames, globals = {}) {
  const filename = path.resolve(__dirname, "../../Frontend/JS", relativePath);
  let source = fs.readFileSync(filename, "utf8")
    .replace(/\bexport\s+(?=(?:const|function|async\s+function)\b)/g, "");
  source += `\nglobalThis.__exports = { ${exportNames.join(", ")} };`;
  const context = vm.createContext({ console, Date, ...globals });
  context.globalThis = context;
  new vm.Script(source, { filename }).runInContext(context);
  return context.__exports;
}

test("Scoreboard-Namensgroesse ignoriert unvermeidbare feste Ueberhoehe", () => {
  const { largestPlayerNameSize } = loadFrontendModule("scoreboardSizing.js", ["largestPlayerNameSize"]);
  const measured = [];
  const fontSize = largestPlayerNameSize({
    minimum: 8,
    maximum: 88,
    measure(candidate) {
      measured.push(candidate);
      return {
        widthFits: candidate <= 64,
        overflow: 120 + Math.max(0, candidate - 48),
      };
    },
  });

  assert.equal(fontSize > 47, true);
  assert.equal(fontSize <= 49, true);
  assert.equal(measured.includes(8), true);
  assert.equal(measured.includes(88), true);
});

test("Scoreboard-Namensgroesse bleibt durch die reale Textbreite begrenzt", () => {
  const { largestPlayerNameSize } = loadFrontendModule("scoreboardSizing.js", ["largestPlayerNameSize"]);
  const fontSize = largestPlayerNameSize({
    minimum: 8,
    maximum: 88,
    measure: (candidate) => ({ widthFits: candidate <= 36, overflow: 0 }),
  });

  assert.equal(fontSize > 35, true);
  assert.equal(fontSize <= 37, true);
});

test("Ranglistenmatches erkennen nur exakte [wo]- und [ret]-Abschluesse", () => {
  const { isOpenRankingMatch, parseRankingParticipant, rankingPlayerState } = loadFrontendModule(
    "rankingMatchState.js",
    ["isOpenRankingMatch", "parseRankingParticipant", "rankingPlayerState"],
  );
  const indexes = { result: 0, p1: 1, p2: -1, p3: 2, p4: -1 };

  assert.equal(isOpenRankingMatch(["", "p1", "p2"], indexes), true);
  assert.equal(isOpenRankingMatch(["6-4/6-4", "p1", "p2"], indexes), false);
  assert.equal(isOpenRankingMatch(["", "p1 [wo]", "p2"], indexes), false);
  assert.equal(isOpenRankingMatch(["", "p1", "p2 [ret]"], indexes), false);
  assert.equal(isOpenRankingMatch(["", "p1 [w.o.]", "p2"], indexes), true);
  assert.equal(isOpenRankingMatch(["", "p1 [WO]", "p2"], indexes), true);
  assert.equal(isOpenRankingMatch(["", "p1 [wo] text", "p2"], indexes), true);
  assert.deepEqual(JSON.parse(JSON.stringify(parseRankingParticipant("p1 [wo]"))), { id: "p1", special: "wo" });
  assert.deepEqual(JSON.parse(JSON.stringify(parseRankingParticipant("p2 [RET]"))), { id: "p2 [RET]", special: null });

  const ownProtection = rankingPlayerState("p1", "p1", new Set(), new Map([["p1", new Date()]]), new Map());
  const ownBlock = rankingPlayerState("p1", "p1", new Set(), new Map(), new Map([["p1", new Date()]]));
  assert.deepEqual(JSON.parse(JSON.stringify(ownProtection)), { selected: true, status: "protection" });
  assert.deepEqual(JSON.parse(JSON.stringify(ownBlock)), { selected: true, status: "blocked" });
});

test("Frontenddiagnose filtert Level und verlangt benannte Events", () => {
  const { createDiagnosticAdapter } = loadFrontendModule("diagnostics.js", ["createDiagnosticAdapter"]);
  const entries = [];
  const adapter = createDiagnosticAdapter({
    level: "warn",
    now: () => new Date("2026-08-07T10:00:00.000Z"),
    write: (_level, entry) => entries.push(entry),
  });

  assert.equal(adapter.info("hidden_event", { count: 1 }), false);
  assert.equal(adapter.warn("invalid event", { count: 2 }), false);
  assert.equal(adapter.warn("visible_event", { count: 3 }), true);
  assert.equal(adapter.setLevel("debug"), true);
  assert.equal(adapter.debug("debug_event"), true);
  assert.equal(adapter.setLevel("verbose"), false);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].event, "visible_event");
  assert.equal(entries[0].timestamp, "2026-08-07T10:00:00.000Z");
});

test("Frontenddiagnose redigiert rekursiv und begrenzt Felder", () => {
  const { createDiagnosticAdapter } = loadFrontendModule("diagnostics.js", ["createDiagnosticAdapter"]);
  const entries = [];
  const adapter = createDiagnosticAdapter({
    level: "debug",
    maxDepth: 2,
    maxEntries: 2,
    maxStringLength: 24,
    write: (_level, entry) => entries.push(entry),
  });
  const nested = { email: "person@example.test", inner: { token: "secret", deeper: { value: "hidden" } } };
  adapter.info("redaction_test", { payload: { password: "secret" }, nested, ignored: "third" });

  const entry = entries[0];
  assert.equal(entry.payload, "[REDACTED]");
  assert.equal(entry.nested.email, "[REDACTED]");
  assert.equal(entry.nested.inner, "[TRUNCATED]");
  assert.equal(entry.ignored, undefined);
  assert.equal(nested.email, "person@example.test");
});

test("Frontenddiagnose projiziert Fehler ohne Meldung, Stack oder Details", () => {
  const { createDiagnosticAdapter, projectDiagnosticError } = loadFrontendModule(
    "diagnostics.js",
    ["createDiagnosticAdapter", "projectDiagnosticError"],
  );
  const error = Object.assign(new Error("Kontakt person@example.test mit Token geheim"), {
    code: "HTTP_TIMEOUT",
    category: "timeout",
    supportId: "support-123",
    details: { passwordHash: "secret" },
  });
  const projection = projectDiagnosticError(error);
  assert.deepEqual(JSON.parse(JSON.stringify(projection)), {
    code: "HTTP_TIMEOUT",
    category: "timeout",
    supportId: "support-123",
    message: "Der Vorgang hat zu lange gedauert.",
  });

  const entries = [];
  const adapter = createDiagnosticAdapter({ level: "debug", write: (_level, entry) => entries.push(entry) });
  adapter.error("request_failed", error, { attempt: 2 });
  assert.equal(entries[0].error.code, "HTTP_TIMEOUT");
  assert.equal(entries[0].error.stack, undefined);
  assert.equal(entries[0].error.details, undefined);
  assert.equal(JSON.stringify(entries[0]).includes("person@example.test"), false);
  assert.equal(JSON.stringify(entries[0]).includes("geheim"), false);
});

test("Profilbereinigung entfernt Namen, Kontaktdaten, Aktionen und Scope", () => {
  const { clearProfileModalContent } = loadFrontendModule("profileModalState.js", ["clearProfileModalContent"]);
  const name = { textContent: "Erika Beispiel" };
  const text = { children: [{ textContent: "erika@example.test" }], replaceChildren() { this.children = []; } };
  const action = { handler: () => "sensitive action" };
  let handlersAborted = false;
  const actionController = { abort() { handlersAborted = true; } };
  const actions = {
    children: [action],
    replaceChildren() { this.children = []; },
    style: { setProperty(nameValue, value, priority) { this.value = [nameValue, value, priority]; } },
  };
  const modal = {
    dataset: { profileScope: "private" },
    removeAttribute(nameValue) { if (nameValue === "data-profile-scope") delete this.dataset.profileScope; },
    querySelector(selector) {
      return { "#profileName": name, "#profileText": text, "#profileActions": actions }[selector] || null;
    },
  };

  clearProfileModalContent(modal, actionController);
  assert.equal(name.textContent, "Profil");
  assert.deepEqual(text.children, []);
  assert.deepEqual(actions.children, []);
  assert.deepEqual(actions.style.value, ["display", "none", "important"]);
  assert.equal(modal.dataset.profileScope, undefined);
  assert.equal(handlersAborted, true);
});

test("Frontenddiagnose uebertraegt nur die kontrollierte Projektion gebuendelt", async () => {
  const requests = [];
  const crypto = { randomUUID: () => "00000000-0000-4000-8000-000000000001" };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200 };
  };
  const { applyDiagnosticPolicy, diagnostic } = loadFrontendModule(
    "diagnostics.js",
    ["applyDiagnosticPolicy", "diagnostic"],
    {
      APP_VERSION: "4.3.0-test",
      console: { debug() {}, error() {}, info() {}, log() {}, warn() {} },
      crypto,
      fetch,
      location: { pathname: "/scoreboard.html" },
    },
  );
  applyDiagnosticPolicy({
    enabled: true,
    level: "debug",
    targeted: true,
    sampleRatePercent: 100,
    batchSize: 1,
    flushIntervalMs: 5000,
  });
  const error = Object.assign(new Error("private free text"), {
    code: "REQUEST_TIMEOUT",
    category: "timeout",
    supportId: "support-1",
    details: { token: "secret" },
  });
  diagnostic.warn("rpc_request_failed", {
    error,
    endpoint: "players",
    durationMs: 45000,
    attemptCount: 3,
    payload: { personId: "p1" },
  });
  await Promise.resolve();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/frontend-events");
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.pageType, "scoreboard");
  assert.equal(body.clientSessionId, "00000000-0000-4000-8000-000000000001");
  assert.deepEqual(body.events[0], {
    event: "rpc_request_failed",
    level: "warn",
    timestamp: body.events[0].timestamp,
    attemptCount: 3,
    durationMs: 45000,
    endpoint: "players",
    code: "REQUEST_TIMEOUT",
    category: "timeout",
    supportId: "support-1",
  });
  assert.equal(requests[0].options.body.includes("private free text"), false);
  assert.equal(requests[0].options.body.includes("personId"), false);
  assert.equal(requests[0].options.body.includes("secret"), false);
});

test("Gezielte Diagnose zeigt der betroffenen Person einen Hinweis bis zum Ablauf", () => {
  let notice = null;
  const body = {
    appendChild(element) { notice = element; },
  };
  const document = {
    body,
    createElement() {
      return {
        setAttribute() {},
        remove() { notice = null; },
        textContent: "",
      };
    },
    getElementById(id) { return id === "diagnostic-mode-notice" ? notice : null; },
  };
  const { applyDiagnosticPolicy } = loadFrontendModule(
    "diagnostics.js",
    ["applyDiagnosticPolicy"],
    { crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" }, document },
  );
  applyDiagnosticPolicy({
    enabled: true,
    level: "debug",
    targeted: true,
    expiresAt: Date.now() + 60000,
    sampleRatePercent: 100,
    batchSize: 10,
    flushIntervalMs: 5000,
  });
  assert.match(notice.textContent, /Temporäre technische Diagnose ist bis/);
  applyDiagnosticPolicy({ enabled: false, level: "warn" });
  assert.equal(notice, null);
});

test("Frontendtransport sendet auch bei vollem Batch nur einen Request gleichzeitig", async () => {
  const requests = [];
  let releaseFirst;
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });
  const fetch = (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? firstResponse : Promise.resolve({ ok: true, status: 200 });
  };
  const { applyDiagnosticPolicy, diagnostic, flushDiagnosticEvents } = loadFrontendModule(
    "diagnostics.js",
    ["applyDiagnosticPolicy", "diagnostic", "flushDiagnosticEvents"],
    {
      APP_VERSION: "4.3.0-test",
      console: { debug() {}, error() {}, info() {}, log() {}, warn() {} },
      crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000010" },
      fetch,
      location: { pathname: "/scoreboard.html" },
    },
  );
  applyDiagnosticPolicy({
    enabled: true,
    level: "warn",
    sampleRatePercent: 100,
    batchSize: 1,
    flushIntervalMs: 5000,
  });
  diagnostic.warn("rpc_request_failed", { code: "REQUEST_TIMEOUT" });
  diagnostic.warn("rpc_request_failed", { code: "REQUEST_TIMEOUT" });
  assert.equal(requests.length, 1);

  releaseFirst({ ok: true, status: 200 });
  await flushDiagnosticEvents();
  await flushDiagnosticEvents();
  assert.equal(requests.length, 2);
});

test("Ablauf einer Zielpolicy laedt die weiterhin globale Policy neu", async () => {
  const timers = [];
  const { applyDiagnosticPolicy, getDiagnosticPolicy, refreshDiagnosticPolicy } = loadFrontendModule(
    "diagnostics.js",
    ["applyDiagnosticPolicy", "getDiagnosticPolicy", "refreshDiagnosticPolicy"],
    {
      clearTimeout() {},
      crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000011" },
      fetch: async () => ({
        ok: true,
        json: async () => ({
          frontendLogging: {
            enabled: true,
            level: "warn",
            targeted: false,
            expiresAt: null,
            sampleRatePercent: 10,
            batchSize: 10,
            flushIntervalMs: 5000,
          },
        }),
      }),
      setTimeout(callback) {
        timers.push(callback);
        return timers.length;
      },
    },
  );
  applyDiagnosticPolicy({
    enabled: true,
    level: "debug",
    targeted: true,
    expiresAt: Date.now() + 60000,
    sampleRatePercent: 100,
    batchSize: 10,
    flushIntervalMs: 5000,
  });
  timers[0]();
  await refreshDiagnosticPolicy();
  assert.deepEqual(JSON.parse(JSON.stringify(getDiagnosticPolicy())), {
    enabled: true,
    level: "warn",
    targeted: false,
    expiresAt: null,
    sampleRatePercent: 10,
    batchSize: 10,
    flushIntervalMs: 5000,
  });
});

test("Pagehide begrenzt den letzten Beacon auf einen Request mit zwanzig Events", () => {
  const listeners = new Map();
  const beacons = [];
  class FakeBlob {
    constructor(parts) { this.text = parts.join(""); }
  }
  const { applyDiagnosticPolicy, diagnostic } = loadFrontendModule(
    "diagnostics.js",
    ["applyDiagnosticPolicy", "diagnostic"],
    {
      Blob: FakeBlob,
      addEventListener(type, callback) { listeners.set(type, callback); },
      clearInterval() {},
      clearTimeout() {},
      console: { debug() {}, error() {}, info() {}, log() {}, warn() {} },
      crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000012" },
      document: { addEventListener() {}, body: {}, hidden: false, getElementById() { return null; } },
      location: { pathname: "/scoreboard.html" },
      navigator: {
        sendBeacon(url, payload) {
          beacons.push({ url, body: JSON.parse(payload.text) });
          return true;
        },
      },
      setInterval() { return 1; },
      setTimeout() { return 1; },
    },
  );
  applyDiagnosticPolicy({
    enabled: true,
    level: "warn",
    sampleRatePercent: 100,
    batchSize: 20,
    flushIntervalMs: 5000,
  });
  for (let index = 0; index < 25; index++) {
    diagnostic.warn("rpc_request_failed", { code: "REQUEST_TIMEOUT" });
  }
  listeners.get("pagehide")({ persisted: false });
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0].url, "/api/frontend-events");
  assert.equal(beacons[0].body.events.length, 20);
});
