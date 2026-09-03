const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const dataStore = require("../dataStore.js");
const { MessagingRepository } = require("../messagingRepository.js");
const { MessagingService, competitionRoundName, notificationChannels } = require("../messagingService.js");
const { EmailMessagingAdapter } = require("../emailMessagingAdapter.js");
const { WhatsappMessagingAdapter } = require("../whatsappMessagingAdapter.js");

test("Notification akzeptiert nur exakte externe Kanaele und loggt ungueltige Werte ohne Kontaktwert", () => {
  const warnings = [];
  assert.deepEqual(notificationChannels("Email|Whatsapp"), ["Email", "Whatsapp"]);
  assert.deepEqual(notificationChannels("Email |Whatsapp", { personId: "p2", rowNumber: 3, log: (level, event, fields) => warnings.push({ level, event, fields }) }), []);
  assert.deepEqual(warnings, [{
    level: "warn",
    event: "player_notification_channels_invalid",
    fields: { personId: "p2", rowNumber: 3, reason: "INVALID_NOTIFICATION_CHANNELS" },
  }]);
  assert.equal(JSON.stringify(warnings).includes("Email |Whatsapp"), false);
});

test("Bewerbsrunden werden ohne Paarungsnummer kontrolliert bezeichnet", () => {
  assert.deepEqual(["R1-P3", "AF-P3", "VF-P2", "HF-P1", "F", "G1", "g2", "unbekannt"].map(competitionRoundName), [
    "1. Runde", "Achtelfinale", "Viertelfinale", "Halbfinale", "Finale", "1. Gruppe", "2. Gruppe", "",
  ]);
});

test("Challenge-Nachricht ist deterministisch, publiziert nur Summary und Dummies behaupten keine Zustellung", async () => {
  dataStore.resetForTests();
  dataStore.set("players", [
    ["ID", "Notification", "E-Mail", "TelefonMobil"],
    ["p1", "Email|Whatsapp", "challenger@example.test", "+439876"],
    ["p2", "Email|Whatsapp", "private@example.test", "+431234"],
  ], { source: "test" });
  const repository = new MessagingRepository(":memory:");
  repository.init();
  const events = [];
  const service = new MessagingService({
    repository,
    emailAdapter: new EmailMessagingAdapter(),
    whatsappAdapter: new WhatsappMessagingAdapter(),
    publish: (topic, data) => events.push({ topic, data }),
    now: () => 1000,
  });
  const input = { matchId: "m-1", recipientId: "p2", competitionName: "Herren", challengerId: "p1", challengerName: "Ada Admin" };
  const first = await service.ensureChallengeMessage(input);
  const repeated = await service.ensureChallengeMessage(input);
  assert.equal(first.id, repeated.id);
  assert.equal(first.subject, "Neue Forderung in Herren");
  assert.match(first.body, /Ada Admin/);
  assert.match(first.body, /Bitte vereinbart einen Spieltermin in den kommenden sieben Tagen\./);
  assert.deepEqual(first.deliveries.map(({ channel, status }) => ({ channel, status })), [
    { channel: "Email", status: "not_configured" },
    { channel: "Inbox", status: "delivered" },
    { channel: "Whatsapp", status: "not_configured" },
  ]);
  assert.deepEqual(events, [{ topic: "messages:p2", data: { revision: 1, unreadCount: 1 } }]);
  assert.equal(JSON.stringify(events).includes("Neue Forderung"), false);
  repository.close();
});

test("Forderung erzeugt fuer Gegner und Forderer getrennte Meldungen samt externem Routing", async () => {
  dataStore.resetForTests();
  dataStore.set("players", [
    ["ID", "Notification"],
    ["p1", "Email|Whatsapp"],
    ["p2", "Email|Whatsapp"],
  ], { source: "test" });
  const repository = new MessagingRepository(":memory:");
  repository.init();
  const sends = [];
  const adapter = (channel) => ({
    async send({ messageId, recipientId }) {
      sends.push({ channel, messageId, recipientId });
      return { status: "not_configured" };
    },
  });
  const events = [];
  const service = new MessagingService({
    repository,
    emailAdapter: adapter("Email"),
    whatsappAdapter: adapter("Whatsapp"),
    publish: (topic, data) => events.push({ topic, data }),
    now: () => 1000,
  });
  const input = {
    matchId: "m-both",
    competitionId: "competition-1",
    recipientId: "p2",
    competitionName: "Herren",
    challengerId: "p1",
    challengerName: "Ada Admin",
    challengerRank: 4,
    opponentId: "p2",
    opponentName: "Peter Player",
    opponentRank: 2,
  };
  const first = await service.ensureChallengeMessages(input);
  const repeated = await service.ensureChallengeMessages(input);
  const renamed = await service.ensureChallengeMessages({ ...input, competitionName: "Herren neu", challengerName: "Ada Neu", opponentName: "Peter Neu" });

  assert.equal(first.recipient.id, repeated.recipient.id);
  assert.equal(first.challenger.id, repeated.challenger.id);
  assert.notEqual(first.recipient.id, first.challenger.id);
  assert.equal(first.event.participants.length, 2);
  assert.equal(first.recipient.eventId, first.challenger.eventId);
  assert.equal(first.event.competitionId, "competition-1");
  assert.equal(first.event.summary, "Ada Admin (4) hat Peter Player (2) gefordert.");
  assert.equal(renamed.event.summary, first.event.summary);
  assert.equal(first.challenger.subject, "Forderung ausgesprochen in Herren");
  assert.equal(first.challenger.body, "Du hast Peter Player in Herren gefordert. Bitte vereinbart einen Spieltermin in den kommenden sieben Tagen.");
  assert.deepEqual(repository.summary("p1"), { revision: 1, totalCount: 1, unreadCount: 1 });
  assert.deepEqual(repository.summary("p2"), { revision: 1, totalCount: 1, unreadCount: 1 });
  assert.deepEqual(sends.map(({ channel, recipientId }) => ({ channel, recipientId })), [
    { channel: "Email", recipientId: "p1" },
    { channel: "Whatsapp", recipientId: "p1" },
    { channel: "Email", recipientId: "p2" },
    { channel: "Whatsapp", recipientId: "p2" },
  ]);
  assert.deepEqual(events, [
    { topic: "messages:p2", data: { revision: 1, unreadCount: 1 } },
    { topic: "messages:p1", data: { revision: 1, unreadCount: 1 } },
  ]);
  repository.close();
});

test("Spieltermin erzeugt ein gemeinsames Bewerbsereignis und zwei persoenliche Meldungen mit Akteur", async () => {
  dataStore.resetForTests();
  dataStore.set("players", [["ID", "Notification"], ["p1", ""], ["p2", ""]], { source: "test" });
  dataStore.set("bewerbe", [["ID", "Bezeichnung", "BewerbsartID"], ["ranking-1", "Herren", "2"]], { source: "test" });
  dataStore.set("matches1", [["ID", "BewerbID", "BewerbRunde"], ["m-appointment", "ranking-1", "R1"]], { source: "test" });
  const repository = new MessagingRepository(":memory:");
  repository.init();
  const published = [];
  const service = new MessagingService({
    repository,
    emailAdapter: new EmailMessagingAdapter(),
    whatsappAdapter: new WhatsappMessagingAdapter(),
    publish: (topic, data) => published.push({ topic, data }),
    now: () => 2000,
  });
  const input = {
    operationId: "00000000-0000-4000-8000-000000000301",
    matchId: "m-appointment",
    matchDate: "260905-1800",
    competitionId: "ranking-1",
    competitionName: "Herren",
    challengerId: "p1",
    challengerName: "Ada Admin",
    opponentId: "p2",
    opponentName: "Peter Player",
    actorId: "p2",
    actorName: "Peter Player",
  };

  const first = await service.ensureMatchAppointmentEvent(input);
  const repeated = await service.ensureMatchAppointmentEvent(input);
  assert.equal(first.event.id, repeated.event.id);
  assert.equal(first.event.summary, "Ada Admin und Peter Player haben den Spieltermin für den 05.09.2026, 18:00 Uhr vereinbart.");
  assert.equal(first.event.detail, "Spieltermin: 05.09.2026, 18:00 Uhr");
  assert.equal(first.event.actorName, "Peter Player");
  assert.deepEqual(service.competitionHistory({ id: "p1" }, { bewerbId: "ranking-1" }).entries[0], {
    id: first.event.id,
    competitionId: "ranking-1",
    competitionName: "Herren",
    roundName: "",
    type: "appointment",
    occurredAt: 2000,
    summary: "Ada Admin und Peter Player haben den Spieltermin für den 05.09.2026, 18:00 Uhr vereinbart.",
    detail: "Spieltermin: 05.09.2026, 18:00 Uhr",
    result: "",
    actorName: "Peter Player",
    participants: [{ role: "challenger", name: "Ada Admin" }, { role: "opponent", name: "Peter Player" }],
  });
  assert.equal(service.messages({ id: "p1" }, { limit: 10 }).messages[0].subject, "Spieltermin festgelegt mit Peter Player");
  assert.equal(service.message({ id: "p1" }, first.participants.find(({ recipient }) => recipient === "p1").id).message.body, "Dein Match gegen Peter Player ist für den 05.09.2026, 18:00 Uhr geplant.");
  const changed = await service.ensureMatchAppointmentEvent({
    ...input,
    operationId: "00000000-0000-4000-8000-000000000302",
    previousDate: input.matchDate,
    matchDate: "260910-1900",
    actorId: "p1",
    actorName: "Ada Admin",
  });
  assert.equal(changed.event.type, "appointment_changed");
  assert.equal(changed.event.summary, "Spieltermin für Ada Admin gegen Peter Player von 05.09.2026, 18:00 Uhr auf 10.09.2026, 19:00 Uhr geändert.");
  assert.equal(changed.event.detail, "Alter Spieltermin: 05.09.2026, 18:00 Uhr; neuer Spieltermin: 10.09.2026, 19:00 Uhr");
  assert.equal(changed.participants[0].subject, "Spieltermin geändert mit Peter Player");
  assert.equal(changed.participants[0].body, "Der Termin für dein Match gegen Peter Player wurde von 05.09.2026, 18:00 Uhr auf 10.09.2026, 19:00 Uhr geändert.");
  assert.deepEqual(published.map(({ topic }) => topic), ["messages:p1", "messages:p2", "messages:p1", "messages:p2"]);
  repository.close();
});

test("wiederholte Sicherstellung versendet externe Kanaele nicht erneut", async () => {
  dataStore.resetForTests();
  dataStore.set("players", [["ID", "Notification"], ["p2", "Email"]], { source: "test" });
  const repository = new MessagingRepository(":memory:");
  repository.init();
  let sends = 0;
  const service = new MessagingService({
    repository,
    emailAdapter: { async send() { sends++; return { status: "not_configured" }; } },
    whatsappAdapter: new WhatsappMessagingAdapter(),
  });
  const input = { matchId: "m-repeat", recipientId: "p2", competitionName: "Herren", challengerId: "p1", challengerName: "Ada Admin" };
  await service.ensureChallengeMessage(input);
  await service.ensureChallengeMessage(input);
  assert.equal(sends, 1);
  repository.close();
});

test("Fehler bei zentraler Ereignispersistenz hinterlaesst keine Teilnehmerprojektion", async () => {
  dataStore.resetForTests();
  dataStore.set("players", [["ID", "Notification"], ["p1", ""], ["p2", ""]], { source: "test" });
  const repository = new MessagingRepository(":memory:");
  repository.init();
  const ensureEvent = repository.ensureEvent.bind(repository);
  let fail = true;
  repository.ensureEvent = (...args) => {
    if (fail) {
      fail = false;
      throw Object.assign(new Error("temporary sqlite failure"), { code: "MESSAGING_WRITE_FAILED" });
    }
    return ensureEvent(...args);
  };
  const service = new MessagingService({
    repository,
    emailAdapter: new EmailMessagingAdapter(),
    whatsappAdapter: new WhatsappMessagingAdapter(),
  });
  const input = {
    matchId: "m-recovery",
    recipientId: "p2",
    competitionName: "Herren",
    challengerId: "p1",
    challengerName: "Ada Admin",
    opponentId: "p2",
    opponentName: "Peter Player",
  };

  await assert.rejects(service.ensureChallengeMessages(input), { code: "MESSAGING_WRITE_FAILED" });
  assert.equal(repository.summary("p2").totalCount, 0);
  assert.equal(repository.summary("p1").totalCount, 0);
  await service.ensureChallengeMessages(input);
  assert.equal(repository.summary("p2").totalCount, 1);
  assert.equal(repository.summary("p1").totalCount, 1);
  repository.close();
});

test("externer Adapterfehler verhindert die persistente Inbox nicht", async () => {
  dataStore.resetForTests();
  dataStore.set("players", [["ID", "Notification"], ["p2", "Email"]], { source: "test" });
  const repository = new MessagingRepository(":memory:");
  repository.init();
  const service = new MessagingService({
    repository,
    emailAdapter: { async send() { assert.equal(repository.summary("p2").unreadCount, 1); throw Object.assign(new Error("provider down"), { code: "PROVIDER_DOWN" }); } },
    whatsappAdapter: new WhatsappMessagingAdapter(),
    log() {},
  });
  const result = await service.ensureChallengeMessage({
    matchId: "m-failed-adapter",
    recipientId: "p2",
    competitionName: "Herren",
    challengerId: "p1",
    challengerName: "Ada Admin",
  });
  assert.deepEqual(result.deliveries.map(({ channel, status }) => ({ channel, status })), [
    { channel: "Email", status: "failed" },
    { channel: "Inbox", status: "delivered" },
  ]);
  assert.equal(repository.summary("p2").unreadCount, 1);
  repository.close();
});

test("persistente pending-Zustellung wird bei der idempotenten Wiederholung fortgesetzt", async () => {
  dataStore.resetForTests();
  dataStore.set("players", [["ID", "Notification"], ["p2", "Email"]], { source: "test" });
  const repository = new MessagingRepository(":memory:");
  repository.init();
  const updateDelivery = repository.updateDelivery.bind(repository);
  let statusWrites = 0;
  repository.updateDelivery = (...args) => {
    statusWrites++;
    if (statusWrites === 1) throw Object.assign(new Error("sqlite unavailable"), { code: "MESSAGING_WRITE_FAILED" });
    return updateDelivery(...args);
  };
  let sends = 0;
  const service = new MessagingService({
    repository,
    emailAdapter: { async send() { sends++; return { status: "not_configured" }; } },
    whatsappAdapter: new WhatsappMessagingAdapter(),
    log() {},
  });
  const input = { matchId: "m-pending", recipientId: "p2", competitionName: "Herren", challengerId: "p1", challengerName: "Ada Admin", createdAt: 1000 };

  assert.equal((await service.ensureChallengeMessage(input)).deliveries.find(({ channel }) => channel === "Email").status, "pending");
  assert.equal((await service.ensureChallengeMessage(input)).deliveries.find(({ channel }) => channel === "Email").status, "not_configured");
  assert.equal(sends, 2);
  repository.close();
});

test("Ranglisten-Rueckzug erzeugt ein zentrales Einteilnehmerereignis und Wettbewerbshistorie", async () => {
  dataStore.resetForTests();
  dataStore.set("players", [["ID", "Notification"], ["p7", ""]], { source: "test" });
  const repository = new MessagingRepository(":memory:");
  repository.init();
  const service = new MessagingService({ repository, now: () => 7000 });
  const first = await service.ensureRankingWithdrawalEvent({ competitionId: "ranking-2", competitionName: "Herren", participantId: "p7", operationId: "00000000-0000-4000-8000-000000000777", reason: "Verletzt" });
  const repeated = await service.ensureRankingWithdrawalEvent({ competitionId: "ranking-2", competitionName: "Herren", participantId: "p7", operationId: "00000000-0000-4000-8000-000000000777", reason: "Verletzt" });
  assert.equal(first.event.id, repeated.event.id);
  assert.equal(first.event.participants.length, 1);
  assert.equal(first.message.type, "ranking_withdrawal");
  assert.equal(first.event.summary, "p7 hat sich aus der Rangliste rausgehängt.");
  assert.equal(first.event.detail, "");
  assert.match(first.message.body, /Grund: Verletzt/);
  assert.equal(first.message.participantRole, "withdrawn");
  assert.equal(repository.summary("p7").totalCount, 1);
  assert.deepEqual(repository.competitionHistory("ranking-2").map(({ type }) => type), ["ranking_withdrawal"]);
  const ack = service.acknowledge({ id: "p7" }, { operationId: "00000000-0000-4000-8000-000000000778", messageId: first.message.id });
  assert.equal(ack.repeated, false);
  assert.equal(service.acknowledge({ id: "p7" }, { operationId: "00000000-0000-4000-8000-000000000778", messageId: first.message.id }).repeated, true);
  assert.equal(repository.summary("p7").unreadCount, 0);
  repository.close();
});

test("Bewerbshistorie projiziert Ergebnis, Akteur und eine globale Bewerbszuordnung kontrolliert", () => {
  dataStore.resetForTests();
  dataStore.set("bewerbe", [["ID", "Bezeichnung", "BewerbsartID"], ["cup-1", "Testcup", "5"], ["cup-2", "Doppelcup", "7"], ["ranking-1", "Rangliste", "2"]], { source: "test" });
  dataStore.set("matches1", [
    ["ID", "BewerbID", "BewerbRunde"],
    ["result-match", "cup-1", "VF-P2"],
    ["other-match", "cup-2", "G1"],
    ["ranking-match", "ranking-1", "R1-P1"],
  ], { source: "test" });
  const repository = new MessagingRepository(":memory:");
  repository.init();
  repository.ensureEvent({
    id: "result-event",
    competitionId: "cup-1",
    createdAt: 9000,
    type: "result",
    source: "match",
    sourceId: "result-match",
    actorId: "p1",
    actorName: "Ada Admin",
    summary: "Ergebnis eingetragen",
    result: "6-4/6-3",
  }, [{
    userId: "p1",
    role: "home",
    displayName: "Ada Admin",
    messageId: "result-message",
    type: "result",
    subject: "Ergebnis eingetragen",
    body: "Das Ergebnis lautet 6-4/6-3.",
    deliveries: [{ channel: "Inbox", status: "delivered" }],
  }]);
  const service = new MessagingService({ repository, log() {} });

  const history = service.competitionHistory({ id: "p1" }, { bewerbId: "cup-1" });
  assert.equal(history.entries[0].result, "6-4/6-3");
  assert.equal(history.entries[0].competitionName, "Testcup");
  assert.equal(history.entries[0].roundName, "Viertelfinale");
  assert.equal(Object.hasOwn(history.entries[0], "body"), false);
  const personalMessage = service.message({ id: "p1" }, "result-message").message;
  assert.equal(personalMessage.actorName, "Ada Admin");
  assert.equal(personalMessage.eventType, "result");
  assert.equal(personalMessage.competitionName, "Testcup");
  assert.deepEqual(service.messages({ id: "p1" }, { limit: 10 }).messages, [{
    id: "result-message",
    createdAt: 9000,
    competitionName: "Testcup",
    roundName: "Viertelfinale",
    subject: "Ergebnis eingetragen",
    actorName: "Ada Admin",
    acknowledgedAt: null,
  }]);

  repository.ensureEvent({
    id: "ranking-event", competitionId: "ranking-1", createdAt: 8000, type: "challenge", source: "match", sourceId: "ranking-match",
    actorId: "p3", actorName: "Chris Challenger", summary: "Forderung eingetragen",
  }, [{
    userId: "p3", role: "challenger", displayName: "Chris Challenger", messageId: "ranking-message", type: "challenge",
    subject: "Forderung eingetragen", body: "Forderung", deliveries: [{ channel: "Inbox", status: "delivered" }],
  }]);
  assert.equal(service.competitionHistory({ id: "p3" }, { bewerbId: "ranking-1" }).entries[0].roundName, "");
  assert.equal(service.messages({ id: "p3" }, { limit: 10 }).messages[0].roundName, "");

  repository.ensureEvent({
    id: "other-event", competitionId: "cup-2", createdAt: 10000, type: "schedule", source: "match", sourceId: "other-match",
    actorId: "p2", actorName: "Peter Player", summary: "Termin eingetragen",
  }, [{
    userId: "p2", role: "home", displayName: "Peter Player", messageId: "other-message", type: "schedule",
    subject: "Termin eingetragen", body: "Termin", deliveries: [{ channel: "Inbox", status: "delivered" }],
  }]);
  const globalHistory = service.competitionHistory({ id: "p1" }, { limit: 1 });
  assert.deepEqual(globalHistory.competition, { id: "", name: "Alle Bewerbe" });
  assert.equal(globalHistory.entries[0].competitionName, "Doppelcup");
  assert.equal(globalHistory.entries[0].roundName, "1. Gruppe");
  assert.ok(globalHistory.nextCursor);
  const globalNextPage = service.competitionHistory({ id: "p1" }, { cursor: globalHistory.nextCursor, limit: 1 });
  assert.equal(globalNextPage.entries[0].competitionName, "Testcup");
  assert.throws(() => service.competitionHistory({ id: "p1" }, { bewerbId: "cup-1", cursor: globalHistory.nextCursor, limit: 1 }), {
    code: "COMPETITION_HISTORY_CURSOR_INVALID",
  });
  repository.close();
});
