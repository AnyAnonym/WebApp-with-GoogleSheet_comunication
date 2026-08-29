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
    sourceIp: "203.0.113.42", attemptedEmail: "historical@example.test", attemptedLogin: "ADA.LOGIN",
  });
  repository.record({
    eventId: "request-1", actorType: "user", actorId: "p1", actorName: "Ada Admin", role: "admin", action: "courtSetActive",
    targetType: "court", targetId: "1", requestId: "request-1", operationId: "op-1", result: "success", after: { active: true },
    sourceIp: "198.51.100.10", attemptedEmail: "other@example.test", attemptedLogin: "other.login",
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
    targetName: "",
    requestId: "request-1",
    operationId: "op-1",
    result: "success",
    before: { active: false },
    after: { active: true },
    errorCode: null,
    sourceIp: "203.0.113.42",
    attemptedEmail: "historical@example.test",
    attemptedLogin: "ada.login",
    instance: "test",
    createdAt: 1000,
    updatedAt: 1000,
  });
  assert.equal(repository.status().count, 1);
  repository.close();
});

test("Auditlog migriert bestehende Dateien additiv auf neue personenbezogene Auditfelder", (t) => {
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
  assert.equal(row.targetName, "");
  assert.equal(row.sourceIp, "");
  assert.equal(row.attemptedEmail, "");
  assert.equal(row.attemptedLogin, "");
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
    sourceIp: "2001:db8:1234:5678::abcd", attemptedLogin: "ada@example.test",
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
      targetName: "",
      requestId: "login-1",
      operationId: "",
      result: "success",
      errorCode: null,
      sourceIpMasked: "2001:db8:1234:5678::/64",
      attemptedEmailMasked: "",
      attemptedLoginMasked: "a***@example.test",
      changeSummary: "",
    },
  }]);
  assert.equal(JSON.stringify(events).includes("ada@example.test"), false);
  assert.equal(JSON.stringify(events).includes("2001:db8:1234:5678::abcd"), false);
  repository.record({
    eventId: "login-2", actorType: "anonymous", actorId: "", role: "anonymous",
    action: "login", targetType: "session", targetId: "", requestId: "login-2", result: "failed",
    sourceIp: "203.0.113.42", attemptedLogin: "peter.login", errorCode: "LOGIN_FAILED",
  });
  assert.equal(events[1].fields.sourceIpMasked, "203.0.113.0/24");
  assert.equal(events[1].fields.attemptedEmailMasked, "");
  assert.equal(events[1].fields.attemptedLoginMasked, "p***");
  repository.close();
});

test("Forderungsaudit spiegelt kontrollierten Bewerb und Match fuer alle Ausgaenge", () => {
  const events = [];
  const repository = new AuditLogRepository(":memory:", {
    instanceId: "test",
    journal: true,
    now: () => 1000,
    log: (level, event, fields) => events.push({ level, event, fields }),
  });
  repository.init();

  for (const [suffix, result, errorCode] of [
    ["success", "success", null],
    ["failed", "failed", "OPPONENT_PROTECTED"],
    ["unknown", "unknown", "WRITE_OUTCOME_UNKNOWN"],
  ]) {
    const eventId = `challenge-${suffix}`;
    repository.record({
      eventId,
      actorType: "user",
      actorId: "p1",
      actorName: "Ada Admin",
      role: "player",
      action: "addMatch",
      targetType: "person",
      targetId: "p2",
      targetName: "Peter Player",
      requestId: eventId,
      operationId: `operation-${suffix}`,
      result: "started",
      before: { bewerbId: "ranking-1", opponentId: "p2" },
    });
    repository.record({
      eventId,
      actorType: "user",
      actorId: "p1",
      actorName: "Ada Admin",
      role: "player",
      action: "addMatch",
      targetType: "person",
      targetId: "p2",
      targetName: "Peter Player",
      requestId: eventId,
      operationId: `operation-${suffix}`,
      result,
      after: result === "success" ? { matchId: "m-stable", bewerbId: "ranking-1", opponentId: "p2" } : null,
      errorCode,
    });
  }

  assert.deepEqual(events.map(({ level, event, fields }) => ({
    level,
    event,
    action: fields.action,
    actorId: fields.actorId,
    targetId: fields.targetId,
    targetName: fields.targetName,
    bewerbId: fields.bewerbId,
    matchId: fields.matchId,
    result: fields.result,
    errorCode: fields.errorCode,
  })), [
    { level: "info", event: "audit_recorded", action: "addMatch", actorId: "p1", targetId: "p2", targetName: "Peter Player", bewerbId: "ranking-1", matchId: "m-stable", result: "success", errorCode: null },
    { level: "warn", event: "audit_recorded", action: "addMatch", actorId: "p1", targetId: "p2", targetName: "Peter Player", bewerbId: "ranking-1", matchId: "", result: "failed", errorCode: "OPPONENT_PROTECTED" },
    { level: "info", event: "audit_recorded", action: "addMatch", actorId: "p1", targetId: "p2", targetName: "Peter Player", bewerbId: "ranking-1", matchId: "", result: "unknown", errorCode: "WRITE_OUTCOME_UNKNOWN" },
  ]);
  assert.deepEqual(repository.get("challenge-failed").before, { bewerbId: "ranking-1", opponentId: "p2" });
  repository.close();
});

test("Normalisierungsjournal zeigt Zielname und kontrollierte Aenderungen ohne Kontaktwerte", () => {
  const events = [];
  const repository = new AuditLogRepository(":memory:", {
    instanceId: "test",
    journal: true,
    now: () => 1000,
    log: (level, event, fields) => events.push({ level, event, fields }),
  });
  repository.init();
  repository.record({
    eventId: "normalize-1", actorType: "user", actorId: "admin-1", actorName: "Ada Admin", role: "admin",
    action: "normalizePerson", targetType: "person", targetId: "p2", targetName: "Peter Player",
    requestId: "normalize-1", operationId: "op-1", result: "started",
  });
  repository.record({
    eventId: "normalize-1", actorType: "user", actorId: "admin-1", actorName: "Ada Admin", role: "admin",
    action: "normalizePerson", targetType: "person", targetId: "p2", targetName: "Patrick Player",
    requestId: "normalize-1", operationId: "op-1", result: "success",
    before: { firstName: "Peter", email: "old@example.test", phone: "0043 1 234", active: "0", role: "player" },
    after: { firstName: "Patrick", email: "new@example.test", phone: "0043 1 999", active: "", role: "player B" },
  });
  const stored = repository.get("normalize-1");
  assert.equal(stored.targetName, "Patrick Player");
  assert.equal(stored.before.email, "old@example.test");
  assert.equal(stored.after.email, "new@example.test");
  assert.equal(events.length, 1);
  assert.equal(events[0].fields.targetName, "Patrick Player");
  assert.equal(
    events[0].fields.changeSummary,
    "Vorname geaendert; Telefon geaendert; E-Mail geaendert; Aktiv: 0 -> leer; Rolle: player -> player B",
  );
  const journal = JSON.stringify(events);
  assert.equal(journal.includes("old@example.test"), false);
  assert.equal(journal.includes("new@example.test"), false);
  assert.equal(journal.includes("0043 1 234"), false);
  assert.equal(journal.includes("0043 1 999"), false);
  repository.close();
});

test("Mitgliederabgleich journalisiert CD-ID und Feldnamen ohne importierte Kontaktwerte", () => {
  const events = [];
  const repository = new AuditLogRepository(":memory:", {
    instanceId: "test",
    journal: true,
    now: () => 1000,
    log: (level, event, fields) => events.push({ level, event, fields }),
  });
  repository.init();
  repository.record({
    eventId: "reconcile-1", actorType: "user", actorId: "admin-1", actorName: "Ada Admin", role: "admin",
    action: "reconcilePerson", targetType: "person", targetId: "1033", targetName: "Neue Person",
    requestId: "reconcile-1", operationId: "op-2", result: "success",
    before: null,
    after: { externalId: "1000494", email: "neu@example.test", address: "Dorf 4", active: "1", role: "player B" },
  });
  assert.equal(events[0].fields.changeSummary, "CD-ID geaendert; E-Mail geaendert; Adresse geaendert; Aktiv: unbekannt -> 1; Rolle: unbekannt -> player B");
  const journal = JSON.stringify(events);
  assert.equal(journal.includes("1000494"), false);
  assert.equal(journal.includes("neu@example.test"), false);
  assert.equal(journal.includes("Dorf 4"), false);
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

test("Auditlog erholt sich nach einem transienten Statusprobefehler", () => {
  const repository = new AuditLogRepository(":memory:", { instanceId: "test", journal: false, now: () => 1000 });
  repository.init();
  const prepare = repository.db.prepare.bind(repository.db);
  let fail = true;
  repository.db.prepare = (sql) => {
    if (fail && sql.startsWith("SELECT COUNT")) {
      fail = false;
      throw Object.assign(new Error("probe failed"), { code: "SQLITE_IOERR" });
    }
    return prepare(sql);
  };
  assert.equal(repository.status().ready, false);
  assert.equal(repository.status().ready, true);
  repository.close();
});
