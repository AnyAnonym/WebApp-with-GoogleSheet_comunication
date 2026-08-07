const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { AppError } = require("./errors.js");
const logger = require("./logger.js");

class AuditLogRepository {
  constructor(filename, { instanceId, journal = true, now = Date.now } = {}) {
    this.filename = filename;
    this.instanceId = instanceId;
    this.journal = journal;
    this.now = now;
    this.db = null;
    this.writeCount = 0;
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        event_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('started', 'success', 'failed', 'unknown')),
        before_json TEXT,
        after_json TEXT,
        error_code TEXT,
        instance TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_log_occurred_at ON audit_log(created_at, event_id);
      CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log(action, result, created_at);
    `);
    if (this.filename !== ":memory:") fs.chmodSync(this.filename, 0o600);
  }

  ensureOpen() {
    if (!this.db) throw new AppError("AUDIT_LOG_UNAVAILABLE", "Auditlog-Datenbank ist nicht verfuegbar", 503);
  }

  record(event) {
    this.ensureOpen();
    const now = this.now();
    const row = {
      eventId: String(event.eventId),
      occurredAt: event.occurredAt || new Date(now).toISOString(),
      actorType: String(event.actorType || "anonymous"),
      actorId: String(event.actorId || ""),
      role: String(event.role || "anonymous"),
      action: String(event.action || "unknown"),
      targetType: String(event.targetType || ""),
      targetId: String(event.targetId || ""),
      requestId: String(event.requestId || ""),
      operationId: String(event.operationId || ""),
      result: String(event.result || "started"),
      before: event.before ?? null,
      after: event.after ?? null,
      errorCode: event.errorCode ? String(event.errorCode) : null,
    };
    try {
      this.db.prepare(`
        INSERT INTO audit_log(
          event_id, occurred_at, actor_type, actor_id, role, action, target_type, target_id,
          request_id, operation_id, result, before_json, after_json, error_code, instance, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          actor_type = excluded.actor_type,
          actor_id = excluded.actor_id,
          role = excluded.role,
          target_type = excluded.target_type,
          target_id = excluded.target_id,
          result = excluded.result,
          before_json = COALESCE(audit_log.before_json, excluded.before_json),
          after_json = COALESCE(excluded.after_json, audit_log.after_json),
          error_code = excluded.error_code,
          updated_at = excluded.updated_at
      `).run(
        row.eventId, row.occurredAt, row.actorType, row.actorId, row.role, row.action, row.targetType, row.targetId,
        row.requestId, row.operationId, row.result,
        row.before === null ? null : JSON.stringify(row.before),
        row.after === null ? null : JSON.stringify(row.after),
        row.errorCode, this.instanceId, now, now,
      );
      this.writeCount++;
      this.lastError = null;
      if (this.journal && row.result !== "started") {
        logger.log(row.result === "failed" ? "warn" : "info", "audit_recorded", {
          eventId: row.eventId,
          action: row.action,
          actorType: row.actorType,
          actorId: row.actorId,
          role: row.role,
          targetType: row.targetType,
          targetId: row.targetId,
          requestId: row.requestId,
          operationId: row.operationId,
          result: row.result,
          errorCode: row.errorCode,
        });
      }
      return this.get(row.eventId);
    } catch (error) {
      this.failureCount++;
      this.lastError = { at: now, code: error.code || "AUDIT_LOG_WRITE_FAILED" };
      throw error;
    }
  }

  get(eventId) {
    this.ensureOpen();
    const row = this.db.prepare("SELECT * FROM audit_log WHERE event_id = ?").get(eventId);
    return row ? this.mapRow(row) : null;
  }

  mapRow(row) {
    return {
      eventId: row.event_id,
      occurredAt: row.occurred_at,
      actorType: row.actor_type,
      actorId: row.actor_id,
      role: row.role,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      requestId: row.request_id,
      operationId: row.operation_id,
      result: row.result,
      before: row.before_json ? JSON.parse(row.before_json) : null,
      after: row.after_json ? JSON.parse(row.after_json) : null,
      errorCode: row.error_code,
      instance: row.instance,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  list() {
    this.ensureOpen();
    return this.db.prepare("SELECT * FROM audit_log ORDER BY created_at, event_id").all().map((row) => this.mapRow(row));
  }

  status() {
    if (!this.db) return { open: false, ready: false };
    const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count);
    return { open: true, ready: this.lastError === null, count, writeCount: this.writeCount, failureCount: this.failureCount, lastError: this.lastError };
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}

module.exports = { AuditLogRepository };
