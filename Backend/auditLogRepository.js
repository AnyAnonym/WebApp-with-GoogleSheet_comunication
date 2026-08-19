const fs = require("fs");
const net = require("node:net");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { AppError } = require("./errors.js");
const { normalizationAuditSummary } = require("./peopleNormalization.js");
const logger = require("./logger.js");

function boundedText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function maskEmail(value) {
  const [local, domain, ...rest] = String(value || "").split("@");
  if (!local || !domain || rest.length) return "";
  return `${local.slice(0, 1)}***@${domain}`;
}

function expandIpv6(value) {
  const [head = "", tail = ""] = value.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  return [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    .map((part) => part || "0");
}

function maskIp(value) {
  const ip = String(value || "").trim().toLowerCase();
  if (net.isIP(ip) === 4) return `${ip.split(".").slice(0, 3).join(".")}.0/24`;
  if (net.isIP(ip) === 6) return `${expandIpv6(ip).slice(0, 4).join(":")}::/64`;
  return ip === "unknown" ? "unknown" : "";
}

class AuditLogRepository {
  constructor(filename, { instanceId, journal = true, now = Date.now, log = logger.log } = {}) {
    this.filename = filename;
    this.instanceId = instanceId;
    this.journal = journal;
    this.now = now;
    this.log = log;
    this.db = null;
    this.writeCount = 0;
    this.failureCount = 0;
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
      CREATE TABLE IF NOT EXISTS audit_log (
        event_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_name TEXT NOT NULL DEFAULT '',
        request_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('started', 'success', 'failed', 'unknown')),
        before_json TEXT,
        after_json TEXT,
        error_code TEXT,
        source_ip TEXT NOT NULL DEFAULT '',
        attempted_email TEXT NOT NULL DEFAULT '',
        instance TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_log_occurred_at ON audit_log(created_at, event_id);
      CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log(action, result, created_at);
    `);
    const columns = new Set(this.db.prepare("PRAGMA table_info(audit_log)").all().map((column) => column.name));
    for (const [name, definition] of [
      ["actor_name", "TEXT NOT NULL DEFAULT ''"],
      ["target_name", "TEXT NOT NULL DEFAULT ''"],
      ["source_ip", "TEXT NOT NULL DEFAULT ''"],
      ["attempted_email", "TEXT NOT NULL DEFAULT ''"],
    ]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE audit_log ADD COLUMN ${name} ${definition}`);
    }
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
      actorName: boundedText(event.actorName, 200),
      role: String(event.role || "anonymous"),
      action: String(event.action || "unknown"),
      targetType: String(event.targetType || ""),
      targetId: String(event.targetId || ""),
      targetName: boundedText(event.targetName, 200),
      requestId: String(event.requestId || ""),
      operationId: String(event.operationId || ""),
      result: String(event.result || "started"),
      before: event.before ?? null,
      after: event.after ?? null,
      errorCode: event.errorCode ? String(event.errorCode) : null,
      sourceIp: boundedText(event.sourceIp, 64),
      attemptedEmail: boundedText(event.attemptedEmail, 254).toLowerCase(),
    };
    let existing;
    try {
      existing = this.get(row.eventId);
    } catch (error) {
      this.failureCount++;
      this.lastError = { at: now, code: error.code || "AUDIT_LOG_READ_FAILED" };
      throw error;
    }
    if (existing && (
      existing.action !== row.action
      || existing.requestId !== row.requestId
      || existing.operationId !== row.operationId
      || existing.result !== "started"
      || row.result === "started"
    )) {
      throw new AppError("AUDIT_LOG_EVENT_CONFLICT", "Audit-Event-ID wurde bereits anders oder abschliessend verwendet", 409);
    }
    try {
      this.db.prepare(`
        INSERT INTO audit_log(
          event_id, occurred_at, actor_type, actor_id, actor_name, role, action, target_type, target_id, target_name,
          request_id, operation_id, result, before_json, after_json, error_code, source_ip,
          attempted_email, instance, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          actor_type = excluded.actor_type,
          actor_id = excluded.actor_id,
          actor_name = CASE WHEN excluded.actor_name != '' THEN excluded.actor_name ELSE audit_log.actor_name END,
          role = excluded.role,
          target_type = excluded.target_type,
          target_id = excluded.target_id,
          target_name = CASE WHEN excluded.target_name != '' THEN excluded.target_name ELSE audit_log.target_name END,
          result = excluded.result,
          before_json = COALESCE(audit_log.before_json, excluded.before_json),
          after_json = COALESCE(excluded.after_json, audit_log.after_json),
          error_code = excluded.error_code,
          source_ip = CASE WHEN audit_log.source_ip != '' THEN audit_log.source_ip ELSE excluded.source_ip END,
          attempted_email = CASE WHEN audit_log.attempted_email != '' THEN audit_log.attempted_email ELSE excluded.attempted_email END,
          updated_at = excluded.updated_at
      `).run(
        row.eventId, row.occurredAt, row.actorType, row.actorId, row.actorName, row.role, row.action, row.targetType, row.targetId, row.targetName,
        row.requestId, row.operationId, row.result,
        row.before === null ? null : JSON.stringify(row.before),
        row.after === null ? null : JSON.stringify(row.after),
        row.errorCode, row.sourceIp, row.attemptedEmail, this.instanceId, now, now,
      );
      this.writeCount++;
      this.lastError = null;
      const persisted = this.get(row.eventId);
      if (this.journal && persisted.result !== "started") {
        this.log(persisted.result === "failed" ? "warn" : "info", "audit_recorded", {
          eventId: persisted.eventId,
          action: persisted.action,
          actorType: persisted.actorType,
          actorId: persisted.actorId,
          actorName: persisted.actorName,
          role: persisted.role,
          targetType: persisted.targetType,
          targetId: persisted.targetId,
          targetName: persisted.targetName,
          requestId: persisted.requestId,
          operationId: persisted.operationId,
          result: persisted.result,
          errorCode: persisted.errorCode,
          sourceIpMasked: maskIp(persisted.sourceIp),
          attemptedEmailMasked: maskEmail(persisted.attemptedEmail),
          changeSummary: persisted.action === "normalizePerson"
            ? normalizationAuditSummary(persisted.before, persisted.after)
            : "",
        });
      }
      return persisted;
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
      actorName: row.actor_name,
      role: row.role,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      targetName: row.target_name,
      requestId: row.request_id,
      operationId: row.operation_id,
      result: row.result,
      before: row.before_json ? JSON.parse(row.before_json) : null,
      after: row.after_json ? JSON.parse(row.after_json) : null,
      errorCode: row.error_code,
      sourceIp: row.source_ip,
      attemptedEmail: row.attempted_email,
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
    try {
      const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count);
      this.probeError = null;
      return { open: true, ready: this.lastError === null, count, writeCount: this.writeCount, failureCount: this.failureCount, lastError: this.lastError };
    } catch (error) {
      this.failureCount++;
      this.probeError = { at: this.now(), code: error.code || "AUDIT_LOG_PROBE_FAILED" };
      return { open: true, ready: false, count: 0, writeCount: this.writeCount, failureCount: this.failureCount, lastError: this.probeError };
    }
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}

module.exports = { AuditLogRepository };
