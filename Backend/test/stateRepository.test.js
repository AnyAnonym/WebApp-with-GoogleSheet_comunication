const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { StateRepository } = require("../stateRepository.js");

test("StateRepository versioniert State und erkennt Konflikte", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const first = repository.setState("court:1", { aktiv: 0 }, 0);
  assert.equal(first.revision, 1);
  assert.deepEqual(repository.getState("court:1", {}), { value: { aktiv: 0 }, revision: 1, updatedAt: first.updatedAt });
  assert.throws(() => repository.setState("court:1", { aktiv: 1 }, 0), { code: "REVISION_CONFLICT" });
  repository.close();
});

test("Sessions laufen ab und werden widerrufen", () => {
  let now = 1000;
  const repository = new StateRepository(":memory:", { now: () => now });
  repository.init();
  const session = repository.createSession({ userId: "p1", email: "a@example.test", ttlMs: 1000 });
  assert.equal(repository.getSession(session.token).userId, "p1");
  now = 2001;
  assert.equal(repository.getSession(session.token), null);
  repository.close();
});

test("Passwort-Reset-Nachweise sind gehasht, einmalig und zeitlich begrenzt", () => {
  let now = 1000;
  const repository = new StateRepository(":memory:", { now: () => now });
  repository.init();
  const first = repository.createPasswordResetProof("p1", "admin-1", 1000);
  const stored = repository.db.prepare("SELECT proof_hash FROM password_reset_proofs").get();
  assert.equal(stored.proof_hash.includes(first.token), false);
  assert.equal(repository.getPasswordResetProof(first.token).personId, "p1");
  const started = repository.beginPasswordResetProof(first.token, "payload-1", "stored-1");
  assert.equal(started.acquired, true);
  assert.equal(repository.beginPasswordResetProof(first.token, "payload-1", "stored-1").acquired, false);
  repository.releasePasswordResetProof(first.token, "payload-1");
  assert.equal(repository.beginPasswordResetProof(first.token, "payload-1", "stored-1").acquired, true);
  assert.equal(repository.completePasswordResetProof(first.token, "payload-1"), true);
  assert.equal(repository.beginPasswordResetProof(first.token, "payload-1", "stored-1").completed, true);
  assert.throws(() => repository.beginPasswordResetProof(first.token, "payload-2", "stored-2"), { code: "RESET_PROOF_CONFLICT" });

  const expired = repository.createPasswordResetProof("p1", "admin-1", 1000);
  now = 2001;
  assert.equal(repository.getPasswordResetProof(expired.token), null);
  repository.close();
});

test("Migration verwirft bereits konsumierte Legacy-Reset-Nachweise", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epiber-reset-migration-"));
  const filename = path.join(directory, "state.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE password_reset_proofs (
      proof_hash TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    )
  `);
  legacy.prepare(`
    INSERT INTO password_reset_proofs(proof_hash, person_id, created_by, created_at, expires_at, consumed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("legacy-proof", "p1", "admin", 100, 100000, 200);
  legacy.close();

  const repository = new StateRepository(filename, { now: () => 1000 });
  repository.init();
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM password_reset_proofs").get().count, 0);
  repository.close();
});

test("Operationen sind idempotent und erkennen Payload-Konflikte", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const operationId = "00000000-0000-4000-8000-000000000001";
  repository.saveOperation("user:p1", operationId, "write", { value: 1 }, { success: true });
  assert.deepEqual(repository.getOperation("user:p1", operationId, "write", { value: 1 }), { success: true });
  assert.equal(repository.getOperationStatus("user:p1", operationId).status, "completed");
  assert.throws(() => repository.getOperation("user:p1", operationId, "write", { value: 2 }), { code: "OPERATION_ID_CONFLICT" });
  repository.close();
});

test("State und Idempotenzdatensatz werden atomar geschrieben", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const operation = {
    stateKey: "court:1",
    fallback: { aktiv: 0 },
    expectedRevision: 0,
    actorKey: "user:p1",
    operationId: "00000000-0000-4000-8000-000000000002",
    endpoint: "courtSetActive",
    payload: { court: "1", active: true },
    update: () => ({ aktiv: 1 }),
    resultForSnapshot: (snapshot) => ({ success: true, revision: snapshot.revision }),
  };
  const first = repository.applyStateOperation(operation);
  assert.equal(first.repeated, false);
  assert.deepEqual(repository.getState("court:1", {}).value, { aktiv: 1 });
  const repeated = repository.applyStateOperation(operation);
  assert.equal(repeated.repeated, true);
  assert.deepEqual(repeated.result, first.result);
  assert.equal(repository.getState("court:1", {}).revision, 1);

  assert.throws(() => repository.applyStateOperation({
    ...operation,
    operationId: "00000000-0000-4000-8000-000000000003",
    expectedRevision: 1,
    update: () => ({ aktiv: 0 }),
    resultForSnapshot: () => {
      throw new Error("result failed");
    },
  }), /result failed/);
  assert.deepEqual(repository.getState("court:1", {}).value, { aktiv: 1 });
  assert.equal(repository.getOperation("user:p1", "00000000-0000-4000-8000-000000000003", "courtSetActive", operation.payload), null);
  repository.close();
});

test("Monitor-Tokens werden nur gehasht gespeichert und sind widerrufbar", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const provisioned = repository.provisionMonitor("Hauptmonitor", "monitor-1");
  assert.equal(repository.authenticateMonitor(provisioned.token).monitorId, "monitor-1");
  repository.revokeMonitor("monitor-1");
  assert.equal(repository.authenticateMonitor(provisioned.token), null);
  repository.close();
});

test("dateibasierter State ueberlebt einen Neustart mit restriktiven Rechten", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epiber-state-"));
  const filename = path.join(directory, "state.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const first = new StateRepository(filename);
  first.init();
  first.setState("court:1", { aktiv: 1 }, 0);
  const monitor = first.provisionMonitor("Persistiert", "monitor-persisted");
  first.close();

  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  const second = new StateRepository(filename);
  second.init();
  assert.deepEqual(second.getState("court:1", {}).value, { aktiv: 1 });
  assert.equal(second.authenticateMonitor(monitor.token).monitorId, "monitor-persisted");
  second.close();
});
