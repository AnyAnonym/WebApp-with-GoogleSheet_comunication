const { AppError } = require("./errors.js");

const listeners = new Set();
let repository = null;

const DEFAULT_COURT = Object.freeze({
  matchId: "",
  bewerbId: "",
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
  for (const court of ["1", "2"]) {
    const key = `court:${court}`;
    const current = repository.getState(key, DEFAULT_COURT);
    if (current.revision === 0) repository.setState(key, DEFAULT_COURT, 0);
  }
}

function emit(event) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("stateStore: Listener-Fehler:", error.message);
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
  return { ...structuredClone(snapshot.value), revision: snapshot.revision, updatedAt: snapshot.updatedAt };
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
    onApplied?.(outcome.result.court);
    emit({ type: "court", court, value: outcome.result.court });
  }
  return outcome.repeated ? { ...outcome.result, repeated: true } : outcome.result;
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
  onChange,
  setNavigatorTarget,
  setScoreboardCourt,
};
