const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { AuditLogRepository } = require("../auditLogRepository.js");

test("Auditlog aktualisiert einen begonnenen Versuch auf sein Ergebnis", () => {
  const repository = new AuditLogRepository(":memory:", { instanceId: "test", journal: false, now: () => 1000 });
  repository.init();
  repository.record({
    eventId: "request-1", actorType: "user", actorId: "p1", role: "admin", action: "courtSetActive",
    targetType: "court", targetId: "1", requestId: "request-1", operationId: "op-1", result: "started", before: { active: false },
    sourceIp: "203.0.113.42", attemptedEmail: "ADA@example.test",
  });
  repository.record({
    eventId: "request-1", actorType: "user", actorId: "p1", actorName: "Ada Admin", role: "admin", action: "courtSetActive",
    targetType: "court", targetId: "1", requestId: "request-1", operationId: "op-1", result: "success", after: { active: true },
    sourceIp: "198.51.100.10", attemptedEmail: "other@example.test",
  });
  assert.deepEqual(repository.get("request-1"), {
    eventId: "request-1",
    occurredAt: new Date(1000).toISOString(),
    actorType: "user",
    actorId: "p1",
    actorName: "Ada Admin",
    role: "admin",
    action: "courtSetActive",
    targetType: "court",
    targetId: "1",
    requestId: "request-1",
    operationId: "op-1",
    result: "success",
    before: { active: false },
    after: { active: true },
    errorCode: null,
    sourceIp: "203.0.113.42",
    attemptedEmail: "ada@example.test",
    instance: "test",
    createdAt: 1000,
    updatedAt: 1000,
  });
  assert.equal(repository.status().count, 1);
  repository.close();
});

test("Auditlog migriert bestehende Dateien additiv auf die personenbezogenen Loginfelder", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epiber-audit-"));
  const filename = path.join(directory, "audit.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE audit_log (
      event_id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL,
      target_type TEXT NOT NULL, target_id TEXT NOT NULL, request_id TEXT NOT NULL,
      operation_id TEXT NOT NULL, result TEXT NOT NULL, before_json TEXT,
      after_json TEXT, error_code TEXT, instance TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO audit_log VALUES (
      'legacy-1', '2026-08-01T10:00:00.000Z', 'user', 'p1', 'admin', 'login',
      'user', 'p1', 'legacy-1', '', 'success', NULL, NULL, NULL, 'paj', 1, 1
    );
  `);
  legacy.close();

  const repository = new AuditLogRepository(filename, { instanceId: "paj", journal: false });
  repository.init();
  const row = repository.get("legacy-1");
  assert.equal(row.actorName, "");
  assert.equal(row.sourceIp, "");
  assert.equal(row.attemptedEmail, "");
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  repository.close();
});

test("Audit-Journal spiegelt Namen, aber nur maskierte E-Mail und IP", () => {
  const events = [];
  const repository = new AuditLogRepository(":memory:", {
    instanceId: "test",
    journal: true,
    now: () => 1000,
    log: (level, event, fields) => events.push({ level, event, fields }),
  });
  repository.init();
  repository.record({
    eventId: "login-1", actorType: "user", actorId: "p1", actorName: "Ada Admin", role: "admin",
    action: "login", targetType: "user", targetId: "p1", requestId: "login-1", result: "success",
    sourceIp: "2001:db8:1234:5678::abcd", attemptedEmail: "ada@example.test",
  });
  assert.deepEqual(events, [{
    level: "info",
    event: "audit_recorded",
    fields: {
      eventId: "login-1",
      action: "login",
      actorType: "user",
      actorId: "p1",
      actorName: "Ada Admin",
      role: "admin",
      targetType: "user",
      targetId: "p1",
      requestId: "login-1",
      operationId: "",
      result: "success",
      errorCode: null,
      sourceIpMasked: "2001:db8:1234:5678::/64",
      attemptedEmailMasked: "a***@example.test",
    },
  }]);
  assert.equal(JSON.stringify(events).includes("ada@example.test"), false);
  assert.equal(JSON.stringify(events).includes("2001:db8:1234:5678::abcd"), false);
  repository.record({
    eventId: "login-2", actorType: "anonymous", actorId: "", role: "anonymous",
    action: "login", targetType: "session", targetId: "", requestId: "login-2", result: "failed",
    sourceIp: "203.0.113.42", attemptedEmail: "peter@example.test", errorCode: "LOGIN_FAILED",
  });
  assert.equal(events[1].fields.sourceIpMasked, "203.0.113.0/24");
  assert.equal(events[1].fields.attemptedEmailMasked, "p***@example.test");
  repository.close();
});

test("Auditlog bewahrt den ersten Vorher-Zustand und kann einen spaeten Tombstone ergaenzen", () => {
  const repository = new AuditLogRepository(":memory:", { instanceId: "test", journal: false, now: () => 1000 });
  repository.init();
  repository.record({
    eventId: "request-before", actorType: "user", actorId: "p1", role: "admin", action: "courtSetActive",
    targetType: "court", targetId: "1", requestId: "request-before", result: "started", before: { active: false },
  });
  repository.record({
    eventId: "request-before", actorType: "user", actorId: "p1", role: "admin", action: "courtSetActive",
    targetType: "court", targetId: "1", requestId: "request-before", result: "success", before: { active: true }, after: { active: true },
  });
  assert.deepEqual(repository.get("request-before").before, { active: false });

  repository.record({
    eventId: "request-delete", actorType: "user", actorId: "p1", role: "player", action: "removeEntryList",
    targetType: "entry", targetId: "", requestId: "request-delete", result: "started",
  });
  repository.record({
    eventId: "request-delete", actorType: "user", actorId: "p1", role: "player", action: "removeEntryList",
    targetType: "entry", targetId: "e1", requestId: "request-delete", result: "unknown", before: { recordId: "e1" },
  });
  assert.deepEqual(repository.get("request-delete").before, { recordId: "e1" });
  repository.close();
});

test("Auditlog verhindert Event-ID-Vermischung und Rueckstufung terminaler Zeilen", () => {
  const repository = new AuditLogRepository(":memory:", { instanceId: "test", journal: false, now: () => 1000 });
  repository.init();
  repository.record({
    eventId: "request-live", actorType: "user", actorId: "p1", role: "admin", action: "courtSetActive",
    targetType: "court", targetId: "1", requestId: "request-live", operationId: "op-1", result: "started",
  });
  assert.throws(() => repository.record({
    eventId: "request-live", actorType: "user", actorId: "p1", role: "admin", action: "monitorNavigate",
    targetType: "monitor", targetId: "m1", requestId: "request-live", operationId: "op-2", result: "started",
  }), { code: "AUDIT_LOG_EVENT_CONFLICT" });
  repository.record({
    eventId: "request-live", actorType: "user", actorId: "p1", role: "admin", action: "courtSetActive",
    targetType: "court", targetId: "1", requestId: "request-live", operationId: "op-1", result: "success",
  });
  assert.throws(() => repository.record({
    eventId: "request-live", actorType: "user", actorId: "p1", role: "admin", action: "courtSetActive",
    targetType: "court", targetId: "1", requestId: "request-live", operationId: "op-1", result: "started",
  }), { code: "AUDIT_LOG_EVENT_CONFLICT" });
  assert.equal(repository.get("request-live").result, "success");
  repository.close();
});

test("Auditlog markiert einen Preflight-Lesefehler als nicht bereit", () => {
  const repository = new AuditLogRepository(":memory:", { instanceId: "test", journal: false, now: () => 1000 });
  repository.init();
  repository.get = () => { throw Object.assign(new Error("read failed"), { code: "SQLITE_IOERR" }); };
  assert.throws(() => repository.record({
    eventId: "request-read", actorType: "user", actorId: "p1", role: "admin", action: "login",
    targetType: "user", targetId: "p1", requestId: "request-read", result: "started",
  }), { code: "SQLITE_IOERR" });
  assert.equal(repository.status().ready, false);
  assert.equal(repository.status().failureCount, 1);
  assert.deepEqual(repository.status().lastError, { at: 1000, code: "SQLITE_IOERR" });
  repository.close();
});
