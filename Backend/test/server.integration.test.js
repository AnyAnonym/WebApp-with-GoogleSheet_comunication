const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocket } = require("ws");
const { peopleFixture, setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const dataStore = require("../dataStore.js");
const { createApplication } = require("../server.js");
const { StateRepository } = require("../stateRepository.js");
const { version: appVersion } = require("../package.json");

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
  dataStore.resetForTests();
  const people = peopleFixture();
  people.push(["p3", "Olivia", "Operator", "operator@example.test", "c".repeat(64), "", "+43999", "2", "1", "operator"]);
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
  const anonymousSessionData = await anonymousSession.json();
  assert.equal(Number.isFinite(anonymousSessionData.serverTime), true);
  delete anonymousSessionData.serverTime;
  assert.deepEqual(anonymousSessionData, { success: true, authenticated: false, user: null, expiresAt: null });

  const readinessResponse = await fetch(`${httpBase}/ready`);
  assert.equal(readinessResponse.status, 503);
  assert.deepEqual(await readinessResponse.json(), { status: "not-ready", version: appVersion });
  assert.equal((await fetch(`${httpBase}/status`)).status, 401);
  assert.equal((await fetch(`${httpBase}/version`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${httpBase}/missing`)).status, 404);
  assert.equal((await fetch(`${httpBase}/api/session`, { method: "PUT" })).status, 405);
  assert.equal((await fetch(`${httpBase}/api/monitor/session`, { method: "PUT" })).status, 405);

  const wrongOriginLogin = await fetch(`${httpBase}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.test" },
    body: JSON.stringify({ email: "ada@example.test", passwordHash: "a".repeat(64) }),
  });
  assert.equal(wrongOriginLogin.status, 403);

  const oversizedLogin = await fetch(`${httpBase}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local" },
    body: JSON.stringify({ padding: "x".repeat(3000) }),
  });
  assert.equal(oversizedLogin.status, 413);

  const loginResponse = await fetch(`${httpBase}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local" },
    body: JSON.stringify({ email: "ada@example.test", passwordHash: "a".repeat(64) }),
  });
  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.headers.get("access-control-allow-origin"), "http://test.local");
  assert.equal(loginResponse.headers.get("access-control-allow-credentials"), "true");
  const loginPayload = await loginResponse.json();
  assert.equal(loginPayload.user.role, "admin");
  const cookie = loginResponse.headers.get("set-cookie").split(";", 1)[0];
  assert.match(cookie, /^epiber_test_session=/);

  const authenticatedSession = await fetch(`${httpBase}/api/session`, { headers: { Cookie: cookie } });
  assert.equal((await authenticatedSession.json()).user.email, "ada@example.test");

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
  const setupResponse = await fetch(`${httpBase}/api/password-setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local" },
    body: JSON.stringify({ email: "peter@example.test", newPasswordHash: "9".repeat(64) }),
  });
  assert.equal(setupResponse.status, 200);
  assert.deepEqual(await setupResponse.json(), { success: true });
  const repeatedSetupResponse = await fetch(`${httpBase}/api/password-setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test.local" },
    body: JSON.stringify({ email: "peter@example.test", newPasswordHash: "8".repeat(64) }),
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
  assert.equal((await publicClient.handshake()).principal.role, "anonymous");
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

  const adminClient = createSocketClient(`${wsBase}/ws`, { Origin: "http://test.local", Cookie: cookie });
  assert.equal((await adminClient.handshake()).principal.role, "admin");
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
  adminClient.socket.send(JSON.stringify({ v: 2, type: "request", id: "directory", endpoint: "memberDirectory", params: {} }));
  const directory = await adminClient.next((message) => message.id === "directory");
  assert.equal(directory.type, "response");
  assert.equal(directory.data.values[1][3], "+43123");
  assert.equal(directory.data.values[1][4], "ada@example.test");
  assert.equal(directory.data.values[1][5], "19900102");
  assert.equal(directory.data.values[0].includes("E-Mail"), true);
  assert.equal(directory.data.values[0].includes("GeburtsDatum"), true);
  assert.equal(directory.data.values[0].includes("PasswdHash"), false);

  const playerSession = repository.createSession({ userId: "p2", email: "peter@example.test", ttlMs: 60000 });
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
  assert.equal((await playerClient.request("navigator")).data.error.code, "FORBIDDEN");
  assert.equal((await playerClient.request("monitorProvision")).data.error.code, "FORBIDDEN");

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

  const operatorSession = repository.createSession({ userId: "p3", email: "operator@example.test", ttlMs: 60000 });
  const operatorClient = createSocketClient(`${wsBase}/ws`, {
    Origin: "http://test.local",
    Cookie: `epiber_test_session=${operatorSession.token}`,
  });
  assert.equal((await operatorClient.handshake()).principal.role, "operator");
  assert.equal((await operatorClient.request("navigator", { profil: "1" })).data.success, true);
  assert.equal((await operatorClient.request("monitorList")).data.success, true);
  assert.equal((await operatorClient.request("monitorProvision")).data.error.code, "FORBIDDEN");

  const authenticatedEndpoints = [
    "memberDirectory", "myProfile", "operationStatus", "addMatch", "addEntryList",
    "removeEntryList", "withdrawFromRanking",
  ];
  const operatorEndpoints = ["navigator", "courtAssign", "courtSetActive", "monitorList", "monitorNavigate", "monitorScroll"];
  const adminEndpoints = ["monitorProvision", "monitorRotate", "monitorRevoke"];
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

  assert.equal((await adminClient.request("myProfile")).data.profile.email, "ada@example.test");
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

  const assignment = await adminClient.request("courtAssign", {
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
  const reassignment = await adminClient.request("courtAssign", reassignmentRequest);
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

  assert.equal(await rejectedUpgrade(`${wsBase}/ws`, "http://evil.test"), 403);
  assert.equal(await rejectedUpgrade(`${wsBase}/not-ws`, "http://test.local"), 404);

  const oversizedClient = createSocketClient(`${wsBase}/ws`, { Origin: "http://test.local" });
  await oversizedClient.handshake();
  const oversizedClosed = new Promise((resolve) => oversizedClient.socket.once("close", (code) => resolve(code)));
  oversizedClient.socket.send("x".repeat(20000));
  assert.equal(await oversizedClosed, 1009);

  await publicClient.close();
  await adminClient.close();
  await deviceClient.close();
  await playerClient.close();
  await operatorClient.close();
});
