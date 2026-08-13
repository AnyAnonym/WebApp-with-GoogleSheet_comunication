const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { AppError } = require("./errors.js");

class ScoreLogRepository {
  constructor(filename, { instanceId, now = Date.now } = {}) {
    this.filename = filename;
    this.instanceId = instanceId;
    this.now = now;
    this.db = null;
    this.writeCount = 0;
    this.failureCount = 0;
    this.lastAttemptAt = 0;
    this.lastSuccessAt = 0;
    this.lastError = null;
    this.probeError = null;
  }

  init() {
    if (this.db) return;
    if (this.filename !== ":memory:") fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.filename);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS score_log_sequence (
        instance TEXT NOT NULL,
        court TEXT NOT NULL CHECK (court IN ('1', '2')),
        last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
        PRIMARY KEY(instance, court)
      );
      CREATE TABLE IF NOT EXISTS score_log (
        event_id TEXT PRIMARY KEY,
        instance TEXT NOT NULL,
        court TEXT NOT NULL CHECK (court IN ('1', '2')),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        occurred_at TEXT NOT NULL,
        score TEXT NOT NULL,
        match_id TEXT NOT NULL,
        court_active INTEGER NOT NULL CHECK (court_active = 1),
        court_revision INTEGER NOT NULL CHECK (court_revision >= 0),
        created_at INTEGER NOT NULL,
        UNIQUE(instance, court, sequence)
      );
      CREATE INDEX IF NOT EXISTS score_log_occurred_at ON score_log(created_at, event_id);
    `);
    if (this.filename !== ":memory:") fs.chmodSync(this.filename, 0o600);
  }

  ensureOpen() {
    if (!this.db) throw new AppError("SCORE_LOG_UNAVAILABLE", "ScoreLog-Datenbank ist nicht verfuegbar", 503);
  }

  append({ eventId, court, score, matchId = "", courtActive, courtRevision = 0, occurredAt = new Date(this.now()).toISOString() }) {
    this.ensureOpen();
    if (!/^[0-9a-f-]{36}$/i.test(eventId)) throw new AppError("SCORE_LOG_EVENT_INVALID", "ScoreLog-Event-ID ist ungueltig", 500);
    if (!['1', '2'].includes(court) || courtActive !== true) throw new AppError("SCORE_LOG_CONTEXT_INVALID", "ScoreLog-Court-Kontext ist ungueltig", 500);
    this.lastAttemptAt = this.now();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const existing = this.db.prepare("SELECT * FROM score_log WHERE event_id = ?").get(eventId);
      if (existing) {
        if (
          existing.instance !== this.instanceId
          || existing.court !== court
          || existing.score !== score
          || existing.match_id !== String(matchId || "")
          || Number(existing.court_revision) !== Number(courtRevision || 0)
        ) {
          throw new AppError("SCORE_LOG_EVENT_CONFLICT", "ScoreLog-Event-ID wurde bereits anders verwendet", 409);
        }
        this.db.exec("COMMIT");
        return this.mapRow(existing);
      }
      const sequenceRow = this.db.prepare("SELECT last_sequence FROM score_log_sequence WHERE instance = ? AND court = ?").get(this.instanceId, court);
      const sequence = Number(sequenceRow?.last_sequence || 0) + 1;
      this.db.prepare(`
        INSERT INTO score_log(event_id, instance, court, sequence, occurred_at, score, match_id, court_active, court_revision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(eventId, this.instanceId, court, sequence, occurredAt, score, String(matchId || ""), Number(courtRevision || 0), this.lastAttemptAt);
      this.db.prepare(`
        INSERT INTO score_log_sequence(instance, court, last_sequence) VALUES (?, ?, ?)
        ON CONFLICT(instance, court) DO UPDATE SET last_sequence = excluded.last_sequence
      `).run(this.instanceId, court, sequence);
      this.db.exec("COMMIT");
      this.writeCount++;
      this.lastSuccessAt = this.now();
      this.lastError = null;
      return this.get(eventId);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      this.failureCount++;
      this.lastError = { at: this.now(), code: error.code || "SCORE_LOG_WRITE_FAILED" };
      throw error;
    }
  }

  mapRow(row) {
    return {
      eventId: row.event_id,
      instance: row.instance,
      court: row.court,
      sequence: Number(row.sequence),
      occurredAt: row.occurred_at,
      score: row.score,
      matchId: row.match_id,
      courtActive: Number(row.court_active) === 1,
      courtRevision: Number(row.court_revision),
      createdAt: Number(row.created_at),
    };
  }

  get(eventId) {
    this.ensureOpen();
    const row = this.db.prepare("SELECT * FROM score_log WHERE event_id = ?").get(eventId);
    return row ? this.mapRow(row) : null;
  }

  list() {
    this.ensureOpen();
    return this.db.prepare("SELECT * FROM score_log ORDER BY created_at, event_id").all().map((row) => this.mapRow(row));
  }

  status() {
    if (!this.db) return { open: false, ready: false };
    try {
      const sequences = Object.fromEntries(this.db.prepare("SELECT court, last_sequence FROM score_log_sequence WHERE instance = ?").all(this.instanceId)
        .map((row) => [row.court, Number(row.last_sequence)]));
      this.probeError = null;
      return {
        open: true,
        ready: this.lastError === null && this.probeError === null,
        writeCount: this.writeCount,
        failureCount: this.failureCount,
        lastAttemptAt: this.lastAttemptAt,
        lastSuccessAt: this.lastSuccessAt,
        lastError: this.lastError,
        lastSequenceByCourt: { "1": sequences["1"] || 0, "2": sequences["2"] || 0 },
      };
    } catch (error) {
      this.failureCount++;
      this.probeError = { at: this.now(), code: error.code || "SCORE_LOG_PROBE_FAILED" };
      return { open: true, ready: false, writeCount: this.writeCount, failureCount: this.failureCount, lastAttemptAt: this.lastAttemptAt, lastSuccessAt: this.lastSuccessAt, lastError: this.probeError, lastSequenceByCourt: { "1": 0, "2": 0 } };
    }
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}

module.exports = { ScoreLogRepository };
