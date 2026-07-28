const test = require("node:test");
const assert = require("node:assert/strict");
const { peopleFixture, setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const dataStore = require("../dataStore.js");
const { AuthService } = require("../authService.js");
const { StateRepository } = require("../stateRepository.js");

test.beforeEach(() => {
  dataStore.resetForTests();
  dataStore.set("players", peopleFixture(), { source: "test" });
});

test("Oeffentliche Spielerprojektion enthaelt keine privaten Felder", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const auth = new AuthService({ repository, sheetService: {} });
  const table = auth.publicPlayersTable();
  assert.deepEqual(table[0], ["ID", "Vorname", "Nachname", "Aktiv"]);
  assert.equal(JSON.stringify(table).includes("ada@example.test"), false);
  assert.equal(JSON.stringify(table).includes("a".repeat(64)), false);
  repository.close();
});

test("Login migriert Legacy-Hash und erzeugt serverseitige Session", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  let upgraded = null;
  const sheetService = { setPasswordHash: async (id, value) => { upgraded = { id, value }; } };
  const auth = new AuthService({ repository, sheetService });
  const result = await auth.login({ email: "ada@example.test", passwordHash: "a".repeat(64), ip: "127.0.0.1" });
  assert.equal(result.user.role, "admin");
  assert.equal(upgraded.id, "p1");
  assert.match(upgraded.value, /^scrypt\$v1\$/);
  assert.equal(repository.getSession(result.session.token).userId, "p1");
  repository.close();
});

test("Login-Limiter blockiert wiederholte Fehler", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const auth = new AuthService({ repository, sheetService: {} });
  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects(auth.login({ email: "ada@example.test", passwordHash: "f".repeat(64), ip: "127.0.0.2" }));
  }
  await assert.rejects(
    auth.login({ email: "ada@example.test", passwordHash: "a".repeat(64), ip: "127.0.0.2" }),
    { code: "LOGIN_RATE_LIMIT" },
  );
  repository.close();
});

test("fehlende oder veraltete Personendaten widerrufen keine gueltige Session", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const session = repository.createSession({ userId: "p1", email: "ada@example.test", ttlMs: 60000 });
  dataStore.resetForTests();
  const auth = new AuthService({ repository, sheetService: {} });

  assert.throws(() => auth.getUserForToken(session.token), { code: "PERSON_DATA_UNAVAILABLE" });
  assert.equal(repository.getSession(session.token).userId, "p1");
  repository.close();
});

test("unklarer Passwort-Write widerruft vorsorglich alle Sitzungen", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const session = repository.createSession({ userId: "p1", email: "ada@example.test", ttlMs: 60000 });
  const sheetService = {
    async setPasswordHash() {
      throw Object.assign(new Error("response and confirmation lost"), { code: "WRITE_OUTCOME_UNKNOWN" });
    },
  };
  const auth = new AuthService({ repository, sheetService });

  await assert.rejects(
    auth.changeOwnPassword(session.token, "a".repeat(64), "b".repeat(64)),
    { code: "WRITE_OUTCOME_UNKNOWN" },
  );
  assert.equal(repository.getSession(session.token), null);
  repository.close();
});

test("eigene Passwortaenderung rotiert die Sitzung", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const oldSession = repository.createSession({ userId: "p1", email: "ada@example.test", ttlMs: 60000 });
  const auth = new AuthService({ repository, sheetService: { async setPasswordHash() {} } });

  const result = await auth.changeOwnPassword(oldSession.token, "a".repeat(64), "b".repeat(64));
  assert.equal(repository.getSession(oldSession.token), null);
  assert.equal(repository.getSession(result.session.token).userId, "p1");
  assert.notEqual(result.session.token, oldSession.token);
  repository.close();
});

test("Admin erstellt einen einmaligen Reset-Nachweis", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const adminSession = repository.createSession({ userId: "p1", email: "ada@example.test", ttlMs: 60000 });
  const playerSession = repository.createSession({ userId: "p2", email: "peter@example.test", ttlMs: 60000 });
  let passwordWrite = null;
  const auth = new AuthService({
    repository,
    sheetService: { async setPasswordHash(personId, storedHash) { passwordWrite = { personId, storedHash }; } },
  });
  const proof = auth.createPasswordReset(adminSession.token, "p2");
  assert.match(proof.resetToken, /^[A-Za-z0-9_-]{32,128}$/);
  await auth.resetPassword(proof.resetToken, "e".repeat(64));
  assert.equal(passwordWrite.personId, "p2");
  assert.match(passwordWrite.storedHash, /^scrypt\$v1\$/);
  assert.equal(repository.getSession(playerSession.token), null);
  assert.deepEqual(await auth.resetPassword(proof.resetToken, "e".repeat(64)), { success: true, repeated: true });
  await assert.rejects(auth.resetPassword(proof.resetToken, "f".repeat(64)), { code: "RESET_PROOF_CONFLICT" });
  repository.close();
});

test("Login mit altem Passwort kann einen laufenden Reset nicht ueberholen", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const adminSession = repository.createSession({ userId: "p1", email: "ada@example.test", ttlMs: 60000 });
  let releaseWrite;
  let writeStarted;
  const started = new Promise((resolve) => { writeStarted = resolve; });
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  const auth = new AuthService({
    repository,
    sheetService: {
      async setPasswordHash(personId, storedHash) {
        writeStarted();
        await gate;
        const values = structuredClone(dataStore.get("players"));
        const row = values.slice(1).find((entry) => entry[0] === personId);
        row[4] = storedHash;
        dataStore.set("players", values, { source: "write" });
      },
    },
  });
  const proof = auth.createPasswordReset(adminSession.token, "p2");
  const resetting = auth.resetPassword(proof.resetToken, "e".repeat(64));
  await started;
  const oldLogin = auth.login({ email: "peter@example.test", passwordHash: "b".repeat(64), ip: "127.0.0.9" });
  const rejectedLogin = assert.rejects(oldLogin, { code: "LOGIN_FAILED" });
  releaseWrite();

  await resetting;
  await rejectedLogin;
  repository.close();
});
