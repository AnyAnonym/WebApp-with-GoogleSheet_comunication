const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AuditLogRepository } = require("../auditLogRepository.js");
const { MessagingRepository } = require("../messagingRepository.js");
const {
  COMPETITION_IDS,
  EVENTS,
  MATCHES,
  PEOPLE,
  applySeed,
  cleanupSeed,
  dryRun,
  inspectEventsReadOnly,
  replaceAll,
} = require("../scripts/historyTestSeed.js");

const MATCH_HEADER = [
  "Bemerkung", "Spieler3ID", "ID", "BewerbID", "Ignore", "Ergebnis",
  "Spieler1ID", "MatchDate", "Spieler4ID", "ForderungDate", "Spieler2ID", "BewerbRunde",
  "Spieler1RangBeiErgebnis", "Spieler3RangBeiErgebnis", "MatchStart", "ErgebnisErfasstAm",
];

function baseTables() {
  return {
    Personen: [
      ["Nachname", "Aktiv", "ID", "Vorname"],
      ["Bauer", "1", "3", "Martina"],
      ["Hartl", "1", "30", "Christian"],
      ["Kerl", "1", "47", "Christian"],
      ["Kruiß", "1", "55", "Wolfgang"],
      ["Mollner", "1", "65", "Robert"],
      ["Pimminger", "1", "81", "Alfred"],
      ["Pimminger", "1", "82", "Anita"],
      ["Steinmayr", "1", "109", "Jürgen"],
      ["Other", "1", "999", "Una"],
    ],
    Bewerb: [
      ["Bezeichnung", "BewerbsartID", "ID"],
      ["Rangliste Männer", "2", "2"],
      ["Rangliste Frauen", "2", "3"],
      ["VM 2026 Männer A", "5", "5"],
      ["VM 2026 Frauen Vorrunde", "7", "6"],
      ["VM 2026 Mixed Doppel Vorrunde", "7", "9"],
      ["VM 2026 Männer Doppel", "3", "11"],
      ["VM 2026 Frauen Endrunde", "8", "13"],
      ["Anderer Bewerb", "1", "99"],
    ],
    "RL-Platzierung": [
      ["Rang", "PersonID", "BewerbID", "RausgehangenAm", "RausgehangenGrund"],
      ["7", "47", "2", "", ""],
      ["5", "81", "2", "", ""],
      ["3", "3", "3", "", ""],
      ["1", "82", "3", "", ""],
      ["0", "30", "2", "260805-0900", "Bestehender kontrollierter Grund"],
      ["0", "55", "2", "260806-0900", "Bestehender kontrollierter Grund"],
      ["1", "999", "2", "", ""],
    ],
    Matches1: [
      MATCH_HEADER,
      ["nicht löschen", "999", "real-match", "99", "", "6-0/6-0", "81", "260701-1000", "", "", "", "F", "", "", "", ""],
    ],
  };
}

function clone(value) {
  return structuredClone(value);
}

function fakeSheets(initial = baseTables()) {
  const tables = clone(initial);
  const writes = { append: 0, clear: 0 };
  const values = {
    async batchGet({ ranges }) {
      return { data: { valueRanges: ranges.map((range) => ({ values: clone(tables[range]) })) } };
    },
    async append({ requestBody }) {
      writes.append++;
      tables.Matches1.push(...clone(requestBody.values));
      return { data: {} };
    },
    async clear({ range }) {
      writes.clear++;
      const rowNumber = Number(range.match(/!A(\d+):/)[1]);
      tables.Matches1[rowNumber - 1] = [];
      return { data: {} };
    },
  };
  return { sheets: { spreadsheets: { values } }, tables, writes };
}

function repositories() {
  const messaging = new MessagingRepository(":memory:", { now: () => 1234 });
  messaging.init();
  const audit = new AuditLogRepository(":memory:", { instanceId: "paj", journal: false, now: () => 1234 });
  audit.init();
  return { messaging, audit, close: () => { messaging.close(); audit.close(); } };
}

function matchObjects(table) {
  const indexes = new Map(table[0].map((name, index) => [name, index]));
  return table.slice(1).filter((row) => row.length).map((row) => Object.fromEntries(MATCH_HEADER.map((name) => [name, String(row[indexes.get(name)] || "")])));
}

function insertMatchRow(table, desired, remark = "") {
  table.push(MATCH_HEADER.map((name) => name === "Bemerkung" ? remark : (desired[name] || "")));
}

function seedNonTestMessaging(repository) {
  repository.ensureEvent({
    id: "real-event", competitionId: "99", createdAt: 1, type: "notice", source: "system", sourceId: "real-source",
    actorId: "system", actorName: "System", summary: "Echte Nachricht.", detail: "Bleibt bei Cleanup.", result: "",
  }, [{
    userId: "999", role: "recipient", displayName: "Una Other", messageId: "real-message", type: "notice",
    subject: "Echte Nachricht", body: "Nicht Teil der Testhistorie.", deliveries: [{ channel: "Inbox", status: "delivered" }],
  }]);
  repository.acknowledge("999", "real-ack-operation", "real-message");
}

test("dataset has the exact event, match, participant, identity, and chronology matrix", () => {
  assert.equal(EVENTS.length, 18);
  assert.equal(MATCHES.length, 16);
  assert.equal(EVENTS.flatMap(({ participants }) => participants).length, 42);
  assert.deepEqual(PEOPLE, {
    "3": "Martina Bauer", "30": "Christian Hartl", "47": "Christian Kerl", "55": "Wolfgang Kruiß",
    "65": "Robert Mollner", "81": "Alfred Pimminger", "82": "Anita Pimminger", "109": "Jürgen Steinmayr",
  });
  const recipientCounts = Object.fromEntries(Object.keys(PEOPLE).map((id) => [id, EVENTS.reduce((sum, item) => sum + item.participants.filter(({ userId }) => userId === id).length, 0)]));
  assert.deepEqual(recipientCounts, { "3": 5, "30": 6, "47": 5, "55": 6, "65": 5, "81": 5, "82": 5, "109": 5 });
  assert.deepEqual(EVENTS.map(({ event }) => event.type), [
    "challenge", "challenge", "challenge", "challenge", "ranking_withdrawal", "ranking_withdrawal",
    "appointment", "result", "appointment", "appointment", "appointment", "result", "result", "result",
    "result", "result", "result", "result",
  ]);
  assert.deepEqual(EVENTS.map(({ event }) => event.competitionId), ["2", "2", "3", "3", "2", "2", "5", "6", "5", "5", "5", "5", "5", "5", "11", "9", "11", "9"]);
  assert.deepEqual(COMPETITION_IDS, ["2", "3", "5", "6", "9", "11", "13"]);
  assert.deepEqual(EVENTS.slice(0, 4).map(({ event }) => event.summary), [
    "Christian Kerl (7) hat Alfred Pimminger (5) gefordert.",
    "Christian Kerl (7) hat Alfred Pimminger (5) gefordert.",
    "Martina Bauer (3) hat Anita Pimminger (1) gefordert.",
    "Martina Bauer (3) hat Anita Pimminger (1) gefordert.",
  ]);
  assert.ok(EVENTS.every(({ event }) => !/^(?:Forderung|Einzel-Ergebnis|Doppel-Ergebnis|Spieltermin|Ranglisten-Rückzug):/.test(event.summary)));
  assert.ok(EVENTS.flatMap(({ participants }) => participants).every(({ deliveries }) => deliveries.length === 1 && deliveries[0].channel === "Inbox" && deliveries[0].status === "delivered"));
  assert.ok(EVENTS.every(({ event }, index) => event.createdAt === Date.UTC(2026, 7, index + 1, 8)));
  assert.ok(EVENTS.flatMap(({ event, participants }) => [event.id, ...participants.map(({ messageId }) => messageId)]).every((id) => id.startsWith("test-history-") && id.length <= 64));

  const rowsById = new Map(MATCHES.map((row) => [row.ID, row]));
  assert.equal(MATCHES.filter(({ ForderungDate, MatchDate }) => ForderungDate && !MatchDate).length, 4);
  assert.equal(MATCHES.filter(({ MatchDate, Ergebnis }) => MatchDate && !Ergebnis).length, 4);
  assert.equal(MATCHES.filter(({ Ergebnis }) => Ergebnis).length, 8);
  assert.ok(MATCHES.every(({ Ignore, BewerbRunde }) => Ignore === "1" && /^(?:R1|VF|HF|F|G1|G2)$/.test(BewerbRunde)));
  assert.ok(EVENTS.filter(({ event }) => event.source === "match").every(({ event }) => rowsById.has(event.sourceId)));
  assert.equal(EVENTS.filter(({ event }) => event.type === "ranking_withdrawal").every(({ event }) => !rowsById.has(event.sourceId)), true);
});

test("dry-run validates all four sheet tables and the full projection without writes", async () => {
  const fake = fakeSheets();
  let inspected = 0;
  const result = await dryRun({ sheets: fake.sheets, sheetId: "sheet", eventInspector: (events) => { inspected = events.length; } });
  assert.deepEqual(result, {
    mode: "dry-run", status: "success", matchCount: 16, missingMatchCount: 16,
    eventCount: 18, messageCount: 42, competitionIds: ["2", "3", "5", "6", "9", "11", "13"],
  });
  assert.equal(inspected, 18);
  assert.deepEqual(fake.writes, { append: 0, clear: 0 });
});

test("replace-all dry-run accepts exact old and conflicting rows without writes", async () => {
  const tables = baseTables();
  insertMatchRow(tables.Matches1, { ...MATCHES[0], Spieler3ID: "109" });
  insertMatchRow(tables.Matches1, { ...MATCHES[1], ID: "test-history-match-03-appointment" });
  const fake = fakeSheets(tables);
  let inspected = 0;
  const result = await dryRun({ sheets: fake.sheets, sheetId: "sheet", replaceAll: true, eventInspector: (events) => { inspected = events.length; } });
  assert.deepEqual(result, {
    mode: "dry-run", operation: "replace-all", status: "success", matchesToRemove: 2,
    matchCount: 16, eventCount: 18, messageCount: 42, competitionIds: ["2", "3", "5", "6", "9", "11", "13"],
  });
  assert.equal(inspected, 18);
  assert.deepEqual(fake.writes, { append: 0, clear: 0 });
});

test("apply creates the exact dataset and is idempotent", async (t) => {
  const fake = fakeSheets();
  const repos = repositories();
  t.after(repos.close);

  const first = await applySeed({ sheets: fake.sheets, sheetId: "sheet", messagingRepository: repos.messaging, auditRepository: repos.audit, auditId: "test-history-audit-apply-1" });
  assert.equal(first.matchesInserted, 16);
  assert.equal(first.eventsInserted, 18);
  assert.equal(first.messageCount, 42);
  assert.equal(fake.writes.append, 1);
  const rows = matchObjects(fake.tables.Matches1).filter((row) => row.ID.startsWith("test-history-"));
  assert.deepEqual(rows.map(({ ID }) => ID), MATCHES.map(({ ID }) => ID));
  assert.ok(rows.every(({ Ignore }) => Ignore === "1"));
  assert.equal(EVENTS.filter(({ event }) => repos.messaging.getEvent(event.id)).length, 18);
  assert.deepEqual(Object.keys(PEOPLE).map((id) => repos.messaging.summary(id).totalCount), [5, 6, 5, 6, 5, 5, 5, 5]);
  assert.match(repos.messaging.getForRecipient("47", "test-history-message-01-47").body, /Alfred Pimminger \(5\)/);
  assert.match(repos.messaging.getForRecipient("81", "test-history-message-01-81").body, /Christian Kerl \(7\)/);
  assert.match(repos.messaging.getForRecipient("81", "test-history-message-15-81").body, /gewonnen/);
  assert.match(repos.messaging.getForRecipient("47", "test-history-message-15-47").body, /verloren/);

  const second = await applySeed({ sheets: fake.sheets, sheetId: "sheet", messagingRepository: repos.messaging, auditRepository: repos.audit, auditId: "test-history-audit-apply-2" });
  assert.equal(second.matchesInserted, 0);
  assert.equal(second.eventsInserted, 0);
  assert.equal(fake.writes.append, 1);
  assert.equal(repos.messaging.status().eventCount, 18);
  assert.deepEqual(repos.audit.list().map(({ action, result }) => ({ action, result })), [
    { action: "historyTestSeedApply", result: "success" },
    { action: "historyTestSeedApply", result: "success" },
  ]);
});

test("cleanup removes only exact current seed data and preserves nonseed messaging, match, and ranking state", async (t) => {
  const fake = fakeSheets();
  const repos = repositories();
  t.after(repos.close);
  seedNonTestMessaging(repos.messaging);
  await applySeed({ sheets: fake.sheets, sheetId: "sheet", messagingRepository: repos.messaging, auditRepository: repos.audit, auditId: "test-history-audit-apply-clean" });
  const rankingBefore = clone(fake.tables["RL-Platzierung"]);

  const result = await cleanupSeed({ sheets: fake.sheets, sheetId: "sheet", messagingRepository: repos.messaging, auditRepository: repos.audit, auditId: "test-history-audit-cleanup-1" });
  assert.equal(result.matchesRemoved, 16);
  assert.equal(result.eventsRemoved, 18);
  assert.deepEqual(fake.tables["RL-Platzierung"], rankingBefore);
  assert.deepEqual(matchObjects(fake.tables.Matches1).map(({ ID }) => ID), ["real-match"]);
  assert.equal(repos.messaging.status().eventCount, 1);
  assert.equal(repos.messaging.getEvent("real-event").summary, "Echte Nachricht.");
  assert.equal(repos.messaging.db.prepare("SELECT COUNT(*) AS count FROM event_ack_operations").get().count, 1);

  const repeated = await cleanupSeed({ sheets: fake.sheets, sheetId: "sheet", messagingRepository: repos.messaging, auditRepository: repos.audit, auditId: "test-history-audit-cleanup-2" });
  assert.equal(repeated.matchesRemoved, 0);
  assert.equal(repeated.eventsRemoved, 0);
  assert.equal(fake.writes.clear, 16);
});

test("replace-all removes old and new exact rows, purges all messaging state, and preserves real sheet and ranking rows", async (t) => {
  const tables = baseTables();
  insertMatchRow(tables.Matches1, MATCHES[0], "alter neuer Seed");
  insertMatchRow(tables.Matches1, { ...MATCHES[1], ID: "test-history-match-03-appointment" }, "alter Seed");
  const fake = fakeSheets(tables);
  const repos = repositories();
  t.after(repos.close);
  seedNonTestMessaging(repos.messaging);
  repos.messaging.db.prepare("INSERT INTO messaging_revisions(user_id, revision) VALUES ('orphan', 9)").run();
  const rankingBefore = clone(fake.tables["RL-Platzierung"]);

  const result = await replaceAll({ sheets: fake.sheets, sheetId: "sheet", messagingRepository: repos.messaging, auditRepository: repos.audit, auditId: "test-history-audit-replace-1" });
  assert.equal(result.matchesRemoved, 2);
  assert.equal(result.matchesInserted, 16);
  assert.equal(result.eventCount, 18);
  assert.equal(result.messageCount, 42);
  assert.deepEqual(fake.tables["RL-Platzierung"], rankingBefore);
  const rows = matchObjects(fake.tables.Matches1);
  assert.equal(rows.find(({ ID }) => ID === "real-match").Bemerkung, "nicht löschen");
  assert.deepEqual(rows.filter(({ ID }) => ID.startsWith("test-history-")).map(({ ID }) => ID), MATCHES.map(({ ID }) => ID));
  assert.equal(repos.messaging.getEvent("real-event"), null);
  assert.equal(repos.messaging.db.prepare("SELECT COUNT(*) AS count FROM event_ack_operations").get().count, 0);
  assert.equal(repos.messaging.db.prepare("SELECT COUNT(*) AS count FROM messaging_revisions WHERE user_id IN ('999', 'orphan')").get().count, 0);
  assert.equal(repos.messaging.db.prepare("SELECT COUNT(*) AS count FROM competition_events").get().count, 18);
  assert.equal(repos.messaging.db.prepare("SELECT COUNT(*) AS count FROM event_participants").get().count, 42);
  assert.equal(repos.audit.get("test-history-audit-replace-1").result, "success");

  const repeated = await replaceAll({ sheets: fake.sheets, sheetId: "sheet", messagingRepository: repos.messaging, auditRepository: repos.audit, auditId: "test-history-audit-replace-2" });
  assert.equal(repeated.matchesRemoved, 16);
  assert.equal(repeated.matchesInserted, 16);
  assert.equal(repos.messaging.db.prepare("SELECT COUNT(*) AS count FROM competition_events").get().count, 18);
  assert.equal(repos.messaging.db.prepare("SELECT COUNT(*) AS count FROM event_participants").get().count, 42);
  assert.deepEqual(matchObjects(fake.tables.Matches1).filter(({ ID }) => ID.startsWith("test-history-")).map(({ ID }) => ID), MATCHES.map(({ ID }) => ID));
});

test("replace-all recovery rolls back messaging, cleans uncertain test rows, and audits unknown", async (t) => {
  const fake = fakeSheets();
  const append = fake.sheets.spreadsheets.values.append;
  fake.sheets.spreadsheets.values.append = async (request) => {
    await append(request);
    const error = new Error("connection lost after write");
    error.code = "SHEET_WRITE_UNKNOWN";
    throw error;
  };
  const repos = repositories();
  t.after(repos.close);
  seedNonTestMessaging(repos.messaging);

  await assert.rejects(replaceAll({ sheets: fake.sheets, sheetId: "sheet", messagingRepository: repos.messaging, auditRepository: repos.audit, auditId: "test-history-audit-replace-unknown" }), { code: "HISTORY_TEST_SEED_REPLACE_ALL_FAILED" });
  assert.deepEqual(matchObjects(fake.tables.Matches1).map(({ ID }) => ID), ["real-match"]);
  assert.equal(repos.messaging.getEvent("real-event").summary, "Echte Nachricht.");
  assert.equal(repos.messaging.status().eventCount, 1);
  assert.equal(repos.messaging.db.prepare("SELECT COUNT(*) AS count FROM event_ack_operations").get().count, 1);
  assert.equal(repos.audit.get("test-history-audit-replace-unknown").result, "unknown");
});

test("all identity, competition type, and active rank mismatches fail closed before writes", async (t) => {
  const mutations = [
    (tables) => { tables.Personen[1][0] = "Falsch"; },
    (tables) => { tables.Bewerb.find((row) => row[2] === "6")[1] = "1"; },
    (tables) => { tables["RL-Platzierung"].find((row) => row[1] === "47")[0] = "6"; },
    (tables) => { tables["RL-Platzierung"].find((row) => row[1] === "30")[0] = "1"; },
  ];
  for (const mutate of mutations) {
    const tables = baseTables();
    mutate(tables);
    const fake = fakeSheets(tables);
    const repos = repositories();
    t.after(repos.close);
    await assert.rejects(applySeed({ sheets: fake.sheets, sheetId: "sheet", messagingRepository: repos.messaging, auditRepository: repos.audit, auditId: cryptoId(mutations.indexOf(mutate)) }));
    assert.deepEqual(fake.writes, { append: 0, clear: 0 });
    assert.equal(repos.messaging.status().eventCount, 0);
    assert.equal(repos.audit.status().count, 0);
  }
});

function cryptoId(index) {
  return `test-history-audit-mismatch-${index}`;
}

test("a conflicting current seed row fails closed, while replace-all deliberately replaces it", async (t) => {
  const fake = fakeSheets();
  const repos = repositories();
  t.after(repos.close);
  insertMatchRow(fake.tables.Matches1, { ...MATCHES[0], Spieler3ID: "109" });

  await assert.rejects(applySeed({ sheets: fake.sheets, sheetId: "sheet", messagingRepository: repos.messaging, auditRepository: repos.audit, auditId: "test-history-audit-conflict" }), { code: "MATCH_ID_CONFLICT" });
  assert.deepEqual(fake.writes, { append: 0, clear: 0 });
  const result = await replaceAll({ sheets: fake.sheets, sheetId: "sheet", messagingRepository: repos.messaging, auditRepository: repos.audit, auditId: "test-history-audit-conflict-replace" });
  assert.equal(result.matchesRemoved, 1);
  assert.deepEqual(matchObjects(fake.tables.Matches1).filter(({ ID }) => ID === MATCHES[0].ID).map(({ Spieler3ID }) => Spieler3ID), ["81"]);
});

test("a partial apply append is detected before SQLite and exact appended rows are cleaned", async (t) => {
  const fake = fakeSheets();
  const originalAppend = fake.sheets.spreadsheets.values.append;
  fake.sheets.spreadsheets.values.append = async ({ requestBody, ...request }) => originalAppend({ ...request, requestBody: { values: requestBody.values.slice(0, 2) } });
  const repos = repositories();
  t.after(repos.close);

  await assert.rejects(applySeed({ sheets: fake.sheets, sheetId: "sheet", messagingRepository: repos.messaging, auditRepository: repos.audit, auditId: "test-history-audit-partial" }), { code: "HISTORY_TEST_SEED_APPLY_FAILED" });
  assert.equal(matchObjects(fake.tables.Matches1).filter(({ ID }) => ID.startsWith("test-history-")).length, 0);
  assert.equal(fake.writes.clear, 2);
  assert.equal(repos.messaging.status().eventCount, 0);
  assert.equal(repos.audit.get("test-history-audit-partial").result, "failed");
});

test("dry-run read-only inspector rejects an existing SQLite event conflict", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epiber-history-seed-"));
  const filename = path.join(directory, "messaging.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new MessagingRepository(filename);
  repository.init();
  repository.ensureEvent({ ...EVENTS[0].event, actorId: "109" }, EVENTS[0].participants);
  repository.close();
  const filesBefore = fs.readdirSync(directory).sort();
  const modifiedBefore = fs.statSync(filename).mtimeMs;
  const fake = fakeSheets();

  await assert.rejects(dryRun({ sheets: fake.sheets, sheetId: "sheet", eventInspector: (events) => inspectEventsReadOnly(filename, events) }), { code: "EVENT_ID_CONFLICT" });
  assert.deepEqual(fake.writes, { append: 0, clear: 0 });
  assert.deepEqual(fs.readdirSync(directory).sort(), filesBefore);
  assert.equal(fs.statSync(filename).mtimeMs, modifiedBefore);
});
