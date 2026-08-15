const { AppError } = require("./errors.js");
const { inspectMatchtypDisplayRules } = require("./scoreboardDisplay.js");
const logger = require("./logger.js");

const listeners = new Set();
let repository = null;
let displayRulesMigration = null;

const DEFAULT_COURT = Object.freeze({
  matchId: "",
  bewerbId: "",
  matchtypId: "",
  displayRules: null,
  bewerb: "",
  homePlayerIds: [],
  guestPlayerIds: [],
  homePlayer: "",
  guestPlayer: "",
  dateTime: "",
  runde: "",
  aktiv: 0,
});

function ensureReady() {
  if (!repository) throw new AppError("STATE_UNAVAILABLE", "State-Store ist nicht initialisiert", 503);
}

function init(stateRepository) {
  repository = stateRepository;
  displayRulesMigration = { attempted: false, migratedCourts: [], unresolved: [] };
  for (const court of ["1", "2"]) {
    const key = `court:${court}`;
    const current = repository.getState(key, DEFAULT_COURT);
    if (current.revision === 0) repository.setState(key, DEFAULT_COURT, 0);
  }
}

function migrateLegacyCourtDisplayRules(matchtypen) {
  ensureReady();
  const result = { attempted: true, migratedCourts: [], unresolved: [] };
  for (const court of ["1", "2"]) {
    const key = `court:${court}`;
    const snapshot = repository.getState(key, DEFAULT_COURT);
    const matchtypId = String(snapshot.value.matchtypId || "").trim();
    if (!matchtypId || Object.hasOwn(snapshot.value, "displayRules")) continue;
    const inspectedRules = inspectMatchtypDisplayRules(matchtypen, matchtypId);
    if (!inspectedRules.rules) {
      result.unresolved.push({ court, matchtypId, reason: inspectedRules.reason });
      continue;
    }
    repository.setState(key, { ...snapshot.value, displayRules: inspectedRules.rules }, snapshot.revision);
    result.migratedCourts.push(court);
  }
  displayRulesMigration = {
    ...result,
    migratedCourts: [...new Set([...(displayRulesMigration?.migratedCourts || []), ...result.migratedCourts])],
  };
  if (result.unresolved.length) {
    logger.log("warn", "court_display_rules_unresolved", { count: result.unresolved.length, courts: result.unresolved });
  }
  return structuredClone(result);
}

function emit(event) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      logger.log("error", "state_listener_failed", { eventType: event.type, error });
    }
  }
}

function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getCourt(court) {
  ensureReady();
  if (court !== "1" && court !== "2") throw new AppError("COURT_INVALID", "Court muss 1 oder 2 sein");
  const snapshot = repository.getState(`court:${court}`, DEFAULT_COURT);
  return { ...DEFAULT_COURT, ...structuredClone(snapshot.value), revision: snapshot.revision, updatedAt: snapshot.updatedAt };
}

function getScoreboardCourts() {
  return { "1": getCourt("1"), "2": getCourt("2") };
}

function setScoreboardCourt(court, data, expectedRevision = undefined) {
  const current = getCourt(court);
  const { revision: _revision, updatedAt: _updatedAt, ...currentValue } = current;
  const next = {
    ...currentValue,
    ...structuredClone(data),
    aktiv: data.aktiv === undefined ? currentValue.aktiv : (data.aktiv ? 1 : 0),
  };
  const snapshot = repository.setState(`court:${court}`, next, expectedRevision);
  const value = { ...snapshot.value, revision: snapshot.revision, updatedAt: snapshot.updatedAt };
  emit({ type: "court", court, value });
  return value;
}

function applyCourtOperation(court, operation, update, onApplied) {
  ensureReady();
  if (court !== "1" && court !== "2") throw new AppError("COURT_INVALID", "Court muss 1 oder 2 sein");
  const outcome = repository.applyStateOperation({
    stateKey: `court:${court}`,
    fallback: DEFAULT_COURT,
    expectedRevision: operation.expectedRevision,
    actorKey: `${operation.principal.type}:${operation.principal.id}`,
    operationId: operation.operationId,
    endpoint: operation.endpoint,
    payload: operation.payload,
    update(current) {
      const data = update(structuredClone(current));
      return {
        ...current,
        ...structuredClone(data),
        aktiv: data.aktiv === undefined ? current.aktiv : (data.aktiv ? 1 : 0),
      };
    },
    resultForSnapshot(snapshot) {
      return { success: true, court: { ...snapshot.value, revision: snapshot.revision, updatedAt: snapshot.updatedAt } };
    },
  });
  if (outcome.snapshot) {
    if (operation.endpoint === "courtAssign" && displayRulesMigration) {
      displayRulesMigration.unresolved = displayRulesMigration.unresolved.filter((entry) => entry.court !== court);
    }
    onApplied?.(outcome.result.court);
    emit({ type: "court", court, value: outcome.result.court });
  }
  let result = outcome.result;
  if (outcome.repeated && result?.court && !Object.hasOwn(result.court, "displayRules")) {
    result = {
      ...result,
      court: {
        ...result.court,
        displayRules: null,
      },
    };
  }
  return outcome.repeated ? { ...result, repeated: true } : result;
}

function getNavigatorTarget(monitorId) {
  ensureReady();
  const fallback = { monitorId, commandId: "", path: "", issuedAt: 0 };
  const snapshot = repository.getState(`monitor-target:${monitorId}`, fallback);
  return { ...snapshot.value, revision: snapshot.revision, updatedAt: snapshot.updatedAt };
}

function setNavigatorTarget(monitorId, target, expectedRevision = undefined) {
  ensureReady();
  const value = {
    monitorId,
    commandId: target.commandId,
    path: target.path,
    issuedAt: target.issuedAt,
  };
  const snapshot = repository.setState(`monitor-target:${monitorId}`, value, expectedRevision);
  const result = { ...snapshot.value, revision: snapshot.revision, updatedAt: snapshot.updatedAt };
  emit({ type: "monitor-target", monitorId, value: result });
  return result;
}

function applyNavigatorTargetOperation(monitorId, target, operation) {
  ensureReady();
  const outcome = repository.applyStateOperation({
    stateKey: `monitor-target:${monitorId}`,
    fallback: { monitorId, commandId: "", path: "", issuedAt: 0 },
    expectedRevision: operation.expectedRevision,
    actorKey: `${operation.principal.type}:${operation.principal.id}`,
    operationId: operation.operationId,
    endpoint: operation.endpoint,
    payload: operation.payload,
    update: () => ({ monitorId, commandId: target.commandId, path: target.path, issuedAt: target.issuedAt }),
    resultForSnapshot(snapshot) {
      return { success: true, commandId: target.commandId, targetRevision: snapshot.revision };
    },
  });
  const snapshot = outcome.snapshot
    ? { ...outcome.snapshot.value, revision: outcome.snapshot.revision, updatedAt: outcome.snapshot.updatedAt }
    : null;
  if (snapshot) emit({ type: "monitor-target", monitorId, value: snapshot });
  return { result: outcome.repeated ? { ...outcome.result, repeated: true } : outcome.result, target: snapshot, repeated: outcome.repeated };
}

function getStatus() {
  return {
    ready: !!repository,
    courts: repository ? getScoreboardCourts() : null,
    displayRulesMigration: structuredClone(displayRulesMigration),
  };
}

module.exports = {
  DEFAULT_COURT,
  applyCourtOperation,
  applyNavigatorTargetOperation,
  getCourt,
  getNavigatorTarget,
  getScoreboardCourts,
  getStatus,
  init,
  migrateLegacyCourtDisplayRules,
  onChange,
  setNavigatorTarget,
  setScoreboardCourt,
};
