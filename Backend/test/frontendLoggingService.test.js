const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { FrontendLoggingService } = require("../frontendLoggingService.js");
const { StateRepository } = require("../stateRepository.js");
const metrics = require("../metrics.js");

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
  metrics.resetForTests();
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

test("Frontend-Retentionklassen sind fest auf 14 und 7 Tage begrenzt", () => {
  const now = { value: 1500000 };
  const { service } = fixture(now);
  assert.throws(() => service.updateSettings(settings(0, { normalRetentionDays: 15 })), { code: "VALIDATION_ERROR" });
  assert.throws(() => service.updateSettings(settings(0, { targetedRetentionDays: 8 })), { code: "VALIDATION_ERROR" });
  const stored = service.updateSettings(settings(0));
  assert.equal(stored.value.normalRetentionDays, 14);
  assert.equal(stored.value.targetedRetentionDays, 7);
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

test("Bewerbshistorienfehler akzeptiert nur kontrollierte Browserdiagnosefelder", () => {
  const now = { value: 2250000 };
  const { logs, service } = fixture(now);
  service.updateSettings(settings(0));
  const body = {
    appVersion: "4.7.0-test",
    clientSessionId: "00000000-0000-4000-8000-000000000021",
    pageType: "Bewerbe",
    events: [{
      event: "competition_history_load_failed",
      level: "error",
      timestamp: "2026-09-01T10:00:00.000Z",
      code: "REQUEST_TIMEOUT",
      supportId: "support-history-1",
    }],
  };

  assert.deepEqual(service.recordBatch({ sourceIp: "203.0.113.9", identity: { id: "p2", name: "Peter Player", role: "player" }, body }), { success: true, accepted: 1, dropped: 0 });
  assert.equal(logs[0].fields.frontendEvent, "competition_history_load_failed");
  assert.throws(() => service.recordBatch({
    sourceIp: "203.0.113.9",
    identity: { id: "p2", name: "Peter Player", role: "player" },
    body: { ...body, events: [{ ...body.events[0], competitionName: "Privater Bewerb" }] },
  }), { code: "VALIDATION_ERROR" });
});

test("Termin- und Adminfehler im Ranglistenprofil sind als kontrollierte Browserdiagnosen bekannt", () => {
  const now = { value: 2350000 };
  const { logs, service } = fixture(now);
  service.updateSettings(settings(0));
  const result = service.recordBatch({
    sourceIp: "203.0.113.10",
    identity: { id: "p2", name: "Peter Player", role: "player" },
    body: {
      appVersion: "4.7.0-test",
      clientSessionId: "00000000-0000-4000-8000-000000000022",
      pageType: "rangliste",
      events: [{
        event: "ranking_match_date_failed",
        level: "error",
        timestamp: "2026-09-02T10:00:00.000Z",
        code: "MATCH_DATE_UNCHANGED",
        supportId: "support-match-date-1",
      }, {
        event: "ranking_admin_action_failed",
        level: "error",
        timestamp: "2026-09-02T10:01:00.000Z",
        code: "RANKING_CHALLENGE_CLOSED",
        supportId: "support-ranking-admin-1",
      }],
    },
  });
  assert.deepEqual(result, { success: true, accepted: 2, dropped: 0 });
  assert.equal(logs[0].fields.pageType, "rangliste");
  assert.equal(logs[0].fields.frontendEvent, "ranking_match_date_failed");
  assert.equal(logs[0].fields.code, "MATCH_DATE_UNCHANGED");
  assert.equal(logs[1].fields.frontendEvent, "ranking_admin_action_failed");
});

test("Matchergebnis-HMI akzeptiert nur kontrollierte Aktions- und Vorschlagsfehler", () => {
  const now = { value: 2360000 };
  const { logs, service } = fixture(now);
  service.updateSettings(settings(0));
  const result = service.recordBatch({
    sourceIp: "203.0.113.11",
    identity: { id: "p2", name: "Peter Player", role: "player" },
    body: {
      appVersion: "test",
      clientSessionId: "00000000-0000-4000-8000-000000000023",
      pageType: "players",
      events: [{
        event: "match_result_action_failed",
        level: "error",
        timestamp: "2026-09-04T10:00:00.000Z",
        code: "RANKING_REPAIR_REQUIRED",
      }, {
        event: "match_result_suggestion_failed",
        level: "warn",
        timestamp: "2026-09-04T10:01:00.000Z",
        code: "SUGGESTION_SOURCE_INVALID",
      }],
    },
  });
  assert.deepEqual(result, { success: true, accepted: 2, dropped: 0 });
  assert.deepEqual(logs.map(({ fields }) => fields.frontendEvent), [
    "match_result_action_failed",
    "match_result_suggestion_failed",
  ]);
});

test("Personennormalisierungsfehler werden mit kontrollierten Feldern angenommen", () => {
  const now = { value: 2500000 };
  const { logs, service } = fixture(now);
  service.updateSettings(settings(0));

  const result = service.recordBatch({
    sourceIp: "203.0.113.8",
    identity: { id: "p1", name: "Ada Admin", role: "admin" },
    body: {
      appVersion: "4.3.0-test",
      clientSessionId: "00000000-0000-4000-8000-000000000010",
      pageType: "personenNormalisieren",
      events: [
        {
          event: "people_normalization_write_failed",
          level: "error",
          timestamp: "2026-08-19T02:43:10.000Z",
          code: "PERSON_CONFLICT",
          supportId: "support-normalization-1",
          count: 0,
        },
        {
          event: "people_normalization_load_failed",
          level: "error",
          timestamp: "2026-08-19T02:43:11.000Z",
          code: "DATA_NOT_READY",
        },
        {
          event: "people_normalization_auth_failed",
          level: "error",
          timestamp: "2026-08-19T02:43:12.000Z",
          code: "AUTH_REQUIRED",
        },
      ],
    },
  });

  assert.deepEqual(result, { success: true, accepted: 3, dropped: 0 });
  assert.equal(logs[0].fields.pageType, "personenNormalisieren");
  assert.equal(logs[0].fields.frontendEvent, "people_normalization_write_failed");
  assert.equal(logs[0].fields.code, "PERSON_CONFLICT");
  assert.equal(logs[0].fields.supportId, "support-normalization-1");
  assert.equal(logs[0].fields.count, 0);
  assert.deepEqual(logs.map((entry) => entry.fields.frontendEvent), [
    "people_normalization_write_failed",
    "people_normalization_load_failed",
    "people_normalization_auth_failed",
  ]);
  assert.equal(JSON.stringify(logs[0]).includes("Adresse"), false);
});

test("Mitgliederabgleich akzeptiert nur benannte Diagnoseereignisse ohne Importwerte", () => {
  const { logs, service } = fixture({ value: 2600000 });
  service.updateSettings(settings(0));
  const result = service.recordBatch({
    sourceIp: "203.0.113.8",
    identity: { id: "p1", name: "Ada Admin", role: "admin" },
    body: {
      appVersion: "4.5.1-test",
      clientSessionId: "00000000-0000-4000-8000-000000000011",
      pageType: "mitgliederAbgleichen",
      events: [
        { event: "member_reconciliation_parse_failed", level: "error", code: "CSV_ID_DUPLICATE" },
        { event: "member_reconciliation_write_failed", level: "error", code: "PERSON_CONFLICT", supportId: "support-import-1", count: 2 },
        { event: "member_reconciliation_load_failed", level: "error", code: "DATA_NOT_READY" },
        { event: "member_reconciliation_auth_failed", level: "error", code: "AUTH_REQUIRED" },
      ],
    },
  });

  assert.deepEqual(result, { success: true, accepted: 4, dropped: 0 });
  assert.deepEqual(logs.map((entry) => entry.fields.frontendEvent), [
    "member_reconciliation_parse_failed",
    "member_reconciliation_write_failed",
    "member_reconciliation_load_failed",
    "member_reconciliation_auth_failed",
  ]);
  assert.equal(logs[1].fields.count, 2);
  assert.equal(JSON.stringify(logs).includes("E-Mail"), false);
  assert.equal(JSON.stringify(logs).includes("CSV-Rohdaten"), false);
});

test("Servicebereich akzeptiert nur kontrollierte Aktualisierungsdiagnosen", () => {
  const { logs, service } = fixture({ value: 2700000 });
  service.updateSettings(settings(0));
  const result = service.recordBatch({
    sourceIp: "203.0.113.8",
    identity: { id: "p1", name: "Ada Admin", role: "admin" },
    body: {
      appVersion: "4.6.0-test",
      clientSessionId: "00000000-0000-4000-8000-000000000012",
      pageType: "servicebereich",
      events: [
        { event: "sheet_data_status_load_failed", level: "error", code: "DATA_NOT_READY" },
        { event: "sheet_data_refresh_failed", level: "error", code: "DATA_REFRESH_FAILED", supportId: "support-refresh-1" },
        { event: "service_area_auth_failed", level: "error", code: "AUTH_REQUIRED" },
      ],
    },
  });

  assert.deepEqual(result, { success: true, accepted: 3, dropped: 0 });
  assert.deepEqual(logs.map((entry) => entry.fields.frontendEvent), [
    "sheet_data_status_load_failed",
    "sheet_data_refresh_failed",
    "service_area_auth_failed",
  ]);
  assert.equal(logs[1].fields.supportId, "support-refresh-1");
  assert.equal(JSON.stringify(logs).includes("Personen"), false);
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
