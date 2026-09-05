const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { MessagingRepository } = require("../messagingRepository.js");

function message(id = "msg-1", recipientId = "p2") {
  return {
    id,
    recipientId,
    createdAt: 1000,
    subject: "Private subject",
    body: "Private body",
    type: "challenge",
    source: "match",
    sourceId: `source-${id}`,
    actorId: "p1",
  };
}

test("MessagingRepository persistiert Nachrichten, Status und explizit idempotente Bestaetigungen", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epiber-messaging-"));
  const filename = path.join(directory, "messaging.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 1000;
  let repository = new MessagingRepository(filename, { now: () => now });
  repository.init();
  const first = repository.ensureMessage(message(), [
    { channel: "Inbox", status: "delivered" },
    { channel: "Email", status: "not_configured" },
  ]);
  assert.equal(first.inserted, true);
  assert.equal(first.message.actorName, "");
  assert.deepEqual(repository.summary("p2"), { revision: 1, totalCount: 1, unreadCount: 1 });
  assert.equal(repository.getForRecipient("p1", "msg-1"), null);
  assert.deepEqual(first.message.deliveries.map(({ channel, status }) => ({ channel, status })), [
    { channel: "Email", status: "not_configured" },
    { channel: "Inbox", status: "delivered" },
  ]);
  now = 2000;
  const acknowledged = repository.acknowledge("p2", "00000000-0000-4000-8000-000000000001", "msg-1");
  const repeated = repository.acknowledge("p2", "00000000-0000-4000-8000-000000000001", "msg-1");
  assert.equal(acknowledged.changed, true);
  assert.equal(repeated.repeated, true);
  assert.deepEqual(repository.summary("p2"), { revision: 2, totalCount: 1, unreadCount: 0 });
  assert.throws(() => repository.acknowledge("p2", "00000000-0000-4000-8000-000000000001", "other"), { code: "OPERATION_ID_CONFLICT" });
  assert.throws(() => repository.acknowledge("p1", "00000000-0000-4000-8000-000000000002", "msg-1"), { code: "MESSAGE_NOT_FOUND" });
  repository.close();

  repository = new MessagingRepository(filename);
  repository.init();
  assert.equal(repository.getForRecipient("p2", "msg-1").acknowledgedAt, 2000);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  repository.close();
});

test("MessagingRepository paginiert stabil und begrenzt Cursor auf den Empfaenger", () => {
  const repository = new MessagingRepository(":memory:");
  repository.init();
  for (let index = 1; index <= 3; index++) repository.ensureMessage({ ...message(`msg-${index}`), createdAt: index }, [{ channel: "Inbox", status: "delivered" }]);
  repository.ensureMessage(message("foreign", "p3"), [{ channel: "Inbox", status: "delivered" }]);
  const first = repository.listForRecipient("p2", { limit: 2 });
  assert.deepEqual(first.messages.map((entry) => entry.id), ["msg-3", "msg-2"]);
  assert.equal(first.nextCursor, "msg-2");
  assert.deepEqual(repository.listForRecipient("p2", { cursor: first.nextCursor, limit: 2 }).messages.map((entry) => entry.id), ["msg-1"]);
  assert.throws(() => repository.listForRecipient("p2", { cursor: "foreign" }), { code: "MESSAGE_CURSOR_INVALID" });
  repository.close();
});

test("MessagingRepository sortiert ungelesene vor gelesenen und jeweils neueste zuerst", () => {
  let now = 10;
  const repository = new MessagingRepository(":memory:", { now: () => now });
  repository.init();
  for (let index = 1; index <= 4; index++) {
    repository.ensureMessage({ ...message(`msg-${index}`), createdAt: index }, [{ channel: "Inbox", status: "delivered" }]);
  }
  repository.acknowledge("p2", "00000000-0000-4000-8000-000000000011", "msg-4");
  now++;
  repository.acknowledge("p2", "00000000-0000-4000-8000-000000000012", "msg-2");
  const first = repository.listForRecipient("p2", { limit: 2 });
  assert.deepEqual(first.messages.map(({ id }) => id), ["msg-3", "msg-1"]);
  assert.equal(first.nextCursor, "msg-1");
  assert.deepEqual(repository.listForRecipient("p2", { cursor: first.nextCursor, limit: 2 }).messages.map(({ id }) => id), ["msg-4", "msg-2"]);
  repository.close();
});

test("MessagingRepository migriert v1, gruppiert nur exakte Matchquellen und reichert ohne Textauswertung an", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epiber-messaging-v1-"));
  const filename = path.join(directory, "messaging.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE messages (message_id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, created_at INTEGER NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, type TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL, actor_id TEXT NOT NULL, acknowledged_at INTEGER, inserted_at INTEGER NOT NULL);
    CREATE TABLE message_deliveries (message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE, channel TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(message_id, channel));
    CREATE TABLE message_acknowledgments (recipient_id TEXT NOT NULL, operation_id TEXT NOT NULL, message_id TEXT NOT NULL, acknowledged_at INTEGER NOT NULL, PRIMARY KEY(recipient_id, operation_id));
    CREATE TABLE messaging_revisions (recipient_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    PRAGMA user_version = 1;
  `);
  const insert = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("legacy-opponent", "p2", 10, "arbitrary", "not parsed", "challenge", "match", "m-exact", "p1", null, 10);
  insert.run("legacy-challenger", "p1", 10, "different arbitrary", "still not parsed", "challenge_confirmation", "match", "m-exact", "p1", 20, 10);
  insert.run("legacy-personal", "p3", 11, "mentions m-exact", "competition words", "notice", "personal", "personal-1", "system", null, 11);
  db.exec("INSERT INTO message_deliveries VALUES ('legacy-opponent', 'Inbox', 'delivered', 10); INSERT INTO message_deliveries VALUES ('legacy-challenger', 'Inbox', 'delivered', 10); INSERT INTO message_deliveries VALUES ('legacy-personal', 'Inbox', 'delivered', 11); INSERT INTO messaging_revisions VALUES ('p1', 1), ('p2', 1), ('p3', 1)");
  db.close();

  const repository = new MessagingRepository(filename);
  repository.init();
  assert.equal(repository.status().schemaVersion, 6);
  assert.equal(repository.status().eventCount, 2);
  const migratedEventId = repository.getForRecipient("p1", "legacy-challenger").eventId;
  assert.equal(migratedEventId, repository.getForRecipient("p2", "legacy-opponent").eventId);
  assert.equal(migratedEventId, `evt-${crypto.createHash("sha256").update("challenge:m-exact").digest("hex").slice(0, 32)}`);
  assert.deepEqual(repository.competitionHistory("cup-1"), []);
  assert.deepEqual(repository.enrichCompetitionByMatchId("m-exact", "cup-1"), { matched: 1 });
  const history = repository.competitionHistory("cup-1");
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].participants.map(({ recipient }) => recipient), ["p1", "p2"]);
  assert.equal(repository.getForRecipient("p3", "legacy-personal").competitionId, null);
  assert.deepEqual(repository.enrichCompetitionByMatchId("m-missing", "cup-1"), { matched: 0 });
  repository.close();
});

test("MessagingRepository speichert Ereignisse mit einem oder vier Teilnehmern atomar", () => {
  const repository = new MessagingRepository(":memory:");
  repository.init();
  const event = (id, competitionId = "cup") => ({ id, competitionId, createdAt: 10, type: "test", source: "test", sourceId: id, actorId: "system", result: id === "four" ? "6-4/6-3" : "" });
  const participant = (index) => ({ userId: `p${index}`, role: `role${index}`, messageId: `message-${index}`, type: "test", subject: `S${index}`, body: `B${index}`, deliveries: [{ channel: "Inbox", status: "delivered" }] });
  assert.equal(repository.ensureEvent(event("one"), [participant(1)]).event.participants.length, 1);
  const four = [2, 3, 4, 5].map(participant);
  assert.equal(repository.ensureEvent(event("four"), four).event.participants.length, 4);
  assert.equal(repository.getEvent("four").result, "6-4/6-3");
  assert.deepEqual(four.map(({ userId }) => repository.summary(userId).totalCount), [1, 1, 1, 1]);
  assert.throws(() => repository.ensureEvent(event("rollback"), [{ ...participant(6), deliveries: [{ channel: "Inbox", status: "invalid" }] }]), /CHECK constraint failed/);
  assert.equal(repository.getEvent("rollback"), null);
  assert.equal(repository.competitionHistory("cup").length, 2);
  const firstPage = repository.pageCompetitionHistory("cup", { limit: 1 });
  assert.equal(firstPage.events.length, 1);
  assert.ok(firstPage.nextCursor);
  const secondPage = repository.pageCompetitionHistory("cup", { cursor: firstPage.nextCursor, limit: 1 });
  assert.equal(secondPage.events.length, 1);
  assert.equal(secondPage.nextCursor, null);
  repository.ensureEvent(event("foreign", "other"), [{ ...participant(7), messageId: "foreign-message" }]);
  assert.throws(() => repository.pageCompetitionHistory("cup", { cursor: "foreign" }), { code: "COMPETITION_HISTORY_CURSOR_INVALID" });
  const globalFirstPage = repository.pageCompetitionHistory(null, { limit: 2 });
  assert.deepEqual(globalFirstPage.events.map(({ competitionId }) => competitionId), ["cup", "cup"]);
  assert.ok(globalFirstPage.nextCursor);
  assert.deepEqual(repository.pageCompetitionHistory(null, { cursor: globalFirstPage.nextCursor, limit: 2 }).events.map(({ competitionId }) => competitionId), ["other"]);
  assert.throws(() => repository.pageCompetitionHistory(null, { cursor: firstPage.nextCursor }), { code: "COMPETITION_HISTORY_CURSOR_INVALID" });
  assert.throws(() => repository.pageCompetitionHistory("cup", { cursor: globalFirstPage.nextCursor }), { code: "COMPETITION_HISTORY_CURSOR_INVALID" });
  const partialEvent = { ...event("partial"), type: "challenge", source: "match", sourceId: "partial", actorId: "p8", summary: "Original" };
  const partial = { ...participant(8), role: "challenger", messageId: "partial-8" };
  repository.ensureEvent(partialEvent, [partial]);
  const completed = repository.ensureEvent({ ...partialEvent, summary: "Geaenderter Text" }, [
    { ...partial, subject: "Geaendert", body: "Geaendert" },
    { ...participant(9), role: "opponent", messageId: "partial-9" },
  ]);
  assert.equal(completed.inserted, true);
  assert.equal(completed.event.participants.length, 2);
  assert.equal(completed.event.summary, "Original");
  assert.equal(completed.event.participants.find(({ recipient }) => recipient === "p8").subject, partial.subject);
  repository.close();
});

test("MessagingRepository migriert Schema 3 additiv auf das Ergebnisfeld", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epiber-messaging-v3-"));
  const filename = path.join(directory, "messaging.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let repository = new MessagingRepository(filename);
  repository.init();
  repository.ensureMessage(message("before-v4"), [{ channel: "Inbox", status: "delivered" }]);
  repository.close();
  const db = new DatabaseSync(filename);
  db.exec("ALTER TABLE competition_events DROP COLUMN result; PRAGMA user_version = 3;");
  db.close();

  repository = new MessagingRepository(filename);
  repository.init();
  assert.equal(repository.status().schemaVersion, 6);
  assert.equal(repository.getForRecipient("p2", "before-v4").subject, "Private subject");
  assert.equal(repository.getEvent("before-v4").result, "");
  repository.close();
});

test("MessagingRepository liefert zeitbegrenzte persoenliche Reportingprojektionen ohne Join-Vervielfachung", () => {
  const repository = new MessagingRepository(":memory:");
  repository.init();
  repository.ensureEvent({
    id: "event-report",
    competitionId: "cup",
    createdAt: 1000,
    type: "challenge",
    source: "match",
    sourceId: "match-report",
    actorId: "p1",
    actorName: "Ada Admin",
    summary: "Forderung",
    detail: "Privates Ereignisdetail",
    result: "",
  }, [{
    userId: "p2",
    role: "opponent",
    displayName: "Peter Player",
    messageId: "message-report",
    type: "challenge",
    subject: "Private subject",
    body: "Private body",
    deliveries: [{ channel: "Inbox", status: "delivered" }, { channel: "Email", status: "not_configured" }],
  }]);
  assert.deepEqual(repository.reportProjections(1001, 2000), []);
  const rows = repository.reportProjections(1000, 2000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, "Private subject");
  assert.equal(rows[0].detail, "Privates Ereignisdetail");
  assert.deepEqual(rows[0].deliveries.map(({ channel, status }) => ({ channel, status })), [
    { channel: "Email", status: "not_configured" },
    { channel: "Inbox", status: "delivered" },
  ]);
  assert.equal(repository.db.prepare("PRAGMA index_list('competition_events')").all().some(({ name }) => name === "competition_events_created"), true);
  repository.close();
});

test("MessagingRepository migriert Schema 4 mit Datenbestand auf den globalen Zeitindex", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epiber-messaging-v4-"));
  const filename = path.join(directory, "messaging.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let repository = new MessagingRepository(filename);
  repository.init();
  repository.ensureMessage(message("before-v5"), [{ channel: "Inbox", status: "delivered" }]);
  repository.close();
  const db = new DatabaseSync(filename);
  db.exec("DROP INDEX competition_events_created; PRAGMA user_version = 4;");
  db.close();

  repository = new MessagingRepository(filename);
  repository.init();
  assert.equal(repository.status().schemaVersion, 6);
  assert.equal(repository.getForRecipient("p2", "before-v5").subject, "Private subject");
  assert.equal(repository.db.prepare("PRAGMA index_list('competition_events')").all().some(({ name }) => name === "competition_events_created"), true);
  repository.close();
});

test("MessagingRepository migriert bestehende Walkover- und Aufgabe-Texte", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epiber-messaging-v5-"));
  const filename = path.join(directory, "messaging.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let repository = new MessagingRepository(filename);
  repository.init();
  const oldEvent = (id) => ({ id, competitionId: "cup", createdAt: 10, type: "result", source: "match", sourceId: id, actorId: "p1" });
  const oldParticipant = (index) => ({ userId: `p${index}`, role: "participant", messageId: `message-${index}`, type: "result", subject: "Ergebnis", body: "", deliveries: [{ channel: "Inbox", status: "delivered" }] });
  repository.ensureEvent({
    ...oldEvent("walkover-old"), detail: "Abschlussart: walkover", result: "",
  }, [{ ...oldParticipant(1), messageId: "walkover-old-message", body: "Du gewinnst das Match gegen Peter Player. Abschlussart: Walkover." }]);
  repository.ensureEvent({
    ...oldEvent("retirement-old"), type: "result_corrected", detail: "Abschlussart: retirement; Ergebnis: 6-4/2-1; Grund: Korrektur", result: "6-4/2-1",
  }, [{ ...oldParticipant(2), messageId: "retirement-old-message", body: "Du verlierst das Match gegen Ada Aufschlag. Ergebnis: 6-4/2-1. Grund: Korrektur" }]);
  repository.ensureEvent({
    ...oldEvent("retirement-empty-old"), detail: "Abschlussart: retirement", result: "",
  }, [{ ...oldParticipant(3), messageId: "retirement-empty-old-message", body: "Du gewinnst das Match gegen Peter Player. Abschlussart: Aufgabe." }]);
  repository.close();
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA user_version = 5;");
  db.close();

  repository = new MessagingRepository(filename);
  repository.init();
  assert.equal(repository.status().schemaVersion, 6);
  assert.equal(repository.getForRecipient("p1", "walkover-old-message").body, "Du gewinnst das Match gegen Peter Player durch Walkover.");
  assert.equal(repository.getEvent("walkover-old").result, "Walkover");
  assert.equal(repository.getEvent("walkover-old").detail, "Ergebnis: Walkover");
  assert.equal(repository.getForRecipient("p2", "retirement-old-message").body, "Du verlierst das Match gegen Ada Aufschlag. Ergebnis: 6-4/2-1 (Aufgabe). Grund: Korrektur");
  assert.equal(repository.getEvent("retirement-old").result, "6-4/2-1 (Aufgabe)");
  assert.equal(repository.getEvent("retirement-old").detail, "Ergebnis: 6-4/2-1 (Aufgabe); Grund: Korrektur");
  assert.equal(repository.getForRecipient("p3", "retirement-empty-old-message").body, "Du gewinnst das Match gegen Peter Player. Ergebnis: (Aufgabe).");
  assert.equal(repository.getEvent("retirement-empty-old").result, "(Aufgabe)");
  repository.close();
});
