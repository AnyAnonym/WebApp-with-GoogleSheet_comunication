const crypto = require("node:crypto");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const SPREADSHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const COMPETITIONS = Object.freeze({
  "2": Object.freeze({ name: "Rangliste Männer", type: "2" }),
  "3": Object.freeze({ name: "Rangliste Frauen", type: "2" }),
  "5": Object.freeze({ name: "VM 2026 Männer A", type: "5" }),
  "6": Object.freeze({ name: "VM 2026 Frauen Vorrunde", type: "7" }),
  "9": Object.freeze({ name: "VM 2026 Mixed Doppel Vorrunde", type: "7" }),
  "11": Object.freeze({ name: "VM 2026 Männer Doppel", type: "3" }),
  "13": Object.freeze({ name: "VM 2026 Frauen Endrunde", type: "8" }),
});
const COMPETITION_IDS = Object.freeze(Object.keys(COMPETITIONS));
const PEOPLE = Object.freeze({
  "3": "Martina Bauer",
  "30": "Christian Hartl",
  "47": "Christian Kerl",
  "55": "Wolfgang Kruiß",
  "65": "Robert Mollner",
  "81": "Alfred Pimminger",
  "82": "Anita Pimminger",
  "109": "Jürgen Steinmayr",
});

const MATCH_FIELDS = Object.freeze([
  "Ignore", "ID", "MatchDate", "ForderungDate", "BewerbID", "BewerbRunde",
  "Spieler1ID", "Spieler2ID", "Spieler3ID", "Spieler4ID", "Ergebnis", "Spieler1RangBeiErgebnis", "Spieler3RangBeiErgebnis", "MatchStart", "ErgebnisErfasstAm",
]);

function match(id, values) {
  return Object.freeze({ Ignore: "1", ID: `test-history-${id}`, MatchDate: "", ForderungDate: "", BewerbID: "", BewerbRunde: "", Spieler1ID: "", Spieler2ID: "", Spieler3ID: "", Spieler4ID: "", Ergebnis: "", Spieler1RangBeiErgebnis: "", Spieler3RangBeiErgebnis: "", MatchStart: "", ErgebnisErfasstAm: "", ...values });
}

const MATCHES = Object.freeze([
  match("match-01-challenge", { ForderungDate: "260801-0900", BewerbID: "2", BewerbRunde: "R1", Spieler1ID: "47", Spieler3ID: "81" }),
  match("match-02-challenge", { ForderungDate: "260802-0900", BewerbID: "2", BewerbRunde: "R1", Spieler1ID: "47", Spieler3ID: "81" }),
  match("match-03-challenge", { ForderungDate: "260803-0900", BewerbID: "3", BewerbRunde: "R1", Spieler1ID: "3", Spieler3ID: "82" }),
  match("match-04-challenge", { ForderungDate: "260804-0900", BewerbID: "3", BewerbRunde: "R1", Spieler1ID: "3", Spieler3ID: "82" }),
  match("match-07-appointment", { MatchDate: "260807-1800", BewerbID: "5", BewerbRunde: "VF", Spieler1ID: "81", Spieler3ID: "47" }),
  match("match-08-singles-result", { MatchDate: "260808-1800", BewerbID: "6", BewerbRunde: "G1", Spieler1ID: "82", Spieler3ID: "3", Ergebnis: "6-3/6-4" }),
  match("match-09-appointment", { MatchDate: "260809-1800", BewerbID: "5", BewerbRunde: "VF", Spieler1ID: "109", Spieler3ID: "65" }),
  match("match-10-appointment", { MatchDate: "260810-1800", BewerbID: "5", BewerbRunde: "VF", Spieler1ID: "109", Spieler3ID: "30" }),
  match("match-11-appointment", { MatchDate: "260811-1800", BewerbID: "5", BewerbRunde: "VF", Spieler1ID: "65", Spieler3ID: "55" }),
  match("match-12-singles-result", { MatchDate: "260812-1800", BewerbID: "5", BewerbRunde: "HF", Spieler1ID: "109", Spieler3ID: "55", Ergebnis: "6-4/3-6/10-7" }),
  match("match-13-singles-result", { MatchDate: "260813-1800", BewerbID: "5", BewerbRunde: "HF", Spieler1ID: "65", Spieler3ID: "30", Ergebnis: "7-5/6-4" }),
  match("match-14-singles-result", { MatchDate: "260814-1800", BewerbID: "5", BewerbRunde: "F", Spieler1ID: "30", Spieler3ID: "55", Ergebnis: "6-2/4-6/10-8" }),
  match("match-15-doubles-result", { MatchDate: "260815-1000", BewerbID: "11", BewerbRunde: "VF", Spieler1ID: "81", Spieler2ID: "30", Spieler3ID: "47", Spieler4ID: "109", Ergebnis: "6-4/6-3" }),
  match("match-16-doubles-result", { MatchDate: "260816-1000", BewerbID: "9", BewerbRunde: "VF", Spieler1ID: "81", Spieler2ID: "82", Spieler3ID: "65", Spieler4ID: "3", Ergebnis: "7-6(4)/6-4" }),
  match("match-17-doubles-result", { MatchDate: "260817-1000", BewerbID: "11", BewerbRunde: "HF", Spieler1ID: "30", Spieler2ID: "55", Spieler3ID: "109", Spieler4ID: "65", Ergebnis: "6-3/3-6/10-6" }),
  match("match-18-doubles-result", { MatchDate: "260818-1000", BewerbID: "9", BewerbRunde: "HF", Spieler1ID: "47", Spieler2ID: "82", Spieler3ID: "55", Spieler4ID: "3", Ergebnis: "6-2/6-4" }),
]);
const LEGACY_MATCH_IDS = Object.freeze([
  "test-history-match-01-challenge", "test-history-match-03-appointment", "test-history-match-04-singles-result",
  "test-history-match-05-doubles-result", "test-history-match-06-challenge",
]);
const REPLACE_MATCH_IDS = new Set([...LEGACY_MATCH_IDS, ...MATCHES.map(({ ID }) => ID)]);

function participant(eventNumber, userId, role, type, subject, body) {
  return {
    userId,
    role,
    displayName: PEOPLE[userId],
    messageId: `test-history-message-${eventNumber}-${userId}`,
    type,
    subject,
    body,
    deliveries: [{ channel: "Inbox", status: "delivered" }],
  };
}

function event(number, values, participants) {
  return Object.freeze({
    event: Object.freeze({
      id: `test-history-event-${number}`,
      competitionId: "",
      createdAt: Date.UTC(2026, 7, Number(number), 8),
      type: "",
      source: "match",
      sourceId: "",
      actorId: "",
      actorName: "",
      summary: `Testhistorie Ereignis ${number}.`,
      detail: "",
      result: "",
      ...values,
    }),
    participants: Object.freeze(participants),
  });
}

function challenge(number, matchIndex, competitionId, challengerId, challengerRank, opponentId, opponentRank) {
  const challenger = PEOPLE[challengerId];
  const opponent = PEOPLE[opponentId];
  const competition = COMPETITIONS[competitionId].name;
  return event(number, {
    competitionId, type: "challenge", sourceId: MATCHES[matchIndex].ID, actorId: challengerId, actorName: challenger,
    summary: `${challenger} (${challengerRank}) hat ${opponent} (${opponentRank}) gefordert.`,
    detail: `${competition}: Die Beteiligten sollen einen Spieltermin vereinbaren.`,
  }, [
    participant(number, challengerId, "challenger", "challenge_confirmation", `Forderung an ${opponent} bestätigt`, `Du hast ${opponent} (${opponentRank}) als Nummer ${challengerRank} in ${competition} gefordert. Bitte vereinbart einen Spieltermin.`),
    participant(number, opponentId, "opponent", "challenge", `Neue Forderung von ${challenger}`, `${challenger} (${challengerRank}) hat dich auf Rang ${opponentRank} in ${competition} gefordert. Bitte vereinbart einen Spieltermin.`),
  ]);
}

function withdrawal(number, userId) {
  const name = PEOPLE[userId];
  return event(number, {
    competitionId: "2", type: "ranking_withdrawal", source: "ranking", sourceId: `test-history-ranking-${number}`,
    actorId: userId, actorName: name, summary: `${name} ist in der Rangliste Männer nicht mehr aktiv gereiht.`,
    detail: "Die bestehende Platzierung hat Rang 0.",
  }, [participant(number, userId, "withdrawn", "ranking_withdrawal", "Aus Rangliste Männer rausgehängt", "Du bist in der Rangliste Männer derzeit nicht aktiv gereiht. Deine bestehende Ranglistenzeile bleibt erhalten.")]);
}

function appointment(number, matchIndex, player1Id, player3Id) {
  const row = MATCHES[matchIndex];
  const player1 = PEOPLE[player1Id];
  const player3 = PEOPLE[player3Id];
  const day = row.MatchDate.slice(4, 6);
  return event(number, {
    competitionId: row.BewerbID, type: "appointment", sourceId: row.ID, actorId: player1Id, actorName: player1,
    summary: `${player1} und ${player3} haben einen Spieltermin vereinbart.`, detail: `${COMPETITIONS[row.BewerbID].name}: ${day}.08.2026 um 18:00 Uhr.`,
  }, [
    participant(number, player1Id, "player1", "appointment", `Termin gegen ${player3} vereinbart`, `Dein Match gegen ${player3} ist für den ${day}.08.2026 um 18:00 Uhr geplant.`),
    participant(number, player3Id, "player3", "appointment", `Termin gegen ${player1} vereinbart`, `Dein Match gegen ${player1} ist für den ${day}.08.2026 um 18:00 Uhr geplant.`),
  ]);
}

function singlesResult(number, matchIndex, winnerId, loserId) {
  const row = MATCHES[matchIndex];
  const winner = PEOPLE[winnerId];
  const loser = PEOPLE[loserId];
  return event(number, {
    competitionId: row.BewerbID, type: "result", sourceId: row.ID, actorId: winnerId, actorName: winner,
    summary: `${winner} gewinnt gegen ${loser}.`, detail: `${COMPETITIONS[row.BewerbID].name}.`, result: row.Ergebnis,
  }, [
    participant(number, winnerId, "player1", "result", `Einzelsieg gegen ${loser}`, `Du hast das Einzel gegen ${loser} mit ${row.Ergebnis} gewonnen.`),
    participant(number, loserId, "player3", "result", `Einzelergebnis gegen ${winner}`, `Du hast das Einzel gegen ${winner} verloren. Ergebnis: ${row.Ergebnis}.`),
  ]);
}

function doublesResult(number, matchIndex) {
  const row = MATCHES[matchIndex];
  const winners = [row.Spieler1ID, row.Spieler2ID];
  const losers = [row.Spieler3ID, row.Spieler4ID];
  const winnerNames = winners.map((id) => PEOPLE[id]);
  const loserNames = losers.map((id) => PEOPLE[id]);
  const participants = [...winners, ...losers].map((userId, index) => {
    const won = index < 2;
    const partnerId = won ? winners[1 - index] : losers[5 - index];
    const opponents = won ? loserNames : winnerNames;
    return participant(number, userId, `player${index + 1}`, "result", `${won ? "Doppelsieg" : "Doppelergebnis"} mit ${PEOPLE[partnerId]}`, `Du hast mit ${PEOPLE[partnerId]} gegen ${opponents.join(" und ")} mit ${row.Ergebnis} ${won ? "gewonnen" : "verloren"}.`);
  });
  return event(number, {
    competitionId: row.BewerbID, type: "result", sourceId: row.ID, actorId: winners[0], actorName: winnerNames[0],
    summary: `${winnerNames.join(" und ")} gewinnen gegen ${loserNames.join(" und ")}.`, detail: `${COMPETITIONS[row.BewerbID].name}.`, result: row.Ergebnis,
  }, participants);
}

function buildEvents() {
  return Object.freeze([
    challenge("01", 0, "2", "47", 7, "81", 5),
    challenge("02", 1, "2", "47", 7, "81", 5),
    challenge("03", 2, "3", "3", 3, "82", 1),
    challenge("04", 3, "3", "3", 3, "82", 1),
    withdrawal("05", "30"),
    withdrawal("06", "55"),
    appointment("07", 4, "81", "47"),
    singlesResult("08", 5, "82", "3"),
    appointment("09", 6, "109", "65"),
    appointment("10", 7, "109", "30"),
    appointment("11", 8, "65", "55"),
    singlesResult("12", 9, "109", "55"),
    singlesResult("13", 10, "65", "30"),
    singlesResult("14", 11, "30", "55"),
    doublesResult("15", 12),
    doublesResult("16", 13),
    doublesResult("17", 14),
    doublesResult("18", 15),
  ]);
}

const EVENTS = buildEvents();

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function text(value) {
  return String(value ?? "").trim();
}

function headerMap(header, required, table) {
  const indexes = new Map();
  header.forEach((value, index) => indexes.set(text(value).toLowerCase(), index));
  for (const name of required) if (!indexes.has(name.toLowerCase())) fail(`${table.toUpperCase()}_SCHEMA_MISMATCH`);
  return indexes;
}

function cell(row, indexes, name) {
  return text(row[indexes.get(name.toLowerCase())]);
}

function tableRows(valueRanges, index) {
  return valueRanges[index]?.values || valueRanges[index]?.data?.values || [];
}

async function readSeedTables(sheets, sheetId) {
  const response = await sheets.spreadsheets.values.batchGet({ spreadsheetId: sheetId, ranges: ["Personen", "Bewerb", "RL-Platzierung", "Matches1"] });
  const ranges = response.data?.valueRanges || [];
  if (ranges.length !== 4) fail("SHEET_RESPONSE_INCOMPLETE");
  return { people: tableRows(ranges, 0), competitions: tableRows(ranges, 1), rankings: tableRows(ranges, 2), matches: tableRows(ranges, 3) };
}

function validateIdentity(tables) {
  if (!tables.people.length || !tables.competitions.length || !tables.rankings.length || !tables.matches.length) fail("SHEET_TABLE_EMPTY");
  const peopleHeader = headerMap(tables.people[0], ["ID", "Vorname", "Nachname", "Aktiv"], "people");
  for (const [id, fullName] of Object.entries(PEOPLE)) {
    const rows = tables.people.slice(1).filter((row) => cell(row, peopleHeader, "ID") === id);
    if (rows.length !== 1) fail("PERSON_IDENTITY_MISMATCH");
    const actualName = `${cell(rows[0], peopleHeader, "Vorname")} ${cell(rows[0], peopleHeader, "Nachname")}`.trim();
    if (actualName !== fullName || cell(rows[0], peopleHeader, "Aktiv") !== "1") fail("PERSON_IDENTITY_MISMATCH");
  }

  const competitionHeader = headerMap(tables.competitions[0], ["ID", "Bezeichnung", "BewerbsartID"], "competitions");
  for (const [id, expected] of Object.entries(COMPETITIONS)) {
    const rows = tables.competitions.slice(1).filter((row) => cell(row, competitionHeader, "ID") === id);
    if (rows.length !== 1 || cell(rows[0], competitionHeader, "Bezeichnung") !== expected.name || cell(rows[0], competitionHeader, "BewerbsartID") !== expected.type) fail("COMPETITION_IDENTITY_MISMATCH");
  }

  const rankingHeader = headerMap(tables.rankings[0], ["BewerbID", "PersonID", "Rang"], "ranking");
  const expectedRanks = [["2", "47", "7"], ["2", "81", "5"], ["3", "3", "3"], ["3", "82", "1"], ["2", "30", "0"], ["2", "55", "0"]];
  for (const [competitionId, personId, rank] of expectedRanks) {
    const rows = tables.rankings.slice(1).filter((row) => cell(row, rankingHeader, "BewerbID") === competitionId && cell(row, rankingHeader, "PersonID") === personId);
    if (rows.length !== 1 || cell(rows[0], rankingHeader, "Rang") !== rank) fail("RANKING_IDENTITY_MISMATCH");
  }
  return { ranks: Object.fromEntries(expectedRanks.map(([competitionId, personId, rank]) => [`${competitionId}:${personId}`, rank])) };
}

function matchesPlan(tables, { tolerateConflicts = false } = {}) {
  const header = tables.matches[0];
  const indexes = headerMap(header, MATCH_FIELDS, "matches1");
  const ids = new Map();
  tables.matches.slice(1).forEach((row, offset) => {
    const id = cell(row, indexes, "ID");
    if (!id) return;
    if (ids.has(id) && !tolerateConflicts) fail("MATCH_ID_CONFLICT");
    if (!ids.has(id)) ids.set(id, { row, rowNumber: offset + 2 });
  });
  const missing = [];
  const existing = [];
  for (const desired of MATCHES) {
    const found = ids.get(desired.ID);
    if (!found) { missing.push(desired); continue; }
    if (MATCH_FIELDS.some((name) => cell(found.row, indexes, name) !== desired[name])) {
      if (!tolerateConflicts) fail("MATCH_ID_CONFLICT");
      continue;
    }
    existing.push({ ...found, desired });
  }
  return { header, indexes, missing, existing };
}

function replaceRowsPlan(tables) {
  const header = tables.matches[0];
  const indexes = headerMap(header, MATCH_FIELDS, "matches1");
  const rows = [];
  tables.matches.slice(1).forEach((row, offset) => {
    if (REPLACE_MATCH_IDS.has(cell(row, indexes, "ID"))) rows.push({ rowNumber: offset + 2 });
  });
  return { header, rows };
}

function sameEvent(actual, expected) {
  const eventFields = ["id", "competitionId", "createdAt", "type", "source", "sourceId", "actor", "actorName", "summary", "detail", "result"];
  if (eventFields.some((name) => String(actual[name] ?? "") !== String(expected.event[name === "actor" ? "actorId" : name] ?? ""))) return false;
  if (actual.participants.length !== expected.participants.length) return false;
  return expected.participants.every((wanted) => {
    const found = actual.participants.find((entry) => entry.recipient === wanted.userId);
    return found && found.participantRole === wanted.role && found.displayName === wanted.displayName && found.id === wanted.messageId
      && found.type === wanted.type && found.subject === wanted.subject && found.body === wanted.body
      && found.acknowledgedAt === null && found.deliveries.length === 1
      && found.deliveries[0].channel === "Inbox" && found.deliveries[0].status === "delivered";
  });
}

function readOnlyEvent(db, eventId) {
  const row = db.prepare("SELECT * FROM competition_events WHERE event_id = ?").get(eventId);
  if (!row) return null;
  const participants = db.prepare(`SELECT p.*, r.acknowledged_at FROM event_participants p JOIN event_receipts r ON r.event_id = p.event_id AND r.user_id = p.user_id WHERE p.event_id = ? ORDER BY p.user_id`).all(eventId).map((entry) => ({
    id: entry.message_id, recipient: entry.user_id, participantRole: entry.participant_role, displayName: entry.display_name,
    type: entry.projection_type, subject: entry.subject, body: entry.body,
    acknowledgedAt: entry.acknowledged_at === null ? null : Number(entry.acknowledged_at),
    deliveries: db.prepare("SELECT channel, status FROM event_deliveries WHERE event_id = ? AND user_id = ? ORDER BY channel").all(eventId, entry.user_id),
  }));
  return {
    id: row.event_id, competitionId: row.competition_id || null, createdAt: Number(row.created_at), type: row.event_type,
    source: row.source, sourceId: row.source_id, actor: row.actor_id, actorName: row.actor_name, summary: row.summary,
    detail: row.detail, result: row.result, participants,
  };
}

function inspectEventsReadOnly(filename, events = EVENTS) {
  let db;
  try {
    const activeWal = fs.existsSync(`${filename}-wal`) && fs.existsSync(`${filename}-shm`);
    db = new DatabaseSync(activeWal ? filename : `file:${encodeURI(filename)}?immutable=1`, { readOnly: true });
    const schemaVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
    const required = ["competition_events", "event_participants", "event_receipts", "event_deliveries", "event_ack_operations", "messaging_revisions"];
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name));
    const eventColumns = tables.has("competition_events") ? new Set(db.prepare("PRAGMA table_info(competition_events)").all().map(({ name }) => name)) : new Set();
    if (schemaVersion !== 6 || required.some((name) => !tables.has(name)) || !eventColumns.has("result")) fail("MESSAGING_SCHEMA_MISMATCH");
    for (const expected of events) {
      const actual = readOnlyEvent(db, expected.event.id);
      if (actual && !sameEvent(actual, expected)) fail("EVENT_ID_CONFLICT");
    }
  } catch (error) {
    if (["EVENT_ID_CONFLICT", "MESSAGING_SCHEMA_MISMATCH"].includes(error.code)) throw error;
    fail("MESSAGING_READ_ONLY_FAILED");
  } finally {
    try { db?.close(); } catch {}
  }
}

function validateEvents(repository, events = EVENTS) {
  for (const expected of events) {
    const actual = repository.getEvent(expected.event.id);
    if (actual && !sameEvent(actual, expected)) fail("EVENT_ID_CONFLICT");
  }
}

async function inspectSeed({ sheets, sheetId, messagingRepository = null, eventInspector = null }) {
  const tables = await readSeedTables(sheets, sheetId);
  const identity = validateIdentity(tables);
  const plan = matchesPlan(tables);
  const events = buildEvents();
  if (messagingRepository) validateEvents(messagingRepository, events);
  if (eventInspector) await eventInspector(events);
  return { tables, plan, events, identity, matchCount: MATCHES.length, eventCount: events.length, messageCount: events.reduce((sum, item) => sum + item.participants.length, 0), competitionIds: [...COMPETITION_IDS] };
}

function rowFromHeader(header, desired) {
  return header.map((name) => desired[MATCH_FIELDS.find((field) => field.toLowerCase() === text(name).toLowerCase())] || "");
}

async function appendMatches(sheets, sheetId, header, missing) {
  if (!missing.length) return;
  await sheets.spreadsheets.values.append({ spreadsheetId: sheetId, range: "'Matches1'!A1", valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: missing.map((desired) => rowFromHeader(header, desired)) } });
}

function ensureEvents(repository, events) {
  let inserted = 0;
  for (const expected of events) if (repository.ensureEvent(expected.event, expected.participants).inserted) inserted++;
  return inserted;
}

function auditFields(action, eventId, result, counts, errorCode = null) {
  return {
    eventId, actorType: "system", actorId: "history-test-seed", actorName: "", role: "system", action,
    targetType: "test_seed", targetId: "history", requestId: eventId, operationId: eventId, result,
    ...(result === "started" ? { before: counts } : { after: counts }), errorCode,
  };
}

function newAuditId(action) {
  return `test-history-audit-${action}-${crypto.randomUUID()}`.slice(0, 64);
}

function revisionUsers(repository, users) {
  const revise = repository.db.prepare("INSERT INTO messaging_revisions(user_id, revision) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1");
  for (const userId of users) revise.run(userId);
}

function deleteEvents(repository, { validate = true, events = EVENTS } = {}) {
  const existing = events.filter((expected) => {
    const actual = repository.getEvent(expected.event.id);
    if (!actual) return false;
    if (!sameEvent(actual, expected)) {
      if (validate) fail("EVENT_ID_CONFLICT");
      return false;
    }
    return true;
  });
  if (!existing.length) return 0;
  const users = new Set(existing.flatMap(({ participants }) => participants.map(({ userId }) => userId)));
  repository.db.exec("BEGIN IMMEDIATE");
  try {
    const remove = repository.db.prepare("DELETE FROM competition_events WHERE event_id = ?");
    for (const { event: eventData } of existing) remove.run(eventData.id);
    revisionUsers(repository, users);
    repository.db.exec("COMMIT");
    return existing.length;
  } catch (error) {
    try { repository.db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function columnName(index) {
  let value = index + 1;
  let result = "";
  while (value) { value--; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
  return result;
}

async function clearRows(sheets, sheetId, header, rows) {
  for (const { rowNumber } of [...rows].sort((a, b) => b.rowNumber - a.rowNumber)) {
    await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: `'Matches1'!A${rowNumber}:${columnName(header.length - 1)}${rowNumber}`, requestBody: {} });
  }
  return rows.length;
}

async function clearMatches(sheets, sheetId, plan) {
  return clearRows(sheets, sheetId, plan.header, plan.existing);
}

async function cleanupExact({ sheets, sheetId, messagingRepository, events }) {
  const tables = await readSeedTables(sheets, sheetId);
  const plan = matchesPlan(tables, { tolerateConflicts: true });
  const matchesRemoved = await clearMatches(sheets, sheetId, plan);
  const eventsRemoved = deleteEvents(messagingRepository, { validate: false, events });
  return { matchesRemoved, eventsRemoved };
}

async function dryRun(options) {
  if (options.replaceAll) {
    const tables = await readSeedTables(options.sheets, options.sheetId);
    validateIdentity(tables);
    const replacePlan = replaceRowsPlan(tables);
    if (options.eventInspector) await options.eventInspector(EVENTS);
    return { mode: "dry-run", operation: "replace-all", status: "success", matchesToRemove: replacePlan.rows.length, matchCount: MATCHES.length, eventCount: EVENTS.length, messageCount: 42, competitionIds: [...COMPETITION_IDS] };
  }
  const inspected = await inspectSeed(options);
  return { mode: "dry-run", status: "success", matchCount: inspected.matchCount, missingMatchCount: inspected.plan.missing.length, eventCount: inspected.eventCount, messageCount: inspected.messageCount, competitionIds: inspected.competitionIds };
}

async function applySeed({ sheets, sheetId, messagingRepository, auditRepository, auditId = newAuditId("apply") }) {
  const inspected = await inspectSeed({ sheets, sheetId, messagingRepository });
  const counts = { matchCount: MATCHES.length, eventCount: inspected.events.length, messageCount: inspected.messageCount, competitionIds: [...COMPETITION_IDS] };
  auditRepository.record(auditFields("historyTestSeedApply", auditId, "started", counts));
  try {
    await appendMatches(sheets, sheetId, inspected.plan.header, inspected.plan.missing);
    const confirmed = await inspectSeed({ sheets, sheetId, messagingRepository });
    if (confirmed.plan.missing.length) fail("MATCH_APPEND_CONFIRMATION_FAILED");
    const eventsInserted = ensureEvents(messagingRepository, confirmed.events);
    auditRepository.record(auditFields("historyTestSeedApply", auditId, "success", counts));
    return { mode: "apply", status: "success", matchCount: MATCHES.length, matchesInserted: inspected.plan.missing.length, eventCount: confirmed.events.length, messageCount: confirmed.messageCount, eventsInserted, competitionIds: [...COMPETITION_IDS] };
  } catch (error) {
    try { await cleanupExact({ sheets, sheetId, messagingRepository, events: inspected.events }); } catch {}
    try { auditRepository.record(auditFields("historyTestSeedApply", auditId, "failed", counts, String(error.code || "HISTORY_TEST_SEED_APPLY_FAILED").slice(0, 64))); } catch {}
    const controlled = new Error("HISTORY_TEST_SEED_APPLY_FAILED");
    controlled.code = "HISTORY_TEST_SEED_APPLY_FAILED";
    controlled.cause = error;
    throw controlled;
  }
}

function insertEventsInTransaction(repository, events) {
  const now = repository.now();
  const insertEvent = repository.db.prepare("INSERT INTO competition_events(event_id, competition_id, created_at, event_type, source, source_id, actor_id, actor_name, summary, detail, result, inserted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertParticipant = repository.db.prepare("INSERT INTO event_participants(event_id, user_id, participant_role, display_name, message_id, projection_type, subject, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertReceipt = repository.db.prepare("INSERT INTO event_receipts(event_id, user_id, acknowledged_at) VALUES (?, ?, NULL)");
  const insertDelivery = repository.db.prepare("INSERT INTO event_deliveries(event_id, user_id, channel, status, updated_at) VALUES (?, ?, ?, ?, ?)");
  const revise = repository.db.prepare("INSERT INTO messaging_revisions(user_id, revision) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1");
  for (const expected of events) {
    const eventData = expected.event;
    insertEvent.run(eventData.id, eventData.competitionId || null, eventData.createdAt, eventData.type, eventData.source, eventData.sourceId, eventData.actorId, eventData.actorName, eventData.summary, eventData.detail, eventData.result, now);
    for (const projection of expected.participants) {
      insertParticipant.run(eventData.id, projection.userId, projection.role, projection.displayName, projection.messageId, projection.type, projection.subject, projection.body);
      insertReceipt.run(eventData.id, projection.userId);
      for (const delivery of projection.deliveries) insertDelivery.run(eventData.id, projection.userId, delivery.channel, delivery.status, now);
      revise.run(projection.userId);
    }
  }
}

async function replaceAll({ sheets, sheetId, messagingRepository, auditRepository, auditId = newAuditId("replace-all") }) {
  const tables = await readSeedTables(sheets, sheetId);
  validateIdentity(tables);
  const replacePlan = replaceRowsPlan(tables);
  const counts = { matchCount: MATCHES.length, eventCount: EVENTS.length, messageCount: 42, competitionIds: [...COMPETITION_IDS] };
  auditRepository.record(auditFields("historyTestSeedReplaceAll", auditId, "started", counts));
  let sheetWriteAttempted = false;
  let transactionOpen = false;
  try {
    sheetWriteAttempted = replacePlan.rows.length > 0;
    await clearRows(sheets, sheetId, replacePlan.header, replacePlan.rows);
    const clearedTables = await readSeedTables(sheets, sheetId);
    validateIdentity(clearedTables);
    if (replaceRowsPlan(clearedTables).rows.length) fail("MATCH_CLEAR_CONFIRMATION_FAILED");

    sheetWriteAttempted = true;
    await appendMatches(sheets, sheetId, clearedTables.matches[0], MATCHES);
    const confirmed = await readSeedTables(sheets, sheetId);
    validateIdentity(confirmed);
    const confirmedPlan = matchesPlan(confirmed);
    if (confirmedPlan.missing.length) fail("MATCH_APPEND_CONFIRMATION_FAILED");

    messagingRepository.db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    messagingRepository.db.exec("DELETE FROM event_ack_operations; DELETE FROM competition_events; DELETE FROM messaging_revisions");
    insertEventsInTransaction(messagingRepository, EVENTS);
    messagingRepository.db.exec("COMMIT");
    transactionOpen = false;
    auditRepository.record(auditFields("historyTestSeedReplaceAll", auditId, "success", counts));
    return { mode: "replace-all", status: "success", matchesRemoved: replacePlan.rows.length, matchesInserted: MATCHES.length, eventCount: EVENTS.length, messageCount: 42, competitionIds: [...COMPETITION_IDS] };
  } catch (error) {
    if (transactionOpen) try { messagingRepository.db.exec("ROLLBACK"); } catch {}
    if (sheetWriteAttempted) try {
      const current = await readSeedTables(sheets, sheetId);
      await clearRows(sheets, sheetId, current.matches[0], replaceRowsPlan(current).rows);
    } catch {}
    const result = sheetWriteAttempted ? "unknown" : "failed";
    try { auditRepository.record(auditFields("historyTestSeedReplaceAll", auditId, result, counts, String(error.code || "HISTORY_TEST_SEED_REPLACE_ALL_FAILED").slice(0, 64))); } catch {}
    const controlled = new Error("HISTORY_TEST_SEED_REPLACE_ALL_FAILED");
    controlled.code = "HISTORY_TEST_SEED_REPLACE_ALL_FAILED";
    controlled.cause = error;
    throw controlled;
  }
}

async function cleanupSeed({ sheets, sheetId, messagingRepository, auditRepository, auditId = newAuditId("cleanup") }) {
  const tables = await readSeedTables(sheets, sheetId);
  validateIdentity(tables);
  const events = buildEvents();
  const plan = matchesPlan(tables);
  validateEvents(messagingRepository, events);
  const counts = { matchCount: plan.existing.length, eventCount: events.filter(({ event: eventData }) => messagingRepository.getEvent(eventData.id)).length, messageCount: events.filter(({ event: eventData }) => messagingRepository.getEvent(eventData.id)).reduce((sum, item) => sum + item.participants.length, 0), competitionIds: [...COMPETITION_IDS] };
  auditRepository.record(auditFields("historyTestSeedCleanup", auditId, "started", counts));
  try {
    const matchesRemoved = await clearMatches(sheets, sheetId, plan);
    const eventsRemoved = deleteEvents(messagingRepository, { events });
    const resultCounts = { matchCount: matchesRemoved, eventCount: eventsRemoved, messageCount: counts.messageCount, competitionIds: [...COMPETITION_IDS] };
    auditRepository.record(auditFields("historyTestSeedCleanup", auditId, "success", resultCounts));
    return { mode: "cleanup", status: "success", matchesRemoved, eventsRemoved, competitionIds: [...COMPETITION_IDS] };
  } catch (error) {
    try { auditRepository.record(auditFields("historyTestSeedCleanup", auditId, "failed", counts, String(error.code || "HISTORY_TEST_SEED_CLEANUP_FAILED").slice(0, 64))); } catch {}
    const controlled = new Error("HISTORY_TEST_SEED_CLEANUP_FAILED");
    controlled.code = "HISTORY_TEST_SEED_CLEANUP_FAILED";
    controlled.cause = error;
    throw controlled;
  }
}

function output(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function runCli(argv = process.argv.slice(2)) {
  const modes = argv.filter((value) => ["--dry-run", "--apply", "--cleanup", "--replace-all"].includes(value));
  const replaceDryRun = argv.length === 2 && new Set(argv).size === 2 && argv.includes("--dry-run") && argv.includes("--replace-all");
  if (!replaceDryRun && (argv.length !== 1 || modes.length !== 1)) fail("CLI_MODE_REQUIRED");
  const { google } = require("googleapis");
  const { SHEET_ID, MESSAGING_FILE, AUDITLOG_FILE, INSTANCE_ID } = require("../config.js");
  const { MessagingRepository } = require("../messagingRepository.js");
  const { AuditLogRepository } = require("../auditLogRepository.js");
  if (!SHEET_ID) fail("SHEET_ID_MISSING");
  const auth = new google.auth.GoogleAuth({ scopes: [SPREADSHEETS_SCOPE] });
  const sheets = google.sheets({ version: "v4", auth });
  const messagingRepository = new MessagingRepository(MESSAGING_FILE);
  const auditRepository = new AuditLogRepository(AUDITLOG_FILE, { instanceId: INSTANCE_ID });
  try {
    if (replaceDryRun) return await dryRun({ sheets, sheetId: SHEET_ID, replaceAll: true, eventInspector: () => inspectEventsReadOnly(MESSAGING_FILE, []) });
    if (modes[0] === "--dry-run") return await dryRun({ sheets, sheetId: SHEET_ID, eventInspector: (events) => inspectEventsReadOnly(MESSAGING_FILE, events) });
    messagingRepository.init();
    auditRepository.init();
    if (modes[0] === "--apply") return await applySeed({ sheets, sheetId: SHEET_ID, messagingRepository, auditRepository });
    if (modes[0] === "--replace-all") return await replaceAll({ sheets, sheetId: SHEET_ID, messagingRepository, auditRepository });
    return await cleanupSeed({ sheets, sheetId: SHEET_ID, messagingRepository, auditRepository });
  } finally {
    messagingRepository.close();
    auditRepository.close();
  }
}

if (require.main === module) {
  runCli().then((result) => output(result)).catch((error) => {
    output({ mode: process.argv[2] || "invalid", status: "failed", errorCode: String(error.code || "HISTORY_TEST_SEED_FAILED").slice(0, 64) }, process.stderr);
    process.exitCode = 1;
  });
}

module.exports = {
  COMPETITION_IDS,
  EVENTS,
  MATCHES,
  PEOPLE,
  SPREADSHEETS_SCOPE,
  applySeed,
  buildEvents,
  cleanupSeed,
  dryRun,
  inspectEventsReadOnly,
  inspectSeed,
  replaceAll,
  runCli,
  validateIdentity,
};
