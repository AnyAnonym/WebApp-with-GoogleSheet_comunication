const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { AppError } = require("./errors.js");

const SCHEMA_VERSION = 4;

class MessagingRepository {
  constructor(filename, { now = Date.now } = {}) {
    this.filename = filename;
    this.now = now;
    this.db = null;
    this.failureCount = 0;
    this.lastError = null;
  }

  init() {
    if (this.db) return;
    if (this.filename !== ":memory:") fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.filename);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    const version = Number(this.db.prepare("PRAGMA user_version").get().user_version);
    const hasLegacy = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get());
    if (version > SCHEMA_VERSION) throw new AppError("MESSAGING_SCHEMA_UNSUPPORTED", "Nachrichtenschema ist neuer als diese Anwendung", 503);
    if (hasLegacy) this.migrateV1();
    else if (version === 0) {
      this.createSchema();
    } else if (version === 2) {
      this.migrateV2();
      this.migrateV3();
    } else if (version === 3) {
      this.migrateV3();
    } else if (version !== SCHEMA_VERSION) {
      throw new AppError("MESSAGING_SCHEMA_UNSUPPORTED", "Nachrichtenschema kann nicht migriert werden", 503);
    }
    if (this.filename !== ":memory:") fs.chmodSync(this.filename, 0o600);
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS competition_events (
        event_id TEXT PRIMARY KEY,
        competition_id TEXT,
        created_at INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail TEXT NOT NULL,
        result TEXT NOT NULL,
        inserted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS competition_events_history ON competition_events(competition_id, created_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS competition_events_source ON competition_events(source, source_id);
      CREATE TABLE IF NOT EXISTS event_participants (
        event_id TEXT NOT NULL REFERENCES competition_events(event_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        participant_role TEXT NOT NULL,
        display_name TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        projection_type TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY(event_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS event_participants_user ON event_participants(user_id, event_id);
      CREATE TABLE IF NOT EXISTS event_receipts (
        event_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        acknowledged_at INTEGER,
        PRIMARY KEY(event_id, user_id),
        FOREIGN KEY(event_id, user_id) REFERENCES event_participants(event_id, user_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS event_deliveries (
        event_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'not_configured')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(event_id, user_id, channel),
        FOREIGN KEY(event_id, user_id) REFERENCES event_participants(event_id, user_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS event_ack_operations (
        user_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        acknowledged_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, operation_id),
        FOREIGN KEY(event_id, user_id) REFERENCES event_participants(event_id, user_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS messaging_revisions (
        user_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL
      );
      PRAGMA user_version = 4;
    `);
  }

  migrateV2() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        ALTER TABLE competition_events ADD COLUMN actor_name TEXT NOT NULL DEFAULT '';
        ALTER TABLE competition_events ADD COLUMN summary TEXT NOT NULL DEFAULT '';
        ALTER TABLE competition_events ADD COLUMN detail TEXT NOT NULL DEFAULT '';
        ALTER TABLE event_participants ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
        UPDATE competition_events SET summary = CASE event_type
          WHEN 'challenge' THEN 'Forderung angelegt'
          WHEN 'ranking_withdrawal' THEN 'Spieler aus Rangliste rausgehängt'
          ELSE 'Meldung angelegt'
        END;
        PRAGMA user_version = 3;
        COMMIT;
      `);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  migrateV3() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        ALTER TABLE competition_events ADD COLUMN result TEXT NOT NULL DEFAULT '';
        PRAGMA user_version = 4;
        COMMIT;
      `);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  migrateV1() {
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec(`
        ALTER TABLE messages RENAME TO legacy_messages;
        ALTER TABLE message_deliveries RENAME TO legacy_message_deliveries;
        ALTER TABLE message_acknowledgments RENAME TO legacy_message_acknowledgments;
        ALTER TABLE messaging_revisions RENAME TO legacy_messaging_revisions;
      `);
      this.createSchema();
      const rows = this.db.prepare("SELECT * FROM legacy_messages ORDER BY inserted_at, message_id").all();
      const groups = new Map();
      for (const row of rows) {
        const groupedChallenge = row.source === "match" && row.source_id && ["challenge", "challenge_confirmation"].includes(row.type);
        const key = groupedChallenge ? `match:${row.source_id}` : `message:${row.message_id}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      const insertEvent = this.db.prepare("INSERT INTO competition_events(event_id, competition_id, created_at, event_type, source, source_id, actor_id, actor_name, summary, detail, result, inserted_at) VALUES (?, NULL, ?, ?, ?, ?, ?, '', ?, '', '', ?)");
      const insertParticipant = this.db.prepare("INSERT INTO event_participants(event_id, user_id, participant_role, display_name, message_id, projection_type, subject, body) VALUES (?, ?, ?, '', ?, ?, ?, ?)");
      const insertReceipt = this.db.prepare("INSERT INTO event_receipts(event_id, user_id, acknowledged_at) VALUES (?, ?, ?)");
      const insertDelivery = this.db.prepare("INSERT INTO event_deliveries(event_id, user_id, channel, status, updated_at) SELECT ?, ?, channel, status, updated_at FROM legacy_message_deliveries WHERE message_id = ?");
      const messageEvents = new Map();
      for (const [key, group] of groups) {
        const first = group[0];
        const eventType = key.startsWith("match:") ? "challenge" : first.type;
        const eventId = eventType === "challenge" && first.source === "match"
          ? `evt-${crypto.createHash("sha256").update(`challenge:${first.source_id}`).digest("hex").slice(0, 32)}`
          : `evt-${crypto.createHash("sha256").update(`legacy:${key}`).digest("hex").slice(0, 32)}`;
        const summary = eventType === "challenge" ? "Forderung angelegt" : "Meldung angelegt";
        insertEvent.run(eventId, Math.min(...group.map((row) => Number(row.created_at))), eventType, first.source, first.source_id, first.actor_id, summary, Math.min(...group.map((row) => Number(row.inserted_at))));
        for (const row of group) {
          const role = row.type === "challenge_confirmation" ? "challenger" : (eventType === "challenge" ? "opponent" : "recipient");
          insertParticipant.run(eventId, row.recipient_id, role, row.message_id, row.type, row.subject, row.body);
          insertReceipt.run(eventId, row.recipient_id, row.acknowledged_at);
          insertDelivery.run(eventId, row.recipient_id, row.message_id);
          messageEvents.set(row.message_id, eventId);
        }
      }
      for (const row of this.db.prepare("SELECT * FROM legacy_message_acknowledgments").all()) {
        const eventId = messageEvents.get(row.message_id);
        if (eventId) this.db.prepare("INSERT INTO event_ack_operations(user_id, operation_id, event_id, message_id, acknowledged_at) VALUES (?, ?, ?, ?, ?)")
          .run(row.recipient_id, row.operation_id, eventId, row.message_id, row.acknowledged_at);
      }
      this.db.exec("INSERT INTO messaging_revisions(user_id, revision) SELECT recipient_id, revision FROM legacy_messaging_revisions");
      this.db.exec("DROP TABLE legacy_message_acknowledgments; DROP TABLE legacy_message_deliveries; DROP TABLE legacy_messages; DROP TABLE legacy_messaging_revisions; COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  ensureOpen() {
    if (!this.db) throw new AppError("MESSAGING_UNAVAILABLE", "Nachrichtendatenbank ist nicht verfuegbar", 503);
  }

  ensureEvent(event, participants) {
    this.ensureOpen();
    if (!Array.isArray(participants) || participants.length < 1) throw new AppError("VALIDATION_ERROR", "Ereignis braucht mindestens einen Teilnehmer", 400);
    if (new Set(participants.map((entry) => entry.userId)).size !== participants.length) throw new AppError("VALIDATION_ERROR", "Ereignisteilnehmer muessen eindeutig sein", 400);
    const summary = String(event.summary || event.type || "");
    const detail = String(event.detail || "");
    const result = String(event.result || "");
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const existing = this.db.prepare("SELECT * FROM competition_events WHERE event_id = ?").get(event.id);
      if (existing) {
        const stored = this.db.prepare("SELECT * FROM event_participants WHERE event_id = ? ORDER BY user_id").all(event.id);
        const expected = [...participants].sort((a, b) => a.userId.localeCompare(b.userId));
        const competitionCompatible = !existing.competition_id || !event.competitionId || existing.competition_id === event.competitionId;
        const sameEvent = competitionCompatible && existing.event_type === event.type && existing.source === event.source
          && existing.source_id === event.sourceId && existing.actor_id === event.actorId;
        const sameParticipants = stored.every((row) => {
          const participant = expected.find((entry) => entry.userId === row.user_id);
          return participant && row.participant_role === participant.role && row.message_id === participant.messageId
            && row.projection_type === participant.type;
        });
        if (!sameEvent || !sameParticipants) throw new AppError("MESSAGE_ID_CONFLICT", "Ereignis-ID wurde bereits anders verwendet", 409);
        if (!existing.competition_id && event.competitionId) {
          this.db.prepare("UPDATE competition_events SET competition_id = ? WHERE event_id = ?").run(event.competitionId, event.id);
        }
        const missing = expected.filter((participant) => !stored.some((row) => row.user_id === participant.userId));
        const now = this.now();
        const insertParticipant = this.db.prepare("INSERT INTO event_participants(event_id, user_id, participant_role, display_name, message_id, projection_type, subject, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        const insertReceipt = this.db.prepare("INSERT INTO event_receipts(event_id, user_id, acknowledged_at) VALUES (?, ?, NULL)");
        const insertDelivery = this.db.prepare("INSERT INTO event_deliveries(event_id, user_id, channel, status, updated_at) VALUES (?, ?, ?, ?, ?)");
        const revise = this.db.prepare("INSERT INTO messaging_revisions(user_id, revision) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1");
        for (const participant of missing) {
          insertParticipant.run(event.id, participant.userId, participant.role, participant.displayName || "", participant.messageId, participant.type, participant.subject, participant.body);
          insertReceipt.run(event.id, participant.userId);
          for (const delivery of participant.deliveries || []) insertDelivery.run(event.id, participant.userId, delivery.channel, delivery.status, now);
          revise.run(participant.userId);
        }
        this.db.exec("COMMIT");
        return { event: this.getEvent(event.id), inserted: missing.length > 0 };
      }
      const now = this.now();
      this.db.prepare("INSERT INTO competition_events(event_id, competition_id, created_at, event_type, source, source_id, actor_id, actor_name, summary, detail, result, inserted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(event.id, event.competitionId || null, event.createdAt, event.type, event.source, event.sourceId, event.actorId, event.actorName || "", summary, detail, result, now);
      const insertParticipant = this.db.prepare("INSERT INTO event_participants(event_id, user_id, participant_role, display_name, message_id, projection_type, subject, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      const insertReceipt = this.db.prepare("INSERT INTO event_receipts(event_id, user_id, acknowledged_at) VALUES (?, ?, NULL)");
      const insertDelivery = this.db.prepare("INSERT INTO event_deliveries(event_id, user_id, channel, status, updated_at) VALUES (?, ?, ?, ?, ?)");
      const revise = this.db.prepare("INSERT INTO messaging_revisions(user_id, revision) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1");
      for (const participant of participants) {
        insertParticipant.run(event.id, participant.userId, participant.role, participant.displayName || "", participant.messageId, participant.type, participant.subject, participant.body);
        insertReceipt.run(event.id, participant.userId);
        for (const delivery of participant.deliveries || []) insertDelivery.run(event.id, participant.userId, delivery.channel, delivery.status, now);
        revise.run(participant.userId);
      }
      this.db.exec("COMMIT");
      return { event: this.getEvent(event.id), inserted: true };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      this.recordFailure(error);
      throw error;
    }
  }

  ensureMessage(message, deliveries) {
    const outcome = this.ensureEvent({ id: message.id, competitionId: message.competitionId || null, createdAt: message.createdAt, type: message.type, source: message.source, sourceId: message.sourceId, actorId: message.actorId, actorName: "", summary: message.subject, detail: "" }, [{
      userId: message.recipientId, role: "recipient", displayName: "", messageId: message.id, type: message.type, subject: message.subject, body: message.body, deliveries,
    }]);
    return { message: this.getForRecipient(message.recipientId, message.id), inserted: outcome.inserted };
  }

  updateDelivery(eventId, userId, channel, status) {
    this.ensureOpen();
    if (!["delivered", "failed", "not_configured"].includes(status)) throw new AppError("VALIDATION_ERROR", "Zustellstatus ist ungueltig", 400);
    const result = this.db.prepare("UPDATE event_deliveries SET status = ?, updated_at = ? WHERE event_id = ? AND user_id = ? AND channel = ?")
      .run(status, this.now(), eventId, userId, channel);
    if (Number(result.changes) !== 1) throw new AppError("MESSAGE_DELIVERY_NOT_FOUND", "Zustellung wurde nicht gefunden", 404);
  }

  pendingDeliveries(eventId) {
    this.ensureOpen();
    return this.db.prepare(`
      SELECT d.event_id, d.user_id, d.channel, p.message_id
      FROM event_deliveries d
      JOIN event_participants p ON p.event_id = d.event_id AND p.user_id = d.user_id
      WHERE d.event_id = ? AND d.status = 'pending'
      ORDER BY d.user_id, d.channel
    `).all(eventId).map((row) => ({ eventId: row.event_id, userId: row.user_id, channel: row.channel, messageId: row.message_id }));
  }

  rowToMessage(row) {
    const deliveries = this.db.prepare("SELECT channel, status, updated_at FROM event_deliveries WHERE event_id = ? AND user_id = ? ORDER BY channel").all(row.event_id, row.user_id);
    return {
      id: row.message_id, eventId: row.event_id, competitionId: row.competition_id || null, recipient: row.user_id,
      participantRole: row.participant_role, displayName: row.display_name, createdAt: Number(row.created_at), subject: row.subject, body: row.body,
      type: row.projection_type, eventType: row.event_type, source: row.source, sourceId: row.source_id, actor: row.actor_id, actorName: row.actor_name,
      acknowledgedAt: row.acknowledged_at === null ? null : Number(row.acknowledged_at),
      deliveries: deliveries.map((entry) => ({ channel: entry.channel, status: entry.status, updatedAt: Number(entry.updated_at) })),
    };
  }

  projectionSelect() {
    return `SELECT e.*, p.*, r.acknowledged_at FROM competition_events e JOIN event_participants p ON p.event_id = e.event_id
      JOIN event_receipts r ON r.event_id = p.event_id AND r.user_id = p.user_id`;
  }

  getForRecipient(recipientId, messageId) {
    this.ensureOpen();
    const row = this.db.prepare(`${this.projectionSelect()} WHERE p.user_id = ? AND p.message_id = ?`).get(recipientId, messageId);
    return row ? this.rowToMessage(row) : null;
  }

  getEvent(eventId) {
    this.ensureOpen();
    const event = this.db.prepare("SELECT * FROM competition_events WHERE event_id = ?").get(eventId);
    if (!event) return null;
    const rows = this.db.prepare(`${this.projectionSelect()} WHERE e.event_id = ? ORDER BY p.user_id`).all(eventId);
    return {
      id: event.event_id,
      competitionId: event.competition_id || null,
      createdAt: Number(event.created_at),
      type: event.event_type,
      source: event.source,
      sourceId: event.source_id,
      actor: event.actor_id,
      actorName: event.actor_name,
      summary: event.summary,
      detail: event.detail,
      result: event.result,
      participants: rows.map((row) => this.rowToMessage(row)),
    };
  }

  listForRecipient(recipientId, { cursor = null, limit = 20 } = {}) {
    this.ensureOpen();
    let cursorRow = null;
    if (cursor) {
      cursorRow = this.db.prepare(`${this.projectionSelect()} WHERE p.user_id = ? AND p.message_id = ?`).get(recipientId, cursor);
      if (!cursorRow) throw new AppError("MESSAGE_CURSOR_INVALID", "Nachrichten-Cursor ist ungueltig", 400);
    }
    const order = "ORDER BY r.acknowledged_at IS NOT NULL, e.created_at DESC, p.message_id DESC LIMIT ?";
    const rows = cursorRow
      ? this.db.prepare(`${this.projectionSelect()} WHERE p.user_id = ? AND ((r.acknowledged_at IS NOT NULL) > ? OR ((r.acknowledged_at IS NOT NULL) = ? AND (e.created_at < ? OR (e.created_at = ? AND p.message_id < ?)))) ${order}`)
        .all(recipientId, cursorRow.acknowledged_at !== null ? 1 : 0, cursorRow.acknowledged_at !== null ? 1 : 0, cursorRow.created_at, cursorRow.created_at, cursorRow.message_id, limit + 1)
      : this.db.prepare(`${this.projectionSelect()} WHERE p.user_id = ? ${order}`).all(recipientId, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return { messages: page.map((row) => this.rowToMessage(row)), nextCursor: hasMore ? page.at(-1).message_id : null };
  }

  listCompetitionHistory(competitionId, { limit = 100 } = {}) {
    this.ensureOpen();
    const events = this.db.prepare("SELECT event_id FROM competition_events WHERE competition_id = ? ORDER BY created_at DESC, event_id DESC LIMIT ?").all(competitionId, limit);
    return events.map(({ event_id: eventId }) => this.getEvent(eventId));
  }

  historyCursor(scope, eventId) {
    return Buffer.from(`${scope}\0${eventId}`, "utf8").toString("base64url");
  }

  historyCursorEvent(cursor, scope) {
    if (!cursor) return null;
    try {
      const decoded = Buffer.from(cursor, "base64url").toString("utf8");
      const separator = decoded.indexOf("\0");
      const cursorScope = decoded.slice(0, separator);
      const eventId = decoded.slice(separator + 1);
      if (separator < 1 || cursorScope !== scope || !/^[A-Za-z0-9_.:-]{1,64}$/.test(eventId)) throw new Error("invalid");
      return eventId;
    } catch {
      throw new AppError("COMPETITION_HISTORY_CURSOR_INVALID", "Historien-Cursor ist ungueltig", 400);
    }
  }

  pageCompetitionHistory(competitionId = null, { cursor = null, limit = 50 } = {}) {
    this.ensureOpen();
    const scope = competitionId ? `competition:${competitionId}` : "all";
    const cursorEventId = this.historyCursorEvent(cursor, scope);
    let cursorRow = null;
    if (cursorEventId) {
      cursorRow = competitionId
        ? this.db.prepare("SELECT created_at, event_id FROM competition_events WHERE competition_id = ? AND event_id = ?").get(competitionId, cursorEventId)
        : this.db.prepare("SELECT created_at, event_id FROM competition_events WHERE competition_id IS NOT NULL AND event_id = ?").get(cursorEventId);
      if (!cursorRow) throw new AppError("COMPETITION_HISTORY_CURSOR_INVALID", "Historien-Cursor ist ungueltig", 400);
    }
    let rows;
    if (competitionId) {
      rows = cursorRow
        ? this.db.prepare("SELECT event_id FROM competition_events WHERE competition_id = ? AND (created_at < ? OR (created_at = ? AND event_id < ?)) ORDER BY created_at DESC, event_id DESC LIMIT ?")
          .all(competitionId, cursorRow.created_at, cursorRow.created_at, cursorRow.event_id, limit + 1)
        : this.db.prepare("SELECT event_id FROM competition_events WHERE competition_id = ? ORDER BY created_at DESC, event_id DESC LIMIT ?").all(competitionId, limit + 1);
    } else {
      rows = cursorRow
        ? this.db.prepare("SELECT event_id FROM competition_events WHERE competition_id IS NOT NULL AND (created_at < ? OR (created_at = ? AND event_id < ?)) ORDER BY created_at DESC, event_id DESC LIMIT ?")
          .all(cursorRow.created_at, cursorRow.created_at, cursorRow.event_id, limit + 1)
        : this.db.prepare("SELECT event_id FROM competition_events WHERE competition_id IS NOT NULL ORDER BY created_at DESC, event_id DESC LIMIT ?").all(limit + 1);
    }
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      events: page.map(({ event_id: eventId }) => this.getEvent(eventId)),
      nextCursor: hasMore ? this.historyCursor(scope, page.at(-1).event_id) : null,
    };
  }

  competitionHistory(competitionId, options) {
    return this.listCompetitionHistory(competitionId, options);
  }

  enrichCompetitionByMatchId(matchId, competitionId) {
    this.ensureOpen();
    const result = this.db.prepare("UPDATE competition_events SET competition_id = ? WHERE source = 'match' AND source_id = ? AND competition_id IS NULL").run(competitionId, matchId);
    return { matched: Number(result.changes) };
  }

  summary(recipientId) {
    this.ensureOpen();
    const counts = this.db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN r.acknowledged_at IS NULL THEN 1 ELSE 0 END) AS unread FROM event_participants p JOIN event_receipts r ON r.event_id = p.event_id AND r.user_id = p.user_id WHERE p.user_id = ?").get(recipientId);
    const revision = this.db.prepare("SELECT revision FROM messaging_revisions WHERE user_id = ?").get(recipientId)?.revision || 0;
    return { revision: Number(revision), totalCount: Number(counts.total), unreadCount: Number(counts.unread || 0) };
  }

  acknowledge(recipientId, operationId, messageId) {
    this.ensureOpen();
    let committed = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const operation = this.db.prepare("SELECT message_id, acknowledged_at FROM event_ack_operations WHERE user_id = ? AND operation_id = ?").get(recipientId, operationId);
      if (operation) {
        if (operation.message_id !== messageId) throw new AppError("OPERATION_ID_CONFLICT", "operationId wurde bereits anders verwendet", 409);
        this.db.exec("COMMIT"); committed = true;
        return { acknowledgedAt: Number(operation.acknowledged_at), repeated: true, changed: false };
      }
      const message = this.db.prepare("SELECT p.event_id, r.acknowledged_at FROM event_participants p JOIN event_receipts r ON r.event_id = p.event_id AND r.user_id = p.user_id WHERE p.user_id = ? AND p.message_id = ?").get(recipientId, messageId);
      if (!message) throw new AppError("MESSAGE_NOT_FOUND", "Nachricht wurde nicht gefunden", 404);
      const acknowledgedAt = message.acknowledged_at === null ? this.now() : Number(message.acknowledged_at);
      const changed = message.acknowledged_at === null;
      if (changed) {
        this.db.prepare("UPDATE event_receipts SET acknowledged_at = ? WHERE event_id = ? AND user_id = ?").run(acknowledgedAt, message.event_id, recipientId);
        this.db.prepare("INSERT INTO messaging_revisions(user_id, revision) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1").run(recipientId);
      }
      this.db.prepare("INSERT INTO event_ack_operations(user_id, operation_id, event_id, message_id, acknowledged_at) VALUES (?, ?, ?, ?, ?)").run(recipientId, operationId, message.event_id, messageId, acknowledgedAt);
      this.db.exec("COMMIT"); committed = true;
      return { acknowledgedAt, repeated: !changed, changed };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      this.recordFailure(error);
      if (committed || !(error instanceof AppError)) throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Nachrichtenbestaetigung ist unklar", 503, { messageId });
      throw error;
    }
  }

  recordFailure(error) {
    this.failureCount++;
    this.lastError = { at: this.now(), code: error.code || "MESSAGING_WRITE_FAILED" };
  }

  status() {
    if (!this.db) return { open: false, ready: false };
    try {
      const eventCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM competition_events").get().count);
      const participantCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM event_participants").get().count);
      this.lastError = null;
      return { open: true, ready: true, schemaVersion: SCHEMA_VERSION, count: participantCount, eventCount, participantCount, failureCount: this.failureCount, lastError: null };
    } catch (error) {
      this.recordFailure(error);
      return { open: true, ready: false, schemaVersion: SCHEMA_VERSION, count: 0, eventCount: 0, participantCount: 0, failureCount: this.failureCount, lastError: this.lastError };
    }
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}

module.exports = { MessagingRepository };
