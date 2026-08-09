const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { FrontendLoggingService } = require("../frontendLoggingService.js");
const { StateRepository } = require("../stateRepository.js");

function fixture(now = Date.now()) {
  const repository = new StateRepository(":memory:", { now: () => now.value });
  repository.init();
  const people = [
    { id: "p1", firstName: "Ada", lastName: "Admin", active: true, role: "admin" },
    { id: "p2", firstName: "Peter", lastName: "Player", active: true, role: "player" },
  ];
  const authService = {
    findById: (id) => people.find((person) => person.id === id) || null,
    parsePeople: () => people,
  };
  const logs = [];
  const service = new FrontendLoggingService({
    repository,
    authService,
    appVersion: "4.3.0-test",
    log: (level, event, fields) => logs.push({ level, event, fields }),
    now: () => now.value,
  });
  return { authService, logs, people, repository, service };
}

function settings(expectedRevision, overrides = {}) {
  return {
    expectedRevision,
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
    ...overrides,
  };
}

test("Frontend-Logging-Einstellungen und temporaere Ziele sind revisioniert und laufen ab", () => {
  const now = { value: 1000000 };
  const { service } = fixture(now);
  assert.equal(service.getPolicy("p2").enabled, false);

  const stored = service.updateSettings(settings(0));
  assert.equal(stored.revision, 1);
  assert.equal(service.getPolicy("p2").level, "warn");
  assert.equal(service.getPolicy(null).enabled, false);
  assert.throws(() => service.updateSettings(settings(0)), { code: "REVISION_CONFLICT" });

  const target = service.setTarget({
    expectedRevision: 0,
    personId: "p2",
    level: "debug",
    durationMinutes: 60,
  }, { id: "p1" });
  assert.equal(target.revision, 1);
  assert.deepEqual(service.getPolicy("p2"), {
    enabled: true,
    level: "debug",
    targeted: true,
    expiresAt: now.value + 3600000,
    sampleRatePercent: 100,
    batchSize: 10,
    flushIntervalMs: 5000,
  });
  const view = service.adminView();
  assert.equal(view.targets[0].name, "Peter Player");
  assert.equal(view.targets[0].createdByName, "Ada Admin");

  now.value += 3600001;
  assert.equal(service.getPolicy("p2").targeted, false);
  assert.deepEqual(service.adminView().targets, []);
});

test("Collector reichert erlaubte Events serverseitig an und nimmt keine freien Felder an", () => {
  const now = { value: 2000000 };
  const { logs, service } = fixture(now);
  service.updateSettings(settings(0, { level: "debug", sampleRatePercent: 100 }));

  const result = service.recordBatch({
    sourceIp: "203.0.113.7",
    identity: { id: "p2", name: "Peter Player", role: "player" },
    body: {
      appVersion: "4.3.0-test",
      clientSessionId: "00000000-0000-4000-8000-000000000001",
      pageType: "scoreboard",
      events: [{
        event: "rpc_request_failed",
        level: "warn",
        timestamp: "2026-08-08T10:00:00.000Z",
        code: "REQUEST_TIMEOUT",
        category: "timeout",
        supportId: "support-1",
        endpoint: "players",
        durationMs: 45000,
        attemptCount: 3,
        outcome: "failed",
      }],
    },
  });
  assert.deepEqual(result, { success: true, accepted: 1, dropped: 0 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "frontend_client_event");
  assert.equal(logs[0].fields.actorId, "p2");
  assert.equal(logs[0].fields.actorName, "Peter Player");
  assert.equal(logs[0].fields.sourceIp, "203.0.113.7");
  assert.equal(logs[0].fields.frontendEvent, "rpc_request_failed");
  assert.equal(logs[0].fields.retentionClass, "frontend_normal");
  assert.equal(logs[0].fields.retentionDays, 14);

  assert.throws(() => service.recordBatch({
    sourceIp: "203.0.113.7",
    identity: { id: "p2", name: "Peter Player", role: "player" },
    body: {
      appVersion: "4.3.0-test",
      clientSessionId: "00000000-0000-4000-8000-000000000002",
      pageType: "scoreboard",
      events: [{ event: "frontend_unhandled_error", level: "error", payload: { secret: true } }],
    },
  }), { code: "VALIDATION_ERROR" });
});

test("Anonyme Events benoetigen die explizite globale Freigabe", () => {
  const now = { value: 3000000 };
  const { logs, service } = fixture(now);
  service.updateSettings(settings(0));
  const body = {
    appVersion: "4.3.0-test",
    clientSessionId: "00000000-0000-4000-8000-000000000003",
    pageType: "index",
    events: [{ event: "frontend_unhandled_error", level: "error", code: "UNHANDLED_ERROR" }],
  };
  assert.deepEqual(service.recordBatch({ body, identity: null, sourceIp: "192.0.2.1" }), {
    success: true, accepted: 0, dropped: 1,
  });
  service.updateSettings(settings(1, { includeAnonymous: true }));
  assert.deepEqual(service.recordBatch({ body, identity: null, sourceIp: "192.0.2.1" }), {
    success: true, accepted: 1, dropped: 0,
  });
  assert.equal(logs[0].fields.actorType, "anonymous");
  assert.equal(logs[0].fields.actorId, "");
});

test("Info- und Debug-Sampling wird serverseitig erzwungen und Zielpersonen erhalten 100 Prozent", () => {
  const now = { value: 4000000 };
  const { logs, service } = fixture(now);
  service.updateSettings(settings(0, { level: "debug", sampleRatePercent: 0 }));
  const body = {
    appVersion: "4.3.0-test",
    clientSessionId: "00000000-0000-4000-8000-000000000004",
    pageType: "scoreboard",
    events: [{ event: "frontend_page_loaded", level: "info", durationMs: 1200 }],
  };
  const identity = { id: "p2", name: "Peter Player", role: "player" };
  assert.deepEqual(service.recordBatch({ body, identity, sourceIp: "192.0.2.2" }), {
    success: true, accepted: 0, dropped: 1,
  });
  service.setTarget({ expectedRevision: 0, personId: "p2", level: "debug", durationMinutes: 60 }, { id: "p1" });
  assert.deepEqual(service.recordBatch({ body, identity, sourceIp: "192.0.2.2" }), {
    success: true, accepted: 1, dropped: 0,
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].fields.diagnosticProfile, "targeted");
});

test("Browserdimensionen erzeugen keine frei waehlbaren Loki-Labels", () => {
  const now = { value: 5000000 };
  const { logs, service } = fixture(now);
  service.updateSettings(settings(0));
  const result = service.recordBatch({
    identity: { id: "p2", name: "Peter Player", role: "player" },
    sourceIp: "192.0.2.3",
    body: {
      appVersion: "untrusted-version",
      clientSessionId: "00000000-0000-4000-8000-000000000005",
      pageType: "arbitraryPage123",
      events: [{ event: "frontend_unhandled_error", level: "error", code: "UNHANDLED_ERROR" }],
    },
  });
  assert.deepEqual(result, { success: true, accepted: 1, dropped: 0 });
  assert.equal(logs[0].fields.pageType, "unknown");
  assert.equal(logs[0].fields.clientVersionMatch, false);
  assert.equal(logs[0].fields.clientAppVersion, "untrusted-version");
});
