const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { AuditLogRepository } = require("../auditLogRepository.js");

test("Auditlog aktualisiert einen begonnenen Versuch auf sein Ergebnis", () => {
  const repository = new AuditLogRepository(":memory:", { instanceId: "test", journal: false, now: () => 1000 });
  repository.init();
  repository.record({
    eventId: "request-1", actorType: "user", actorId: "p1", role: "admin", action: "courtSetActive",
    targetType: "court", targetId: "1", requestId: "request-1", operationId: "op-1", result: "started", before: { active: false },
  });
  repository.record({
    eventId: "request-1", actorType: "user", actorId: "p1", role: "admin", action: "courtSetActive",
    targetType: "court", targetId: "1", requestId: "request-1", operationId: "op-1", result: "success", after: { active: true },
  });
  assert.deepEqual(repository.get("request-1"), {
    eventId: "request-1",
    occurredAt: new Date(1000).toISOString(),
    actorType: "user",
    actorId: "p1",
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
    instance: "test",
    createdAt: 1000,
    updatedAt: 1000,
  });
  assert.equal(repository.status().count, 1);
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
