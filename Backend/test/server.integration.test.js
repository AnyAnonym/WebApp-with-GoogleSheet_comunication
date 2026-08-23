const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocket } = require("ws");
const { peopleFixture, setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { TABLE_CONFIG } = require("../config.js");
const dataStore = require("../dataStore.js");
const { createApplication } = require("../server.js");
const { StateRepository } = require("../stateRepository.js");
const { version: appVersion } = require("../package.json");
const logger = require("../logger.js");
const metrics = require("../metrics.js");

function createSocketClient(url, headers) {
  const socket = new WebSocket(url, { headers });
  const messages = [];
  const waiters = [];
  let requestCounter = 0;
  socket.on("message", (buffer) => {
    const message = JSON.parse(buffer.toString("utf8"));
    const waiterIndex = waiters.findIndex(({ predicate }) => predicate(message));
    if (waiterIndex >= 0) {
      const [{ resolve }] = waiters.splice(waiterIndex, 1);
      resolve(message);
    } else {
      messages.push(message);
    }
  });
  return {
    socket,
    async open() {
      if (socket.readyState === WebSocket.OPEN) return;
      await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
    },
    next(predicate = () => true) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve(message) {
            clearTimeout(timer);
            resolve(message);
          },
        };
        const timer = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error("WebSocket-Testnachricht nicht empfangen"));
        }, 3000);
        waiters.push(waiter);
      });
    },
    async handshake(pageType = "test", clientVersion = appVersion) {
      await this.open();
      socket.send(JSON.stringify({
        type: "hello",
        v: 2,
        protocol: 2,
        clientId: "00000000-0000-4000-8000-000000000010",
        deviceId: "00000000-0000-4000-8000-000000000011",
        pageType,
        appVersion: clientVersion,
      }));
      return this.next((message) => message.type === "welcome");
    },
    async request(endpoint, params = {}) {
      const id = `integration-${++requestCounter}`;
      socket.send(JSON.stringify({ v: 2, type: "request", id, endpoint, params }));
      return this.next((message) => message.type === "response" && message.id === id);
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise((resolve) => {
        socket.once("close", resolve);
        socket.close(1000, "test complete");
      });
    },
  };
}

function nextClose(socket) {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason?.toString?.() || "" }));
  });
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function rejectedUpgrade(url, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: origin } });
    socket.once("open", () => reject(new Error("WebSocket-Upgrade wurde unerwartet akzeptiert")));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("error", () => {});
  });
}

test("HTTP-Session und WebSocket-Rollen funktionieren zusammen", async (t) => {
  metrics.resetForTests();
  const logEntries = [];
  t.mock.method(logger, "log", (level, event, fields = {}) => logEntries.push({ level, event, fields }));
  dataStore.resetForTests();
  const people = peopleFixture();
  people[0].push("CD-ID", "Login");
  people[1].push("", "ada.login");
  people[2].push("", "peter.login");
  people.push(["p3", "Olivia", "Operator", "operator@example.test", "c".repeat(64), "", "+43999", "2", "1", "operator", "", "", "operator.login"]);
  dataStore.set("players", people, { source: "test" });
  dataStore.set("bewerbe", [["ID", "Bezeichnung", "BewerbsartID", "Geschlecht", "MatchtypID Standard"], ["cup-1", "Cup", "type-1", "2", "1"]], { source: "test" });
  dataStore.set("bewerbsart", [["ID", "Bezeichnung"], ["type-1", "Turnier"]], { source: "test" });
  dataStore.set("matchtyp", [["ID", "Bezeichnung", "Satztiebreak", "Entscheidender Satz"], ["1", "Normal", "6-6", "vollstaendiger Satz"], ["2", "Kurzsatz", "3-3", "MT10"]], { source: "test" });
  dataStore.set("matches1", [[
    "Ignore", "ID", "MatchDate", "ForderungDate", "BewerbID", "BewerbRunde",
    "Spieler1ID", "Spieler2ID", "Spieler3ID", "Spieler4ID", "Ergebnis", "MatchtypID", "InternalNote",
  ], ["", "m1", "260101-1200", "", "cup-1", "F", "p1", "", "p2", "", "6-4/6-4", "2", "secret-note"]], { source: "test" });
  dataStore.set("rlPlatzierung", [["ID", "BewerbID", "PersonID", "Rang"], ["r1", "cup-1", "p1", "1"]], { source: "test" });
  dataStore.set("navigator", [["ID", "Name", "Ziel", "Profil"], ["n1", "Scoreboard", "/scoreboard.html", "1"]], { source: "test" });
  dataStore.set("entryList", [["ID", "BewerbID", "PersonenID", "Entrydate", "PaymentStatus"], ["e1", "cup-1", "p1", "260101-1200", "paid"]], { source: "test" });

  const repository = new StateRepository(":memory:");
  const sheetService = {
    async setPasswordHash(personId, storedHash) {
      const current = structuredClone(dataStore.get("players"));
      const row = current.slice(1).find((entry) => entry[0] === personId);
      row[4] = storedHash;
      row[5] = "";
      dataStore.set("players", current, { source: "write" });
    },
    async setPasswordSetupAllowed(personId, allowed) {
      const current = structuredClone(dataStore.get("players"));
      const row = current.slice(1).find((entry) => entry[0] === personId);
      row[5] = allowed ? "x" : "";
      dataStore.set("players", current, { source: "write" });
    },
    status() { return {}; },
    async stop() {},
  };
  const application = createApplication({ repository, sheetService });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => application.shutdown("test"));

  const address = application.server.address();
  const httpBase = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;

  const anonymousSession = await fetch(`${httpBase}/api/session`);
  assert.equal(anonymousSession.status, 200);
  assert.match(anonymousSession.headers.get("x-request-id"), /^[0-9a-f-]{36}$/i);
  const anonymousSessionData = await anonymousSession.json();
  assert.equal(Number.isFinite(anonymousSessionData.serverTime), true);
  delete anonymousSessionData.serverTime;
  assert.deepEqual(anonymousSessionData, {
    success: true,
    authenticated: false,
    user: null,
    expiresAt: null,
    frontendLogging: {
      enabled: false,
      level: "warn",
      targeted: false,
      expiresAt: null,
      sampleRatePercent: 10,
      batchSize: 10,
      flushIntervalMs: 5000,
    },
  });

  const readinessResponse = await fetch(`${httpBase}/ready`);
  assert.equal(readinessResponse.status, 503);
  assert.deepEqual(await readinessResponse.json(), { status: "not-ready", version: appVersion });
  const metricsResponse = await fetch(`${httpBase}/metrics`);
  assert.equal(metricsResponse.status, 200);
  assert.equal(metricsResponse.headers.get("content-type"), "text/plain; version=0.0.4; charset=utf-8");
  assert.match(metricsResponse.headers.get("x-request-id"), /^[0-9a-f-]{36}$/i);
  const metricsBody = await metricsResponse.text();
  assert.match(metricsBody, /epiber_ready 0/);
  assert.match(metricsBody, /epiber_sqlite_open\{database="state"\} 1/);
  assert.match(metricsBody, /epiber_people_normalization_current 1/);
  assert.match(metricsBody, /epiber_people_normalization_people 3/);
  assert.match(metricsBody, /epiber_people_normalization_affected_people 3/);
  assert.match(metricsBody, /epiber_people_normalization_issues 5/);
  assert.match(metricsBody, /epiber_people_normalization_issue_count\{code="BIRTH_DATE_INVALID"\} 2/);
  assert.match(metricsBody, /epiber_people_normalization_issue_count\{code="PHONE_FORMAT_INVALID"\} 3/);
  assert.equal(metricsBody.includes("p1"), false);
  assert.equal(metricsBody.includes("Ada"), false);
  assert.equal(metricsBody.includes("ada@example.test"), false);
  dataStore.set("players", [["Vorname"], ["Ada"]], { source: "test" });
  const invalidPeopleMetrics = await (await fetch(`${httpBase}/metrics`)).text();
  assert.match(invalidPeopleMetrics, /epiber_people_normalization_current 0/);
  assert.match(invalidPeopleMetrics, /epiber_people_normalization_people 0/);
  dataStore.set("players", people, { source: "test" });
  const metricsMethodResponse = await fetch(`${httpBase}/metrics`, { method: "POST" });
  assert.equal(metricsMethodResponse.status, 405);
  const unauthenticatedStatus = await fetch(`${httpBase}/status`);
  assert.equal(unauthenticatedStatus.status, 401);
  const unauthenticatedStatusId = unauthenticatedStatus.headers.get("x-request-id");
  assert.equal((await unauthenticatedStatus.json()).supportId, unauthenticatedStatusId);
  const unauthenticatedGrafanaAuth = await fetch(`${httpBase}/api/admin/grafana-auth`, {
    headers: { "X-WEBAUTH-USER": "attacker", "X-WEBAUTH-ROLE": "Admin" },
  });
  assert.equal(unauthenticatedGrafanaAuth.status, 401);
  assert.equal(unauthenticatedGrafanaAuth.headers.get("x-webauth-user"), null);
  assert.equal(unauthenticatedGrafanaAuth.headers.get("x-webauth-role"), null);
  assert.equal((await unauthenticatedGrafanaAuth.json()).error.code, "AUTH_REQUIRED");
  const grafanaAuthMethod = await fetch(`${httpBase}/api/admin/grafana-auth`, { method: "POST" });
  assert.equal(grafanaAuthMethod.status, 405);
  assert.equal(grafanaAuthMethod.headers.get("allow"), "GET");
  const methodResponse = await fetch(`${httpBase}/version`, { method: "POST" });
  assert.equal(methodResponse.status, 405);
  const methodRequestId = methodResponse.headers.get("x-request-id");
  assert.match(methodRequestId, /^[0-9a-f-]{36}$/i);
  assert.equal((await methodResponse.json()).supportId, methodRequestId);
  assert.equal(logEntries.some(({ event, fields }) => (
    event === "http_request_completed"
    && fields.supportId === methodRequestId
    && fields.errorCode === "METHOD_NOT_ALLOWED"
    && fields.status === 405
  )), true);
  assert.equal((await fetch(`${httpBase}/missing`)).status, 404);
  assert.equal((await fetch(`${httpBase}/api/session`, { method: "PUT" })).status, 405);
  assert.equal((await fetch(`${httpBase}/api/monitor/session`, { method: "PUT" })).status, 405);

  const wrongOriginLogin = await fetch(`${httpBase}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.test" },
    body: JSON.stringify({ login: "ada.login", passwordHash: "a".repeat(64) }),
  });
  assert.equal(wrongOriginLogin.status, 403);

  const oversizedLogin = await fetch(`${httpBase}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local" },
    body: JSON.stringify({ padding: "x".repeat(3000) }),
  });
  assert.equal(oversizedLogin.status, 413);

  const invalidLogin = await fetch(`${httpBase}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local", "X-Forwarded-For": "192.0.2.10" },
    body: JSON.stringify({ login: " bad login ", passwordHash: "b".repeat(64) }),
  });
  assert.equal(invalidLogin.status, 400);

  const ambiguousLogin = await fetch(`${httpBase}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local" },
    body: JSON.stringify({ login: "ada.login", email: "ada.login", passwordHash: "a".repeat(64) }),
  });
  assert.equal(ambiguousLogin.status, 400);
  const unknownLoginField = await fetch(`${httpBase}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local" },
    body: JSON.stringify({ login: "ada.login", passwordHash: "a".repeat(64), extra: true }),
  });
  assert.equal(unknownLoginField.status, 400);

  const failedLogin = await fetch(`${httpBase}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local", "X-Forwarded-For": "203.0.113.42" },
    body: JSON.stringify({ email: "ADA.LOGIN", passwordHash: "b".repeat(64) }),
  });
  assert.equal(failedLogin.status, 401);

  const loginResponse = await fetch(`${httpBase}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local", "X-Forwarded-For": "198.51.100.20" },
    body: JSON.stringify({ login: "ADA.LOGIN", passwordHash: "a".repeat(64) }),
  });
  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.headers.get("access-control-allow-origin"), "http://test.local");
  assert.equal(loginResponse.headers.get("access-control-allow-credentials"), "true");
  const loginPayload = await loginResponse.json();
  assert.equal(loginPayload.user.role, "admin");
  assert.equal(loginPayload.user.login, "ada.login");
  assert.equal(loginPayload.user.email, "ada@example.test");
  assert.equal(loginPayload.frontendLogging.enabled, false);
  const cookie = loginResponse.headers.get("set-cookie").split(";", 1)[0];
  assert.match(cookie, /^epiber_test_session=/);

  const grafanaAuth = await fetch(`${httpBase}/api/admin/grafana-auth`, {
    headers: { Cookie: cookie, "X-WEBAUTH-USER": "attacker", "X-WEBAUTH-ROLE": "Viewer" },
  });
  assert.equal(grafanaAuth.status, 200);
  assert.equal(grafanaAuth.headers.get("cache-control"), "no-store");
  assert.equal(grafanaAuth.headers.get("x-webauth-user"), "epiber-test:p1");
  assert.equal(grafanaAuth.headers.get("x-webauth-role"), "Admin");
  assert.deepEqual(await grafanaAuth.json(), { success: true });

  const loggingAdminView = await fetch(`${httpBase}/api/admin/frontend-logging`, { headers: { Cookie: cookie } });
  assert.equal(loggingAdminView.status, 200);
  const initialLogging = await loggingAdminView.json();
  assert.equal(initialLogging.settings.enabled, false);
  assert.equal(initialLogging.settings.revision, 0);
  assert.equal(initialLogging.targetsRevision, 0);
  assert.equal(initialLogging.players.some((person) => person.id === "p2" && person.name === "Peter Player"), true);

  const loggingSettingsResponse = await fetch(`${httpBase}/api/admin/frontend-logging`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local", Cookie: cookie },
    body: JSON.stringify({
      expectedRevision: 0,
      enabled: true,
      level: "warn",
      includeAnonymous: false,
      sampleRatePercent: 10,
      batchSize: 10,
      flushIntervalMs: 5000,
      defaultTargetLevel: "debug",
      defaultTargetDurationMinutes: 120,
      normalRetentionDays: 14,
      targetedRetentionDays: 7,
    }),
  });
  assert.equal(loggingSettingsResponse.status, 200);
  assert.equal((await loggingSettingsResponse.json()).settings.revision, 1);

  const loggingTargetResponse = await fetch(`${httpBase}/api/admin/frontend-logging/targets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local", Cookie: cookie },
    body: JSON.stringify({ expectedRevision: 0, personId: "p2", level: "debug", durationMinutes: 60 }),
  });
  assert.equal(loggingTargetResponse.status, 200);
  assert.equal((await loggingTargetResponse.json()).revision, 1);

  const authenticatedSession = await fetch(`${httpBase}/api/session`, { headers: { Cookie: cookie } });
  const authenticatedSessionPayload = await authenticatedSession.json();
  assert.equal(authenticatedSessionPayload.user.email, "ada@example.test");
  assert.equal(authenticatedSessionPayload.user.login, "ada.login");

  const adminPasswordResponse = await fetch(`${httpBase}/api/admin/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local", Cookie: cookie },
    body: JSON.stringify({ personId: "p2", newPasswordHash: "c".repeat(64) }),
  });
  assert.equal(adminPasswordResponse.status, 200);
  assert.deepEqual(await adminPasswordResponse.json(), { success: true, personId: "p2" });

  const setupPermissionResponse = await fetch(`${httpBase}/api/admin/password-setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local", Cookie: cookie },
    body: JSON.stringify({ personId: "p2", allowed: true }),
  });
  assert.equal(setupPermissionResponse.status, 200);
  assert.deepEqual(await setupPermissionResponse.json(), { success: true, personId: "p2", allowed: true });
  const ambiguousSetupResponse = await fetch(`${httpBase}/api/password-setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local" },
    body: JSON.stringify({ login: "peter.login", email: "peter.login", newPasswordHash: "9".repeat(64) }),
  });
  assert.equal(ambiguousSetupResponse.status, 400);
  const unknownSetupFieldResponse = await fetch(`${httpBase}/api/password-setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local" },
    body: JSON.stringify({ login: "peter.login", newPasswordHash: "9".repeat(64), extra: true }),
  });
  assert.equal(unknownSetupFieldResponse.status, 400);
  const setupResponse = await fetch(`${httpBase}/api/password-setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local" },
    body: JSON.stringify({ email: "PETER.LOGIN", newPasswordHash: "9".repeat(64) }),
  });
  assert.equal(setupResponse.status, 200);
  assert.deepEqual(await setupResponse.json(), { success: true });
  const repeatedSetupResponse = await fetch(`${httpBase}/api/password-setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local" },
    body: JSON.stringify({ login: "peter.login", newPasswordHash: "8".repeat(64) }),
  });
  assert.equal(repeatedSetupResponse.status, 401);

  const resetProofResponse = await fetch(`${httpBase}/api/admin/password-reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local", Cookie: cookie },
    body: JSON.stringify({ personId: "p2" }),
  });
  assert.equal(resetProofResponse.status, 200);
  const resetProof = await resetProofResponse.json();
  assert.match(resetProof.resetToken, /^[A-Za-z0-9_-]{32,128}$/);
  const resetResponse = await fetch(`${httpBase}/api/password-reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local" },
    body: JSON.stringify({ resetToken: resetProof.resetToken, newPasswordHash: "d".repeat(64) }),
  });
  assert.equal(resetResponse.status, 200);
  const replayedReset = await fetch(`${httpBase}/api/password-reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local" },
    body: JSON.stringify({ resetToken: resetProof.resetToken, newPasswordHash: "d".repeat(64) }),
  });
  assert.equal(replayedReset.status, 200);
  const conflictingReset = await fetch(`${httpBase}/api/password-reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local" },
    body: JSON.stringify({ resetToken: resetProof.resetToken, newPasswordHash: "e".repeat(64) }),
  });
  assert.equal(conflictingReset.status, 409);

  const publicClient = createSocketClient(`${wsBase}/ws`, { Origin: "http://test.local" });
  const publicWelcome = await publicClient.handshake();
  assert.equal(publicWelcome.principal.role, "anonymous");
  const staleVersionClient = createSocketClient(`${wsBase}/ws`, { Origin: "http://test.local" });
  await staleVersionClient.open();
  staleVersionClient.socket.send(JSON.stringify({
    type: "hello",
    v: 2,
    protocol: 2,
    clientId: "00000000-0000-4000-8000-000000000120",
    deviceId: "00000000-0000-4000-8000-000000000121",
    pageType: "test",
    appVersion: "0.0.0",
  }));
  const staleVersionClose = await nextClose(staleVersionClient.socket);
  assert.equal(staleVersionClose.code, 4406);
  assert.match(staleVersionClose.reason, /App-Version/i);
  publicClient.socket.send(JSON.stringify({ v: 2, type: "request", id: "public-read", endpoint: "players", params: {} }));
  const publicPlayers = await publicClient.next((message) => message.id === "public-read");
  assert.equal(publicPlayers.type, "response");
  assert.match(publicPlayers.supportId, /^[0-9a-f-]{36}$/i);
  assert.equal(publicPlayers.supportId.includes(publicWelcome.connectionId), false);
  assert.equal(logEntries.some(({ event, fields }) => (
    event === "ws_request_completed"
    && fields.supportId === publicPlayers.supportId
    && fields.requestId === "public-read"
    && fields.endpoint === "players"
  )), true);
  assert.deepEqual(publicPlayers.data.values[0], ["ID", "Vorname", "Nachname", "Aktiv"]);
  assert.equal(JSON.stringify(publicPlayers.data).includes("ada@example.test"), false);

  const publicContracts = [
    ["publicProfile", { id: "p1" }],
    ["bewerbe", {}],
    ["bewerbsart", {}],
    ["matches1", { bewerbId: "cup-1" }],
    ["preMatches", { bewerbId: "cup-1" }],
    ["matches", { bewerbId: "cup-1" }],
    ["rlPlatzierung", { bewerbId: "cup-1" }],
    ["entryList", { bewerbId: "cup-1" }],
    ["readMatchRestrictions", { bewerbId: "cup-1" }],
    ["getScoreboardCourts", {}],
    ["courtScores", {}],
    ["scoreboardSnapshot", {}],
  ];
  for (const [endpoint, params] of publicContracts) {
    const response = await publicClient.request(endpoint, params);
    assert.equal(response.data.success, true, endpoint);
  }
  const anonymousProfile = await publicClient.request("publicProfile", { id: "p1" });
  assert.equal(anonymousProfile.data.profile.email, undefined);
  assert.equal(anonymousProfile.data.profile.phone, undefined);
  assert.equal(anonymousProfile.data.profile.birthDate, undefined);
  const projectedMatches = await publicClient.request("matches1", {});
  assert.equal(projectedMatches.data.values[0].includes("InternalNote"), false);
  assert.equal(JSON.stringify(projectedMatches.data).includes("secret-note"), false);
  const projectedEntries = await publicClient.request("entryList", {});
  assert.equal(projectedEntries.data.values[0].includes("Entrydate"), true);
  assert.equal(projectedEntries.data.values[0].includes("PaymentStatus"), false);

  const protectedEndpoints = [
    "memberDirectory", "myProfile", "addMatch", "addEntryList", "removeEntryList",
    "withdrawFromRanking", "operationStatus", "navigator", "courtAssign", "courtSetActive", "monitorList",
    "monitorNavigate", "monitorScroll", "monitorProvision", "monitorRotate", "monitorRevoke",
    "monitorTarget", "monitorAck",
  ];
  for (const endpoint of protectedEndpoints) {
    const response = await publicClient.request(endpoint, {});
    assert.equal(response.data.error.code, "AUTH_REQUIRED", endpoint);
  }
  const inheritedEndpoint = await publicClient.request("constructor", {});
  assert.equal(inheritedEndpoint.data.error.code, "ENDPOINT_NOT_FOUND");
  publicClient.socket.send(JSON.stringify({ v: 2, type: "request", id: "invalid-contract", endpoint: 123, params: {} }));
  const invalidContract = await publicClient.next((message) => message.id === "invalid-contract");
  assert.equal(invalidContract.type, "response");
  assert.equal(invalidContract.data.error.code, "INVALID_MESSAGE");

  publicClient.socket.send(JSON.stringify({ v: 2, type: "request", id: "parallel-success", endpoint: "players", params: {} }));
  publicClient.socket.send(JSON.stringify({ v: 2, type: "request", id: "parallel-failure", endpoint: "unknownEndpoint", params: {} }));
  const [parallelSuccess, parallelFailure] = await Promise.all([
    publicClient.next((message) => message.id === "parallel-success"),
    publicClient.next((message) => message.id === "parallel-failure"),
  ]);
  assert.equal(parallelSuccess.data.success, true);
  assert.equal(parallelFailure.data.error.code, "ENDPOINT_NOT_FOUND");
  assert.notEqual(parallelSuccess.supportId, parallelFailure.supportId);

  const adminClient = createSocketClient(`${wsBase}/ws`, { Origin: "http://test.local", Cookie: cookie });
  const adminPrincipal = (await adminClient.handshake()).principal;
  assert.equal(adminPrincipal.role, "admin");
  assert.equal(adminPrincipal.user.login, "ada.login");
  assert.equal(adminPrincipal.user.email, "ada@example.test");
  let statusPayload;
  await waitFor(async () => {
    const statusResponse = await fetch(`${httpBase}/status`, { headers: { Cookie: cookie } });
    assert.equal(statusResponse.status, 200);
    statusPayload = await statusResponse.json();
    return statusPayload.provider.clientCapacity.current === 2;
  }, 1000, "Geschlossene Versionskonflikt-Verbindung blieb im Providerstatus");
  assert.deepEqual(statusPayload.provider.clientCapacity, { current: 2, max: 200, text: "2/200" });
  assert.deepEqual(statusPayload.provider.connectionsByIp, [{
    ip: "127.0.0.1",
    current: 2,
    max: 20,
    text: "2/20",
  }]);
  const adminStatusClient = statusPayload.provider.clients.find((client) => client.userId === "p1");
  assert.equal(adminStatusClient.ip, "127.0.0.1");
  assert.equal(adminStatusClient.userName, "Admin / Ada");
  const anonymousStatusClient = statusPayload.provider.clients.find((client) => client.principalType === "anonymous");
  assert.equal(anonymousStatusClient.userId, null);
  assert.equal(anonymousStatusClient.userName, null);
  assert.equal(anonymousStatusClient.requestHistory.length <= 20, true);
  const parallelRecords = anonymousStatusClient.requestHistory.filter(({ clientRequestId }) => (
    clientRequestId === "parallel-success" || clientRequestId === "parallel-failure"
  ));
  assert.deepEqual(new Set(parallelRecords.map(({ clientRequestId }) => clientRequestId)), new Set(["parallel-success", "parallel-failure"]));
  const successRecord = parallelRecords.find(({ clientRequestId }) => clientRequestId === "parallel-success");
  const failureRecord = parallelRecords.find(({ clientRequestId }) => clientRequestId === "parallel-failure");
  assert.deepEqual({ endpoint: successRecord.endpoint, success: successRecord.success, supportId: successRecord.supportId }, {
    endpoint: "players", success: true, supportId: parallelSuccess.supportId,
  });
  assert.deepEqual({ endpoint: failureRecord.endpoint, success: failureRecord.success, code: failureRecord.code, supportId: failureRecord.supportId }, {
    endpoint: "unknownEndpoint", success: false, code: "ENDPOINT_NOT_FOUND", supportId: parallelFailure.supportId,
  });
  assert.equal(statusPayload.scoreLog.open, true);
  assert.equal(statusPayload.auditLog.open, true);
  adminClient.socket.send(JSON.stringify({ v: 2, type: "request", id: "directory", endpoint: "memberDirectory", params: {} }));
  const directory = await adminClient.next((message) => message.id === "directory");
  assert.equal(directory.type, "response");
  assert.equal(directory.data.values[1][3], "+43123");
  assert.equal(directory.data.values[1][4], "ada@example.test");
  assert.equal(directory.data.values[1][5], "19900102");
  assert.equal(directory.data.values[0].includes("E-Mail"), true);
  assert.equal(directory.data.values[0].includes("GeburtsDatum"), true);
  assert.equal(directory.data.values[0].includes("PasswdHash"), false);
  assert.equal(directory.data.values[0].includes("Login"), false);

  const playerSession = repository.createSession({ userId: "p2", email: "peter@example.test", login: "peter.login", ttlMs: 60000 });
  const playerLoggingPolicy = await fetch(`${httpBase}/api/frontend-logging-policy`, {
    headers: { Cookie: `epiber_test_session=${playerSession.token}` },
  });
  assert.equal(playerLoggingPolicy.status, 200);
  const playerLoggingPolicyData = await playerLoggingPolicy.json();
  assert.equal(playerLoggingPolicyData.frontendLogging.targeted, true);
  assert.equal(playerLoggingPolicyData.frontendLogging.level, "debug");
  assert.equal(playerLoggingPolicyData.frontendLogging.sampleRatePercent, 100);

  const frontendEventResponse = await fetch(`${httpBase}/api/frontend-events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://test.local",
      Cookie: `epiber_test_session=${playerSession.token}`,
      "X-Forwarded-For": "198.51.100.77",
    },
    body: JSON.stringify({
      appVersion,
      clientSessionId: "00000000-0000-4000-8000-000000000401",
      pageType: "scoreboard",
      events: [{
        event: "rpc_request_failed",
        level: "warn",
        timestamp: "2026-08-08T10:00:00.000Z",
        code: "REQUEST_TIMEOUT",
        category: "timeout",
        supportId: "support-frontend-1",
        endpoint: "players",
        durationMs: 45000,
        attemptCount: 3,
        outcome: "failed",
      }],
    }),
  });
  assert.equal(frontendEventResponse.status, 200);
  assert.deepEqual(await frontendEventResponse.json(), { success: true, accepted: 1, dropped: 0 });
  const frontendLog = logEntries.find(({ event, fields }) => (
    event === "frontend_client_event" && fields.supportId === "support-frontend-1"
  ));
  assert.equal(frontendLog.fields.actorId, "p2");
  assert.equal(frontendLog.fields.actorName, "Peter Player");
  assert.equal(frontendLog.fields.sourceIp, "198.51.100.77");
  assert.equal(frontendLog.fields.diagnosticProfile, "targeted");
  assert.equal(frontendLog.fields.retentionDays, 7);
  const playerClient = createSocketClient(`${wsBase}/ws`, {
    Origin: "http://test.local",
    Cookie: `epiber_test_session=${playerSession.token}`,
  });
  assert.equal((await playerClient.handshake()).principal.role, "player");
  assert.equal((await playerClient.request("memberDirectory")).data.success, true);
  const memberProfile = await playerClient.request("publicProfile", { id: "p1" });
  assert.equal(memberProfile.data.profile.email, "ada@example.test");
  assert.equal(memberProfile.data.profile.phone, "+43123");
  assert.equal(memberProfile.data.profile.birthDate, "19900102");
  assert.equal(memberProfile.data.profile.login, undefined);
  assert.equal((await playerClient.request("navigator")).data.error.code, "FORBIDDEN");
  assert.equal((await playerClient.request("monitorProvision")).data.error.code, "FORBIDDEN");
  assert.equal((await fetch(`${httpBase}/api/admin/frontend-logging`, {
    headers: { Cookie: `epiber_test_session=${playerSession.token}` },
  })).status, 403);
  const playerGrafanaAuth = await fetch(`${httpBase}/api/admin/grafana-auth`, {
    headers: { Cookie: `epiber_test_session=${playerSession.token}` },
  });
  assert.equal(playerGrafanaAuth.status, 403);
  assert.equal(playerGrafanaAuth.headers.get("x-webauth-user"), null);

  const forbiddenAdminPassword = await fetch(`${httpBase}/api/admin/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://test.local",
      Cookie: `epiber_test_session=${playerSession.token}`,
    },
    body: JSON.stringify({ personId: "p1", newPasswordHash: "f".repeat(64) }),
  });
  assert.equal(forbiddenAdminPassword.status, 403);

  const operatorSession = repository.createSession({ userId: "p3", email: "operator@example.test", login: "operator.login", ttlMs: 60000 });
  const operatorClient = createSocketClient(`${wsBase}/ws`, {
    Origin: "http://test.local",
    Cookie: `epiber_test_session=${operatorSession.token}`,
  });
  assert.equal((await operatorClient.handshake()).principal.role, "operator");
  assert.equal((await operatorClient.request("navigator", { profil: "1" })).data.success, true);
  assert.equal((await operatorClient.request("monitorList")).data.success, true);
  assert.equal((await operatorClient.request("monitorProvision")).data.error.code, "FORBIDDEN");
  const operatorGrafanaAuth = await fetch(`${httpBase}/api/admin/grafana-auth`, {
    headers: { Cookie: `epiber_test_session=${operatorSession.token}` },
  });
  assert.equal(operatorGrafanaAuth.status, 403);
  assert.equal(operatorGrafanaAuth.headers.get("x-webauth-user"), null);

  const authenticatedEndpoints = [
    "memberDirectory", "myProfile", "operationStatus", "addMatch", "addEntryList",
    "removeEntryList", "withdrawFromRanking",
  ];
  const operatorEndpoints = ["navigator", "courtAssign", "courtSetActive", "monitorList", "monitorNavigate", "monitorScroll"];
  const adminEndpoints = ["adminMemberReconciliation", "adminPeopleNormalization", "normalizePerson", "reconcilePerson", "monitorProvision", "monitorRotate", "monitorRevoke"];
  const deviceEndpoints = ["monitorTarget", "monitorAck"];
  const assertAllowedByPolicy = async (client, endpoint) => {
    const response = await client.request(endpoint, {});
    assert.notEqual(response.data.error?.code, "AUTH_REQUIRED", endpoint);
    assert.notEqual(response.data.error?.code, "FORBIDDEN", endpoint);
  };
  const assertForbiddenByPolicy = async (client, endpoint) => {
    assert.equal((await client.request(endpoint, {})).data.error.code, "FORBIDDEN", endpoint);
  };
  for (const endpoint of authenticatedEndpoints) await assertAllowedByPolicy(playerClient, endpoint);
  for (const endpoint of [...operatorEndpoints, ...adminEndpoints, ...deviceEndpoints]) await assertForbiddenByPolicy(playerClient, endpoint);
  for (const endpoint of [...authenticatedEndpoints, ...operatorEndpoints]) await assertAllowedByPolicy(operatorClient, endpoint);
  for (const endpoint of [...adminEndpoints, ...deviceEndpoints]) await assertForbiddenByPolicy(operatorClient, endpoint);
  for (const endpoint of [...authenticatedEndpoints, ...operatorEndpoints, ...adminEndpoints]) await assertAllowedByPolicy(adminClient, endpoint);
  for (const endpoint of deviceEndpoints) await assertForbiddenByPolicy(adminClient, endpoint);

  const ownProfile = await adminClient.request("myProfile");
  assert.equal(ownProfile.data.profile.email, "ada@example.test");
  assert.equal(ownProfile.data.profile.login, "ada.login");
  const normalization = await adminClient.request("adminPeopleNormalization");
  assert.equal(normalization.data.success, true);
  assert.equal(normalization.data.people.length >= 2, true);
  assert.equal(Object.hasOwn(normalization.data.people[0].values, "storedPasswordHash"), false);
  assert.equal(Object.hasOwn(normalization.data.people[0].values, "passwordSetupAllowed"), false);
  const reconciliation = await adminClient.request("adminMemberReconciliation");
  assert.equal(reconciliation.data.success, true);
  assert.equal(reconciliation.data.people.length >= 2, true);
  assert.equal(typeof reconciliation.data.people[0].externalId, "string");
  assert.equal(Object.hasOwn(reconciliation.data.people[0].values, "storedPasswordHash"), false);
  assert.equal((await adminClient.request("navigator", { profil: "1" })).data.items[0].action.path, "/scoreboard.html");
  adminClient.socket.send(JSON.stringify({ v: 2, type: "subscribe", topics: ["monitors"] }));
  const monitorSnapshot = await adminClient.next((message) => message.type === "event" && message.topic === "monitors");
  assert.deepEqual(monitorSnapshot.data.monitors, []);
  assert.deepEqual((await adminClient.next((message) => message.type === "subscribed")).topics, ["monitors"]);
  const statusTopics = Array.from({ length: 40 }, (_, index) => `monitor-status:limit-${index}`);
  adminClient.socket.send(JSON.stringify({ v: 2, type: "subscribe", topics: statusTopics.slice(0, 20) }));
  assert.equal((await adminClient.next((message) => message.type === "subscribed")).topics.length, 20);
  adminClient.socket.send(JSON.stringify({ v: 2, type: "subscribe", topics: statusTopics.slice(20) }));
  assert.equal((await adminClient.next((message) => message.type === "subscribed")).topics.length, 11);
  adminClient.socket.send(JSON.stringify({ v: 2, type: "unsubscribe", topics: [statusTopics[0]] }));
  adminClient.socket.send(JSON.stringify({ v: 2, type: "subscribe", topics: ["navigator"] }));
  const navigatorSubscription = await adminClient.next((message) => message.type === "subscribed");
  assert.deepEqual(navigatorSubscription.topics, ["navigator"]);

  const provisionOperation = "00000000-0000-4000-8000-000000000301";
  const provisioned = await adminClient.request("monitorProvision", {
    label: "Testmonitor",
    operationId: provisionOperation,
  });
  assert.equal(provisioned.data.success, true);
  assert.ok(provisioned.data.monitor.token);
  const monitorId = provisioned.data.monitor.monitorId;

  const deviceLogin = await fetch(`${httpBase}/api/monitor/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local" },
    body: JSON.stringify({ token: provisioned.data.monitor.token }),
  });
  assert.equal(deviceLogin.status, 200);
  const monitorCookie = deviceLogin.headers.get("set-cookie").split(";", 1)[0];
  assert.match(monitorCookie, /^epiber_test_monitor=/);

  const deviceClient = createSocketClient(`${wsBase}/ws`, { Origin: "http://test.local", Cookie: monitorCookie });
  const deviceWelcome = await deviceClient.handshake("monitor");
  assert.equal(deviceWelcome.principal.role, "device");
  for (const endpoint of [...authenticatedEndpoints, ...operatorEndpoints, ...adminEndpoints]) await assertForbiddenByPolicy(deviceClient, endpoint);
  for (const endpoint of deviceEndpoints) await assertAllowedByPolicy(deviceClient, endpoint);
  deviceClient.socket.send(JSON.stringify({ v: 2, type: "subscribe", topics: ["monitor-command"] }));
  assert.deepEqual((await deviceClient.next((message) => message.type === "subscribed")).topics, ["monitor-command"]);
  assert.equal((await deviceClient.request("monitorTarget")).data.target.path, "");

  const navigation = await adminClient.request("monitorNavigate", {
    monitorId,
    operationId: "00000000-0000-4000-8000-000000000302",
    path: "/scoreboard.html",
  });
  assert.equal(navigation.data.delivery, "sent");
  const navigationCommand = await deviceClient.next((message) => (
    message.type === "event" && message.topic === "monitor-command" && message.data.kind === "navigate"
  ));
  assert.equal(navigationCommand.data.commandId, navigation.data.commandId);
  for (const status of ["received", "loading", "loaded"]) {
    const acknowledgement = await deviceClient.request("monitorAck", {
      kind: "navigate",
      commandId: navigation.data.commandId,
      status,
    });
    assert.equal(acknowledgement.data.success, true);
  }

  const assignment = await operatorClient.request("courtAssign", {
    court: "1",
    matchId: "m1",
    operationId: "00000000-0000-4000-8000-000000000303",
    expectedRevision: 1,
  });
  assert.equal(assignment.data.court.homePlayer, "Ada Admin");
  assert.equal(assignment.data.court.matchtypId, "2");
  assert.deepEqual(assignment.data.court.displayRules, {
    schemaVersion: 1,
    source: "matchtyp",
    matchtypId: "2",
    satztiebreak: "3-3",
    entscheidenderSatz: "MT10",
  });
  dataStore.set("matchtyp", [["ID", "Bezeichnung", "Satztiebreak", "Entscheidender Satz"], ["1", "Normal", "6-6", "vollstaendiger Satz"], ["2", "Geaendert", "4-4", "MT7"]], { source: "test-edit" });
  const persistedAssignment = await adminClient.request("getScoreboardCourts");
  assert.deepEqual(persistedAssignment.data.courts["1"].displayRules, assignment.data.court.displayRules);
  const assignedScores = await adminClient.request("courtScores");
  const assignedCourtScore = assignedScores.data.data.courts.find((court) => court.platz === "1");
  assert.deepEqual(assignedCourtScore, {
    platz: "1",
    satz1home: "0", satz1gast: "0", satz2home: "0", satz2gast: "0",
    satz3home: "0", satz3gast: "0", punktehome: "0", punktegast: "0",
  });
  const reassignmentRequest = {
    court: "1",
    matchId: "m1",
    operationId: "00000000-0000-4000-8000-000000000309",
    expectedRevision: assignment.data.court.revision,
  };
  const reassignment = await operatorClient.request("courtAssign", reassignmentRequest);
  assert.deepEqual(reassignment.data.court.displayRules, {
    schemaVersion: 1,
    source: "matchtyp",
    matchtypId: "2",
    satztiebreak: "4-4",
    entscheidenderSatz: "MT7",
  });
  const deviceClosed = new Promise((resolve) => deviceClient.socket.once("close", (code) => resolve(code)));
  const rotated = await adminClient.request("monitorRotate", {
    monitorId,
    operationId: "00000000-0000-4000-8000-000000000305",
  });
  assert.ok(rotated.data.monitor.token);
  assert.equal(await deviceClosed, 4003);
  const revoked = await adminClient.request("monitorRevoke", {
    monitorId,
    operationId: "00000000-0000-4000-8000-000000000306",
  });
  assert.ok(revoked.data.monitor.revokedAt);
  assert.equal((await adminClient.request("monitorList")).data.monitors[0].revokedAt > 0, true);

  const loggingTargetRemove = await fetch(`${httpBase}/api/admin/frontend-logging/targets`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Origin: "http://test.local", Cookie: cookie },
    body: JSON.stringify({ expectedRevision: 1, personId: "p2" }),
  });
  assert.equal(loggingTargetRemove.status, 200);
  assert.equal((await loggingTargetRemove.json()).removed, true);

  assert.equal(await rejectedUpgrade(`${wsBase}/ws`, "http://evil.test"), 403);
  assert.equal(await rejectedUpgrade(`${wsBase}/not-ws`, "http://test.local"), 404);

  const oversizedClient = createSocketClient(`${wsBase}/ws`, { Origin: "http://test.local" });
  await oversizedClient.handshake();
  const oversizedClosed = new Promise((resolve) => oversizedClient.socket.once("close", (code) => resolve(code)));
  oversizedClient.socket.send("x".repeat(20000));
  assert.equal(await oversizedClosed, 1009);

  const currentTables = Object.fromEntries(Object.keys(TABLE_CONFIG).map((table) => [table, dataStore.get(table)]));
  dataStore.resetForTests();
  for (const [table, values] of Object.entries(currentTables)) {
    if (table !== "matchtyp") dataStore.set(table, values, { source: "stale-matchtyp-test" });
  }
  await new Promise((resolve) => setTimeout(resolve, 10100)); // Replenish two shared per-IP write tokens.
  const staleMatchtypReplay = await operatorClient.request("courtAssign", {
    court: "1",
    matchId: "m1",
    operationId: "00000000-0000-4000-8000-000000000303",
    expectedRevision: 1,
  });
  assert.equal(staleMatchtypReplay.data.error, undefined);
  assert.deepEqual(staleMatchtypReplay.data.court.displayRules, assignment.data.court.displayRules);

  const emptyAssignment = await operatorClient.request("courtAssign", {
    court: "1",
    empty: true,
    operationId: "00000000-0000-4000-8000-000000000310",
    expectedRevision: reassignment.data.court.revision,
  });
  assert.deepEqual({
    matchId: emptyAssignment.data.court.matchId,
    bewerbId: emptyAssignment.data.court.bewerbId,
    matchtypId: emptyAssignment.data.court.matchtypId,
    displayRules: emptyAssignment.data.court.displayRules,
    bewerb: emptyAssignment.data.court.bewerb,
    homePlayerIds: emptyAssignment.data.court.homePlayerIds,
    guestPlayerIds: emptyAssignment.data.court.guestPlayerIds,
    homePlayer: emptyAssignment.data.court.homePlayer,
    guestPlayer: emptyAssignment.data.court.guestPlayer,
    dateTime: emptyAssignment.data.court.dateTime,
    runde: emptyAssignment.data.court.runde,
    aktiv: emptyAssignment.data.court.aktiv,
  }, {
    matchId: "",
    bewerbId: "",
    matchtypId: "",
    displayRules: null,
    bewerb: "",
    homePlayerIds: [],
    guestPlayerIds: [],
    homePlayer: "",
    guestPlayer: "",
    dateTime: "",
    runde: "",
    aktiv: reassignment.data.court.aktiv,
  });
  const emptyScores = await operatorClient.request("courtScores");
  assert.deepEqual(emptyScores.data.data.courts.find((court) => court.platz === "1"), {
    platz: "1",
    satz1home: "0", satz1gast: "0", satz2home: "0", satz2gast: "0",
    satz3home: "0", satz3gast: "0", punktehome: "0", punktegast: "0",
  });

  const realDateNow = Date.now;
  const staleNow = realDateNow() + 120000;
  Date.now = () => staleNow;
  try {
    const stalePeopleStatus = await fetch(`${httpBase}/status`, { headers: { Cookie: cookie } });
    assert.equal(stalePeopleStatus.status, 200);
    assert.deepEqual((await stalePeopleStatus.json()).authorization, { role: "admin", roleSource: "last_known_good" });
    const staleGrafanaAuth = await fetch(`${httpBase}/api/admin/grafana-auth`, { headers: { Cookie: cookie } });
    assert.equal(staleGrafanaAuth.status, 503);
    assert.equal(staleGrafanaAuth.headers.get("x-webauth-user"), null);
    assert.equal((await staleGrafanaAuth.json()).error.code, "PERSON_DATA_UNAVAILABLE");
  } finally {
    Date.now = realDateNow;
  }

  application.server.emit("error", Object.assign(new Error("simulated runtime error"), { code: "SIMULATED" }));
  assert.equal(logEntries.some(({ event, fields }) => (
    event === "http_server_error" && fields.listening === true && fields.error.code === "SIMULATED"
  )), true);

  const auditRows = application.auditLogRepository.list();
  const successfulActions = new Set(auditRows.filter((row) => row.result === "success").map((row) => row.action));
  for (const action of [
    "login", "adminPasswordSet", "adminPasswordSetup", "passwordSetup", "adminPasswordResetProof",
    "passwordReset", "monitorProvision", "monitorEnroll", "monitorNavigate", "courtAssign", "monitorRotate", "monitorRevoke",
    "frontendLoggingSettings", "frontendLoggingTargetSet", "frontendLoggingTargetRemove",
  ]) {
    assert.equal(successfulActions.has(action), true, `Audit fehlt fuer ${action}`);
  }
  const serializedAudit = JSON.stringify(auditRows);
  assert.equal(serializedAudit.includes("ada.login"), true);
  assert.equal(serializedAudit.includes("ada@example.test"), false);
  assert.equal(serializedAudit.includes(" bad login "), false);
  assert.equal(serializedAudit.includes("a".repeat(64)), false);
  assert.equal(serializedAudit.includes(provisioned.data.monitor.token), false);
  const failedLoginAudit = auditRows.find((row) => row.action === "login" && row.errorCode === "LOGIN_FAILED");
  assert.equal(failedLoginAudit.errorCode, "LOGIN_FAILED");
  assert.equal(failedLoginAudit.actorType, "anonymous");
  assert.equal(failedLoginAudit.actorName, "");
  assert.equal(failedLoginAudit.attemptedLogin, "ada.login");
  assert.equal(failedLoginAudit.attemptedEmail, "");
  assert.equal(failedLoginAudit.sourceIp, "203.0.113.42");
  const invalidLoginAudit = auditRows.find((row) => row.action === "login" && row.errorCode === "VALIDATION_ERROR" && row.sourceIp === "192.0.2.10");
  assert.equal(invalidLoginAudit.attemptedLogin, "");
  assert.equal(invalidLoginAudit.attemptedEmail, "");
  assert.deepEqual(invalidLoginAudit.before, { identifierValid: false });
  const successfulLoginAudit = auditRows.find((row) => row.action === "login" && row.result === "success");
  assert.equal(successfulLoginAudit.actorId, "p1");
  assert.equal(successfulLoginAudit.actorName, "Ada Admin");
  assert.equal(successfulLoginAudit.attemptedLogin, "ada.login");
  assert.equal(successfulLoginAudit.attemptedEmail, "");
  assert.equal(successfulLoginAudit.sourceIp, "198.51.100.20");
  const courtAudit = auditRows.find((row) => row.action === "courtAssign" && row.result === "success");
  assert.equal(courtAudit.actorId, "p3");
  assert.equal(courtAudit.actorName, "Olivia Operator");
  assert.equal(courtAudit.role, "operator");

  await publicClient.close();
  await adminClient.close();
  await deviceClient.close();
  await playerClient.close();
  await operatorClient.close();
});
