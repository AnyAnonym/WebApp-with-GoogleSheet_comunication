const test = require("node:test");
const assert = require("node:assert/strict");
const { peopleFixture, setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const dataStore = require("../dataStore.js");
const { READINESS_SLOW_MAX_AGE_MS } = require("../config.js");
const { AuthService } = require("../authService.js");
const { StateRepository } = require("../stateRepository.js");

test.beforeEach(() => {
  dataStore.resetForTests();
  const people = peopleFixture();
  people[0].push("Login");
  people[1].push("ada.login");
  people[2].push("peter.login");
  dataStore.set("players", people, { source: "test" });
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

test("Mitgliederprofil enthaelt Kontaktdaten und Geburtsdatum", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const auth = new AuthService({ repository, sheetService: {} });

  assert.deepEqual(auth.publicProfile("p2"), { id: "p2", firstName: "Peter", lastName: "Player" });
  assert.deepEqual(auth.memberProfile("p2"), {
    id: "p2",
    firstName: "Peter",
    lastName: "Player",
    email: "peter@example.test",
    phone: "+43456",
    birthDate: "19850304",
  });
  assert.deepEqual(auth.memberProfile("p2", { includeAdminFields: true }), {
    id: "p2", firstName: "Peter", lastName: "Player", email: "peter@example.test",
    phone: "+43456", birthDate: "19850304", login: "peter.login", passwordSetupAllowed: false,
  });
  assert.equal(auth.privateProfile(auth.findById("p2")).login, "peter.login");
  repository.close();
});

test("Login migriert Legacy-Hash und erzeugt serverseitige Session", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  let upgraded = null;
  const sheetService = { setPasswordHash: async (id, value) => { upgraded = { id, value }; } };
  const auth = new AuthService({ repository, sheetService });
  const result = await auth.login({ login: "ADA.LOGIN", passwordHash: "a".repeat(64), ip: "127.0.0.1" });
  assert.equal(result.user.role, "admin");
  assert.equal(upgraded.id, "p1");
  assert.match(upgraded.value, /^scrypt\$v1\$/);
  assert.equal(repository.getSession(result.session.token).userId, "p1");
  repository.close();
});

test("ungueltige Kontakt-E-Mail blockiert weder unabhaengigen Login noch Personenprojektion", async () => {
  const people = structuredClone(dataStore.get("players"));
  people[2][3] = "peter@example";
  dataStore.set("players", people, { source: "test-invalid-email" });
  const repository = new StateRepository(":memory:");
  repository.init();
  const auth = new AuthService({ repository, sheetService: { async setPasswordHash() {} } });

  const result = await auth.login({ login: "ada.login", passwordHash: "a".repeat(64), ip: "127.0.0.1" });
  assert.equal(result.user.id, "p1");
  assert.equal(auth.memberProfile("p2").email, "");
  assert.equal((await auth.login({ login: "peter.login", passwordHash: "b".repeat(64), ip: "127.0.0.2" })).user.id, "p2");
  repository.close();
});

test("doppelte Kontakt-E-Mail ist erlaubt und beeinflusst Login nicht", async () => {
  const people = structuredClone(dataStore.get("players"));
  people[2][3] = "ADA@example.test";
  dataStore.set("players", people, { source: "test-duplicate-email" });
  const repository = new StateRepository(":memory:");
  repository.init();
  const auth = new AuthService({ repository, sheetService: { async setPasswordHash() {} } });

  assert.equal((await auth.login({ login: "ada.login", passwordHash: "a".repeat(64), ip: "127.0.0.9" })).user.id, "p1");
  repository.close();
});

test("doppelte, ungueltige und leere Logins bleiben lesbar, aber koennen nicht authentifizieren", async () => {
  const people = structuredClone(dataStore.get("players"));
  people[2][11] = "ADA.LOGIN";
  people.push(["p3", "Invalid", "Login", "third@example.test", "c".repeat(64), "", "", "", "1", "player", "", " bad login "]);
  people.push(["p4", "Blank", "Login", "fourth@example.test", "d".repeat(64), "", "", "", "1", "player", "", ""]);
  dataStore.set("players", people, { source: "test-login-quality" });
  const repository = new StateRepository(":memory:");
  repository.init();
  const auth = new AuthService({ repository, sheetService: {} });
  assert.equal(auth.findById("p3").loginRaw, " bad login ");
  assert.equal(auth.findById("p3").login, "");
  assert.equal(auth.publicPlayersTable().length, 5);
  await assert.rejects(auth.login({ login: "ada.login", passwordHash: "a".repeat(64), ip: "127.0.0.9" }), { code: "LOGIN_FAILED" });
  await assert.rejects(auth.login({ login: " bad login ", passwordHash: "c".repeat(64), ip: "127.0.0.10" }), { code: "VALIDATION_ERROR" });
  repository.close();
});

test("Login-Limiter blockiert wiederholte Fehler", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const auth = new AuthService({ repository, sheetService: {} });
  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects(auth.login({ login: "ada.login", passwordHash: "f".repeat(64), ip: "127.0.0.2" }));
  }
  await assert.rejects(
    auth.login({ login: "ADA.LOGIN", passwordHash: "a".repeat(64), ip: "127.0.0.2" }),
    { code: "LOGIN_RATE_LIMIT" },
  );
  repository.close();
});

test("fehlende oder veraltete Personendaten widerrufen keine gueltige Session", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const session = repository.createSession({ userId: "p1", email: "ada@example.test", login: "ada.login", ttlMs: 60000 });
  dataStore.resetForTests();
  const auth = new AuthService({ repository, sheetService: {} });

  assert.throws(() => auth.getUserForToken(session.token), { code: "PERSON_DATA_UNAVAILABLE" });
  assert.equal(repository.getSession(session.token).userId, "p1");
  repository.close();
});

test("Diagnoseidentitaet verwendet nur eine gueltige Session mit aktiver Person", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const session = repository.createSession({ userId: "p1", email: "ada@example.test", login: "ada.login", ttlMs: 60000 });
  const auth = new AuthService({ repository, sheetService: {} });
  assert.deepEqual(auth.getDiagnosticIdentity(session.token), { id: "p1", name: "Ada Admin", role: "admin" });

  const inactive = structuredClone(peopleFixture());
  inactive[1][8] = "0";
  dataStore.set("players", inactive, { source: "test-inactive" });
  assert.equal(auth.getDiagnosticIdentity(session.token), null);
  assert.equal(repository.getSession(session.token), null);
  repository.close();
});

test("Loginwechsel widerruft eine noch gespeicherte Session beim naechsten Zugriff", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const session = repository.createSession({ userId: "p1", email: "ada@example.test", login: "alter.login", ttlMs: 60000 });
  const auth = new AuthService({ repository, sheetService: {} });

  assert.equal(auth.getUserForToken(session.token), null);
  assert.equal(repository.getSession(session.token), null);
  repository.close();
});

test("gueltige Adminsession kann opt-in die Last-known-good-Rolle aus stale Personen verwenden", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const adminSession = repository.createSession({ userId: "p1", email: "ada@example.test", login: "ada.login", ttlMs: 60000 });
  const playerSession = repository.createSession({ userId: "p2", email: "peter@example.test", login: "peter.login", ttlMs: 60000 });
  const auth = new AuthService({ repository, sheetService: {} });
  const lastUpdate = dataStore.getMeta("players").lastUpdate;
  const originalNow = Date.now;
  Date.now = () => lastUpdate + READINESS_SLOW_MAX_AGE_MS + 1;
  try {
    assert.throws(() => auth.requireRole(adminSession.token, ["admin"]), { code: "PERSON_DATA_UNAVAILABLE" });
    const admin = auth.requireRole(adminSession.token, ["admin"], { allowLastKnownGoodRole: true });
    assert.equal(admin.principal.role, "admin");
    assert.equal(admin.principal.roleSource, "last_known_good");
    assert.deepEqual(auth.getDiagnosticIdentity(adminSession.token), { id: "p1", name: "Ada Admin", role: "admin" });
    assert.throws(
      () => auth.requireRole(playerSession.token, ["admin"], { allowLastKnownGoodRole: true }),
      { code: "FORBIDDEN" },
    );
    assert.equal(repository.getSession(adminSession.token).userId, "p1");
  } finally {
    Date.now = originalNow;
    repository.close();
  }
});

test("LKG-Rollenpruefung verlangt einen zuvor erfolgreich geladenen Personen-Cache", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const session = repository.createSession({ userId: "p1", email: "ada@example.test", login: "ada.login", ttlMs: 60000 });
  dataStore.resetForTests();
  const auth = new AuthService({ repository, sheetService: {} });

  assert.throws(
    () => auth.requireRole(session.token, ["admin"], { allowLastKnownGoodRole: true }),
    { code: "PERSON_DATA_UNAVAILABLE" },
  );
  assert.equal(repository.getSession(session.token).userId, "p1");
  repository.close();
});

test("unklarer Passwort-Write widerruft vorsorglich alle Sitzungen", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const session = repository.createSession({ userId: "p1", email: "ada@example.test", login: "ada.login", ttlMs: 60000 });
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
  const oldSession = repository.createSession({ userId: "p1", email: "ada@example.test", login: "ada.login", ttlMs: 60000 });
  const auth = new AuthService({ repository, sheetService: { async setPasswordHash() {} } });

  const result = await auth.changeOwnPassword(oldSession.token, "a".repeat(64), "b".repeat(64));
  assert.equal(repository.getSession(oldSession.token), null);
  assert.equal(repository.getSession(result.session.token).userId, "p1");
  assert.notEqual(result.session.token, oldSession.token);
  repository.close();
});

test("nur Admin setzt das Passwort einer anderen Person und widerruft deren Sitzungen", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const adminSession = repository.createSession({ userId: "p1", email: "ada@example.test", login: "ada.login", ttlMs: 60000 });
  const playerSession = repository.createSession({ userId: "p2", email: "peter@example.test", login: "peter.login", ttlMs: 60000 });
  let passwordWrite = null;
  const auth = new AuthService({
    repository,
    sheetService: { async setPasswordHash(personId, storedHash, options) { passwordWrite = { personId, storedHash, options }; } },
  });

  await assert.rejects(auth.setPasswordAsAdmin(playerSession.token, "p1", "c".repeat(64)), { code: "FORBIDDEN" });
  assert.deepEqual(await auth.setPasswordAsAdmin(adminSession.token, "p2", "c".repeat(64)), { success: true, personId: "p2" });
  assert.equal(passwordWrite.personId, "p2");
  assert.equal(passwordWrite.options.expectedHash, "b".repeat(64));
  assert.match(passwordWrite.storedHash, /^scrypt\$v1\$/);
  assert.equal(repository.getSession(playerSession.token), null);
  assert.equal(repository.getSession(adminSession.token).userId, "p1");
  repository.close();
});

test("Admin erstellt einen einmaligen Reset-Nachweis", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const adminSession = repository.createSession({ userId: "p1", email: "ada@example.test", login: "ada.login", ttlMs: 60000 });
  const playerSession = repository.createSession({ userId: "p2", email: "peter@example.test", login: "peter.login", ttlMs: 60000 });
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

test("Admin verwaltet die dauerhafte Passwortfreigabe", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const adminSession = repository.createSession({ userId: "p1", email: "ada@example.test", login: "ada.login", ttlMs: 60000 });
  const playerSession = repository.createSession({ userId: "p2", email: "peter@example.test", login: "peter.login", ttlMs: 60000 });
  const writes = [];
  const auth = new AuthService({
    repository,
    sheetService: { async setPasswordSetupAllowed(personId, allowed) { writes.push({ personId, allowed }); } },
  });

  await assert.rejects(auth.setPasswordSetupAllowed(playerSession.token, "p1", true), { code: "FORBIDDEN" });
  assert.deepEqual(await auth.setPasswordSetupAllowed(adminSession.token, "p2", true), {
    success: true,
    personId: "p2",
    allowed: true,
  });
  assert.deepEqual(writes, [{ personId: "p2", allowed: true }]);
  repository.close();
});

test("freigegebene aktive Person setzt ihr Passwort einmalig", async () => {
  const people = structuredClone(dataStore.get("players"));
  people[2][5] = "x";
  dataStore.set("players", people, { source: "test" });
  const repository = new StateRepository(":memory:");
  repository.init();
  const oldSession = repository.createSession({ userId: "p2", email: "peter@example.test", login: "peter.login", ttlMs: 60000 });
  let passwordWrite = null;
  const auth = new AuthService({
    repository,
    sheetService: {
      async setPasswordHash(personId, storedHash, options) {
        passwordWrite = { personId, storedHash, options };
        const current = structuredClone(dataStore.get("players"));
        current[2][4] = storedHash;
        current[2][5] = "";
        dataStore.set("players", current, { source: "write" });
      },
    },
  });

  assert.deepEqual(await auth.setupPassword("PETER.LOGIN", "d".repeat(64)), { success: true });
  assert.equal(passwordWrite.personId, "p2");
  assert.equal(passwordWrite.options.expectedHash, "b".repeat(64));
  assert.equal(passwordWrite.options.requirePasswordSetupAllowed, true);
  assert.match(passwordWrite.storedHash, /^scrypt\$v1\$/);
  assert.equal(repository.getSession(oldSession.token), null);
  await assert.rejects(auth.setupPassword("peter.login", "e".repeat(64)), { code: "PASSWORD_SETUP_INVALID" });
  repository.close();
});

test("Passwortvergabe bleibt fuer inaktive Personen gesperrt", async () => {
  const people = structuredClone(dataStore.get("players"));
  people[2][5] = "x";
  people[2][8] = "0";
  dataStore.set("players", people, { source: "test" });
  const repository = new StateRepository(":memory:");
  repository.init();
  const auth = new AuthService({ repository, sheetService: {} });

  await assert.rejects(auth.setupPassword("peter.login", "d".repeat(64)), { code: "PASSWORD_SETUP_INVALID" });
  repository.close();
});

test("globale scrypt-Grenze schuetzt auch abgelehnte Passwortvergaben", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const auth = new AuthService({ repository, sheetService: {} });

  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => (
    auth.setupPassword(`unknown-${index}`, "d".repeat(64))
  )));
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "AUTH_BUSY").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "PASSWORD_SETUP_INVALID").length, 4);
  repository.close();
});

test("Login mit altem Passwort kann einen laufenden Reset nicht ueberholen", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const adminSession = repository.createSession({ userId: "p1", email: "ada@example.test", login: "ada.login", ttlMs: 60000 });
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
  const oldLogin = auth.login({ login: "peter.login", passwordHash: "b".repeat(64), ip: "127.0.0.9" });
  const rejectedLogin = assert.rejects(oldLogin, { code: "LOGIN_FAILED" });
  releaseWrite();

  await resetting;
  await rejectedLogin;
  repository.close();
});
