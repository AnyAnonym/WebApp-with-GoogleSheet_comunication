const crypto = require("crypto");
const { AppError } = require("./errors.js");
const { TokenBucketLimiter } = require("./security.js");
const { booleanValue, idValue, integerValue, requireObject, stringValue } = require("./validators.js");
const metrics = require("./metrics.js");

const SETTINGS_KEY = "frontend-logging:settings";
const TARGETS_KEY = "frontend-logging:targets";
const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  level: "warn",
  includeAnonymous: false,
  sampleRatePercent: 10,
  batchSize: 10,
  flushIntervalMs: 5000,
  defaultTargetLevel: "debug",
  defaultTargetDurationMinutes: 120,
  maxTargetDurationMinutes: 1440,
  normalRetentionDays: 14,
  targetedRetentionDays: 7,
});
const EDITABLE_SETTINGS = Object.freeze(Object.keys(DEFAULT_SETTINGS).filter((key) => key !== "maxTargetDurationMinutes"));
const PAGE_TYPES = new Set([
  "Bewerbe", "Matches1", "RoundRobin", "adminLogging", "bewerbsRaster",
  "court-score-test", "entryList", "index", "monitor", "navigator", "players",
  "rangliste", "scoreboard",
]);

const EVENT_LEVELS = new Map([
  ["admin_logging_load_failed", "error"],
  ["admin_logging_settings_save_failed", "error"],
  ["admin_logging_target_add_failed", "error"],
  ["admin_logging_target_remove_failed", "error"],
  ["auth_listener_failed", "error"],
  ["auth_session_refresh_failed", "error"],
  ["auth_socket_reauthentication_failed", "error"],
  ["competitions_load_failed", "error"],
  ["data_client_event_listener_failed", "error"],
  ["data_client_live_refresh_failed", "error"],
  ["data_client_protocol_error", "error"],
  ["data_client_resync_listener_failed", "error"],
  ["data_client_state_listener_failed", "error"],
  ["entry_list_add_failed", "error"],
  ["entry_list_initialization_failed", "error"],
  ["entry_list_load_failed", "error"],
  ["entry_list_remove_failed", "error"],
  ["frontend_page_loaded", "info"],
  ["frontend_resource_load_failed", "error"],
  ["frontend_retry_scheduled", "warn"],
  ["frontend_unhandled_error", "error"],
  ["frontend_unhandled_rejection", "error"],
  ["login_failed", "error"],
  ["logout_failed", "error"],
  ["monitor_ack_failed", "warn"],
  ["monitor_navigation_command_failed", "error"],
  ["monitor_scroll_command_failed", "error"],
  ["monitor_scroll_failed", "warn"],
  ["monitor_selection_listener_failed", "error"],
  ["monitor_status_listener_failed", "error"],
  ["monitor_target_synchronization_failed", "warn"],
  ["player_directory_initialization_failed", "error"],
  ["player_directory_refresh_failed", "error"],
  ["profile_challenge_failed", "error"],
  ["profile_load_failed", "error"],
  ["ranking_auth_refresh_failed", "error"],
  ["ranking_busy_data_load_failed", "warn"],
  ["ranking_current_player_blocked", "info"],
  ["ranking_identity_state_load_failed", "warn"],
  ["ranking_initialization_failed", "error"],
  ["ranking_loaded", "info"],
  ["ranking_restrictions_load_failed", "warn"],
  ["ranking_rules_applied", "info"],
  ["ranking_rules_load_started", "info"],
  ["ranking_rules_loaded", "info"],
  ["ranking_withdraw_failed", "error"],
  ["rpc_request_completed", "debug"],
  ["rpc_request_failed", "warn"],
  ["scoreboard_initialization_failed", "error"],
  ["scoreboard_resynchronization_failed", "error"],
  ["websocket_connection_recovered", "info"],
  ["websocket_state_changed", "debug"],
]);

const EVENT_KEYS = new Set([
  "attempt", "attemptCount", "category", "closeCode", "code", "count",
  "durationMs", "endpoint", "event", "level", "nextState", "online", "outcome",
  "phase", "previousState", "reconnectAttempt", "resourceType", "supportId",
  "timestamp",
]);

function exactObject(value, allowedKeys, name) {
  const object = requireObject(value, name);
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) throw new AppError("VALIDATION_ERROR", `${name}.${key} ist nicht erlaubt`);
  }
  return object;
}

function levelValue(value, name = "level") {
  const level = stringValue(value, name, { max: 16 }).toLowerCase();
  if (!Object.hasOwn(LEVELS, level)) throw new AppError("VALIDATION_ERROR", `${name} ist ungueltig`);
  return level;
}

function storedInteger(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function normalizeStoredSettings(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const maxTargetDurationMinutes = DEFAULT_SETTINGS.maxTargetDurationMinutes;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.enabled,
    level: Object.hasOwn(LEVELS, raw.level) ? raw.level : DEFAULT_SETTINGS.level,
    includeAnonymous: typeof raw.includeAnonymous === "boolean" ? raw.includeAnonymous : DEFAULT_SETTINGS.includeAnonymous,
    sampleRatePercent: storedInteger(raw.sampleRatePercent, DEFAULT_SETTINGS.sampleRatePercent, 0, 100),
    batchSize: storedInteger(raw.batchSize, DEFAULT_SETTINGS.batchSize, 1, 20),
    flushIntervalMs: storedInteger(raw.flushIntervalMs, DEFAULT_SETTINGS.flushIntervalMs, 1000, 30000),
    defaultTargetLevel: Object.hasOwn(LEVELS, raw.defaultTargetLevel) ? raw.defaultTargetLevel : DEFAULT_SETTINGS.defaultTargetLevel,
    defaultTargetDurationMinutes: storedInteger(raw.defaultTargetDurationMinutes, Math.min(DEFAULT_SETTINGS.defaultTargetDurationMinutes, maxTargetDurationMinutes), 15, maxTargetDurationMinutes),
    maxTargetDurationMinutes,
    normalRetentionDays: DEFAULT_SETTINGS.normalRetentionDays,
    targetedRetentionDays: DEFAULT_SETTINGS.targetedRetentionDays,
  };
}

function validateSettings(value, currentSettings = DEFAULT_SETTINGS) {
  const allowed = new Set([...EDITABLE_SETTINGS, "expectedRevision"]);
  const body = exactObject(value, allowed, "settings");
  const maxTargetDurationMinutes = currentSettings.maxTargetDurationMinutes;
  const settings = {
    enabled: booleanValue(body.enabled, "enabled"),
    level: levelValue(body.level),
    includeAnonymous: booleanValue(body.includeAnonymous, "includeAnonymous"),
    sampleRatePercent: integerValue(body.sampleRatePercent, "sampleRatePercent", { min: 0, max: 100 }),
    batchSize: integerValue(body.batchSize, "batchSize", { min: 1, max: 20 }),
    flushIntervalMs: integerValue(body.flushIntervalMs, "flushIntervalMs", { min: 1000, max: 30000 }),
    defaultTargetLevel: levelValue(body.defaultTargetLevel, "defaultTargetLevel"),
    defaultTargetDurationMinutes: integerValue(body.defaultTargetDurationMinutes, "defaultTargetDurationMinutes", { min: 15, max: maxTargetDurationMinutes }),
    maxTargetDurationMinutes,
    normalRetentionDays: integerValue(body.normalRetentionDays, "normalRetentionDays", { min: 14, max: 14 }),
    targetedRetentionDays: integerValue(body.targetedRetentionDays, "targetedRetentionDays", { min: 7, max: 7 }),
  };
  return {
    expectedRevision: integerValue(body.expectedRevision, "expectedRevision", { min: 0 }),
    settings,
  };
}

function optionalToken(value, name, pattern, max = 128) {
  if (value === undefined || value === null || value === "") return null;
  return stringValue(value, name, { max, pattern });
}

function optionalInteger(value, name, min, max) {
  if (value === undefined || value === null) return null;
  return integerValue(value, name, { min, max });
}

function validateClientEvent(value) {
  const event = exactObject(value, EVENT_KEYS, "event");
  const eventName = stringValue(event.event, "event", { max: 128, pattern: /^[a-z][a-z0-9_]*$/ });
  const level = EVENT_LEVELS.get(eventName);
  if (!level) throw new AppError("FRONTEND_EVENT_NOT_ALLOWED", "Frontend-Ereignis ist nicht erlaubt", 400);
  if (event.level !== undefined && levelValue(event.level, "event.level") !== level) {
    throw new AppError("VALIDATION_ERROR", "event.level passt nicht zum Ereignis");
  }
  const timestamp = optionalToken(event.timestamp, "timestamp", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/, 32);
  return {
    event: eventName,
    level,
    clientTimestamp: timestamp,
    code: optionalToken(event.code, "code", /^[A-Z][A-Z0-9_]{0,63}$/, 64),
    category: optionalToken(event.category, "category", /^[a-z][a-z0-9_-]{0,31}$/, 32),
    supportId: optionalToken(event.supportId, "supportId", /^[A-Za-z0-9_.:-]{1,128}$/, 128),
    endpoint: optionalToken(event.endpoint, "endpoint", /^[A-Za-z][A-Za-z0-9]{0,63}$/, 64),
    durationMs: optionalInteger(event.durationMs, "durationMs", 0, 600000),
    closeCode: optionalInteger(event.closeCode, "closeCode", 0, 4999),
    reconnectAttempt: optionalInteger(event.reconnectAttempt, "reconnectAttempt", 0, 1000),
    attempt: optionalInteger(event.attempt, "attempt", 0, 1000),
    attemptCount: optionalInteger(event.attemptCount, "attemptCount", 0, 1000),
    count: optionalInteger(event.count, "count", 0, 1000000),
    online: event.online === undefined ? null : booleanValue(event.online, "online"),
    previousState: optionalToken(event.previousState, "previousState", /^[a-z][a-z0-9_-]{0,31}$/, 32),
    nextState: optionalToken(event.nextState, "nextState", /^[a-z][a-z0-9_-]{0,31}$/, 32),
    outcome: optionalToken(event.outcome, "outcome", /^[a-z][a-z0-9_-]{0,31}$/, 32),
    phase: optionalToken(event.phase, "phase", /^[a-z][a-z0-9_-]{0,31}$/, 32),
    resourceType: optionalToken(event.resourceType, "resourceType", /^[a-z][a-z0-9_-]{0,31}$/, 32),
  };
}

function sampledIn(percent) {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  return crypto.randomInt(0, 10000) < percent * 100;
}

class FrontendLoggingService {
  constructor({ repository, authService, log, appVersion = "unknown", now = Date.now }) {
    this.repository = repository;
    this.authService = authService;
    this.log = log;
    this.appVersion = appVersion;
    this.now = now;
    this.eventLimiter = new TokenBucketLimiter({ rate: 2, burst: 120, idleMs: 900000, now });
  }

  settingsSnapshot() {
    const snapshot = this.repository.getState(SETTINGS_KEY, DEFAULT_SETTINGS);
    return { ...normalizeStoredSettings(snapshot.value), revision: snapshot.revision };
  }

  targetsSnapshot({ cleanup = true } = {}) {
    const snapshot = this.repository.getState(TARGETS_KEY, {});
    const raw = snapshot.value && typeof snapshot.value === "object" && !Array.isArray(snapshot.value) ? snapshot.value : {};
    const now = this.now();
    const targets = Object.fromEntries(Object.entries(raw).filter(([, target]) => (
      target && typeof target === "object" && Number(target.expiresAt) > now
    )));
    if (cleanup && Object.keys(targets).length !== Object.keys(raw).length) {
      try {
        return this.repository.setState(TARGETS_KEY, targets, snapshot.revision);
      } catch (error) {
        if (error.code === "REVISION_CONFLICT") return this.targetsSnapshot({ cleanup: false });
        throw error;
      }
    }
    return { value: targets, revision: snapshot.revision, updatedAt: snapshot.updatedAt };
  }

  getPolicy(userId = null) {
    const settings = this.settingsSnapshot();
    const targets = this.targetsSnapshot().value;
    const target = userId ? targets[userId] || null : null;
    const globallyEligible = settings.enabled && (Boolean(userId) || settings.includeAnonymous);
    const enabled = Boolean(target) || globallyEligible;
    return {
      enabled,
      level: target?.level || settings.level,
      targeted: Boolean(target),
      expiresAt: target?.expiresAt || null,
      sampleRatePercent: target ? 100 : settings.sampleRatePercent,
      batchSize: settings.batchSize,
      flushIntervalMs: settings.flushIntervalMs,
    };
  }

  updateSettings(value) {
    const current = this.settingsSnapshot();
    const { expectedRevision, settings } = validateSettings(value, current);
    return this.repository.setState(SETTINGS_KEY, settings, expectedRevision);
  }

  setTarget(value, principal) {
    const body = exactObject(value, new Set(["expectedRevision", "personId", "level", "durationMinutes"]), "target");
    const expectedRevision = integerValue(body.expectedRevision, "expectedRevision", { min: 0 });
    const personId = idValue(body.personId, "personId");
    const level = levelValue(body.level);
    const settings = this.settingsSnapshot();
    const durationMinutes = integerValue(body.durationMinutes, "durationMinutes", {
      min: 15,
      max: settings.maxTargetDurationMinutes,
    });
    const person = this.authService.findById(personId);
    if (!person?.active) throw new AppError("PERSON_NOT_FOUND", "Aktive Person wurde nicht gefunden", 404);
    const snapshot = this.targetsSnapshot();
    if (snapshot.revision !== expectedRevision) {
      throw new AppError("REVISION_CONFLICT", "Logging-Ziele wurden zwischenzeitlich geaendert", 409, { currentRevision: snapshot.revision });
    }
    const now = this.now();
    const target = {
      personId,
      level,
      createdAt: now,
      expiresAt: now + durationMinutes * 60000,
      createdBy: principal.id,
    };
    const next = { ...snapshot.value, [personId]: target };
    const stored = this.repository.setState(TARGETS_KEY, next, snapshot.revision);
    return { target, revision: stored.revision };
  }

  removeTarget(value) {
    const body = exactObject(value, new Set(["expectedRevision", "personId"]), "target");
    const expectedRevision = integerValue(body.expectedRevision, "expectedRevision", { min: 0 });
    const personId = idValue(body.personId, "personId");
    const snapshot = this.targetsSnapshot();
    if (snapshot.revision !== expectedRevision) {
      throw new AppError("REVISION_CONFLICT", "Logging-Ziele wurden zwischenzeitlich geaendert", 409, { currentRevision: snapshot.revision });
    }
    if (!Object.hasOwn(snapshot.value, personId)) return { personId, removed: false, revision: snapshot.revision };
    const next = { ...snapshot.value };
    delete next[personId];
    const stored = this.repository.setState(TARGETS_KEY, next, snapshot.revision);
    return { personId, removed: true, revision: stored.revision };
  }

  adminView() {
    const settings = this.settingsSnapshot();
    const targetSnapshot = this.targetsSnapshot();
    const people = this.authService.parsePeople().filter((person) => person.active);
    const peopleById = new Map(people.map((person) => [person.id, person]));
    const nameOf = (person) => [person?.firstName, person?.lastName].filter(Boolean).join(" ");
    const now = this.now();
    return {
      success: true,
      settings,
      targetsRevision: targetSnapshot.revision,
      targets: Object.values(targetSnapshot.value)
        .map((target) => {
          const person = peopleById.get(target.personId);
          const creator = peopleById.get(target.createdBy);
          return {
            ...target,
            name: nameOf(person) || "Unbekannte Person",
            role: person?.role || "unknown",
            remainingMs: Math.max(0, target.expiresAt - now),
            createdByName: nameOf(creator) || "Unbekannter Administrator",
          };
        })
        .sort((left, right) => left.expiresAt - right.expiresAt || left.name.localeCompare(right.name)),
      players: people
        .map((person) => ({ id: person.id, name: nameOf(person), role: person.role }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  recordBatch({ body, identity, sourceIp }) {
    const envelope = exactObject(body, new Set(["appVersion", "clientSessionId", "events", "pageType"]), "batch");
    const rawPageType = stringValue(envelope.pageType, "pageType", { max: 64, pattern: /^[A-Za-z][A-Za-z0-9_-]*$/ });
    const pageType = PAGE_TYPES.has(rawPageType) ? rawPageType : "unknown";
    const appVersion = stringValue(envelope.appVersion, "appVersion", { max: 64, pattern: /^[A-Za-z0-9_.-]+$/ });
    const clientSessionId = stringValue(envelope.clientSessionId, "clientSessionId", {
      max: 64,
      pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    });
    if (!Array.isArray(envelope.events) || envelope.events.length < 1 || envelope.events.length > 20) {
      throw new AppError("VALIDATION_ERROR", "events muss 1 bis 20 Eintraege enthalten");
    }
    const policy = this.getPolicy(identity?.id || null);
    if (!policy.enabled) {
      metrics.recordFrontendEvents("dropped_policy", envelope.events.length);
      return { success: true, accepted: 0, dropped: envelope.events.length };
    }
    const limiterKey = identity?.id ? `user:${identity.id}` : `ip:${sourceIp}`;
    if (!this.eventLimiter.take(limiterKey, envelope.events.length)) {
      metrics.recordFrontendEvents("dropped_rate_limit", envelope.events.length);
      throw new AppError("FRONTEND_EVENT_RATE_LIMIT", "Zu viele Frontend-Ereignisse", 429);
    }
    const settings = this.settingsSnapshot();
    let accepted = 0;
    let dropped = 0;
    for (const rawEvent of envelope.events) {
      const event = validateClientEvent(rawEvent);
      if (LEVELS[event.level] < LEVELS[policy.level]) {
        metrics.recordFrontendEvents("dropped_level");
        dropped++;
        continue;
      }
      if (LEVELS[event.level] < LEVELS.warn && !sampledIn(policy.sampleRatePercent)) {
        metrics.recordFrontendEvents("dropped_sampling");
        dropped++;
        continue;
      }
      this.log(LEVELS[event.level] < LEVELS.warn ? "info" : event.level, "frontend_client_event", {
        frontendEvent: event.event,
        frontendLevel: event.level,
        clientTimestamp: event.clientTimestamp,
        pageType,
        clientAppVersion: appVersion,
        clientVersionMatch: appVersion === this.appVersion,
        clientSessionId,
        code: event.code,
        category: event.category,
        supportId: event.supportId,
        endpoint: event.endpoint,
        durationMs: event.durationMs,
        closeCode: event.closeCode,
        reconnectAttempt: event.reconnectAttempt,
        attempt: event.attempt,
        attemptCount: event.attemptCount,
        count: event.count,
        online: event.online,
        previousState: event.previousState,
        nextState: event.nextState,
        outcome: event.outcome,
        phase: event.phase,
        resourceType: event.resourceType,
        actorType: identity ? "user" : "anonymous",
        actorId: identity?.id || "",
        actorName: identity?.name || "",
        role: identity?.role || "anonymous",
        sourceIp,
        diagnosticProfile: policy.targeted ? "targeted" : "normal",
        diagnosticLevel: policy.level,
        retentionClass: policy.targeted ? "frontend_targeted" : "frontend_normal",
        retentionDays: policy.targeted ? settings.targetedRetentionDays : settings.normalRetentionDays,
      });
      accepted++;
      metrics.recordFrontendEvents("accepted");
    }
    return { success: true, accepted, dropped };
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  EVENT_LEVELS,
  FrontendLoggingService,
  validateClientEvent,
};
