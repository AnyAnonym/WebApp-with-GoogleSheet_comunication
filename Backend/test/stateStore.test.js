const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const stateStore = require("../stateStore.js");
const courtPoller = require("../courtPoller.js");
const dataPoller = require("../dataPoller.js");
const dataStore = require("../dataStore.js");
const { TABLE_CONFIG } = require("../config.js");
const { readiness } = require("../server.js");
const { StateRepository } = require("../stateRepository.js");

const matchtypen = [
  ["ID", "Satztiebreak", "Entscheidender Satz"],
  ["2", "3-3", "MT10"],
];

test("Legacy-Courts erhalten Anzeigeregeln ohne Court-Event", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  stateStore.init(repository);
  const legacy = { matchId: "m1", matchtypId: "2", aktiv: 1, homePlayer: "Ada" };
  repository.setState("court:1", legacy, 1);
  let eventCount = 0;
  const unsubscribe = stateStore.onChange(() => eventCount++);

  const result = stateStore.migrateLegacyCourtDisplayRules(matchtypen);

  assert.deepEqual(result, { attempted: true, migratedCourts: ["1"], unresolved: [] });
  assert.equal(eventCount, 0);
  assert.deepEqual(repository.getState("court:1", {}).value, {
    ...legacy,
    displayRules: {
      schemaVersion: 1,
      source: "matchtyp",
      matchtypId: "2",
      satztiebreak: "3-3",
      entscheidenderSatz: "MT10",
    },
  });
  assert.equal(repository.getState("court:1", {}).revision, 3);

  const repeated = stateStore.migrateLegacyCourtDisplayRules(matchtypen);
  assert.deepEqual(repeated, { attempted: true, migratedCourts: [], unresolved: [] });
  assert.deepEqual(stateStore.getStatus().displayRulesMigration, result);
  assert.equal(repository.getState("court:1", {}).revision, 3);
  unsubscribe();
  repository.close();
});

test("Nicht aufloesbare Legacy-Courts bleiben unveraendert und werden diagnostiziert", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  stateStore.init(repository);
  const legacy = { matchId: "m9", matchtypId: "9", aktiv: 1, custom: "erhalten" };
  const before = repository.setState("court:2", legacy, 1);

  const result = stateStore.migrateLegacyCourtDisplayRules(matchtypen);

  assert.deepEqual(result, {
    attempted: true,
    migratedCourts: [],
    unresolved: [{ court: "2", matchtypId: "9", reason: "MATCHTYP_NOT_FOUND" }],
  });
  assert.deepEqual(repository.getState("court:2", {}).value, legacy);
  assert.equal(repository.getState("court:2", {}).revision, before.revision);
  assert.deepEqual(stateStore.getStatus().displayRulesMigration, result);

  stateStore.applyCourtOperation("2", {
    principal: { type: "user", id: "operator-1" },
    operationId: "00000000-0000-4000-8000-000000000902",
    endpoint: "courtAssign",
    payload: { court: "2", matchId: "m2", expectedRevision: before.revision },
    expectedRevision: before.revision,
  }, () => ({
    matchId: "m2",
    matchtypId: "2",
    displayRules: {
      schemaVersion: 1,
      source: "matchtyp",
      matchtypId: "2",
      satztiebreak: "3-3",
      entscheidenderSatz: "MT10",
    },
  }));
  assert.deepEqual(stateStore.getStatus().displayRulesMigration.unresolved, []);
  repository.close();
});

test("Wiederholte Court-Operation wendet Snapshot und Callback nicht erneut an", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  stateStore.init(repository);
  const operation = {
    principal: { type: "user", id: "operator-1" },
    operationId: "00000000-0000-4000-8000-000000000901",
    endpoint: "courtAssign",
    payload: { court: "1", matchId: "m1", expectedRevision: 1 },
    expectedRevision: 1,
  };
  let updateCount = 0;
  let appliedCount = 0;
  const update = () => {
    updateCount++;
    return {
      matchId: "m1",
      matchtypId: "2",
      displayRules: {
        schemaVersion: 1,
        source: "matchtyp",
        matchtypId: "2",
        satztiebreak: "3-3",
        entscheidenderSatz: "MT10",
      },
    };
  };

  const first = stateStore.applyCourtOperation("1", operation, update, () => appliedCount++);
  const repeated = stateStore.applyCourtOperation("1", operation, update, () => appliedCount++);

  assert.equal(repeated.repeated, true);
  assert.deepEqual(repeated.court.displayRules, first.court.displayRules);
  assert.equal(updateCount, 1);
  assert.equal(appliedCount, 1);
  assert.equal(stateStore.getCourt("1").revision, first.court.revision);
  repository.close();
});

test("Legacy-Operationsantwort bleibt bei Wiederholung historisch und erhaelt kompatibles null", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  stateStore.init(repository);
  const operation = {
    principal: { type: "user", id: "operator-1" },
    operationId: "00000000-0000-4000-8000-000000000903",
    endpoint: "courtAssign",
    payload: { court: "1", matchId: "m1", expectedRevision: 1 },
    expectedRevision: 1,
  };
  const first = stateStore.applyCourtOperation("1", operation, () => ({ matchId: "m1", matchtypId: "2" }));
  assert.equal(Object.hasOwn(first.court, "displayRules"), true);
  assert.equal(first.court.displayRules, null);

  const raw = repository.getState("court:1", {});
  const legacyValue = { ...raw.value };
  delete legacyValue.displayRules;
  const legacy = repository.setState("court:1", legacyValue, raw.revision);
  const legacyResult = { success: true, court: { ...legacy.value, revision: legacy.revision, updatedAt: legacy.updatedAt } };
  repository.db.prepare("UPDATE operations SET result_json = ? WHERE operation_id = ?")
    .run(JSON.stringify(legacyResult), operation.operationId);
  stateStore.migrateLegacyCourtDisplayRules(matchtypen);

  const repeated = stateStore.applyCourtOperation("1", operation, () => {
    throw new Error("darf nicht erneut ausgefuehrt werden");
  });
  assert.equal(repeated.repeated, true);
  assert.equal(repeated.court.displayRules, null);
  assert.equal(repeated.court.revision, legacy.revision);

  const current = stateStore.getCourt("1");
  stateStore.applyCourtOperation("1", {
    principal: { type: "user", id: "operator-1" },
    operationId: "00000000-0000-4000-8000-000000000904",
    endpoint: "courtAssign",
    payload: { court: "1", matchId: "m2", expectedRevision: current.revision },
    expectedRevision: current.revision,
  }, () => ({ matchId: "m2", matchtypId: "", displayRules: null }));
  const oldReplay = stateStore.applyCourtOperation("1", operation, () => {
    throw new Error("darf nicht erneut ausgefuehrt werden");
  });
  assert.equal(oldReplay.court.matchId, "m1");
  assert.equal(oldReplay.court.displayRules, null);
  repository.close();
});

test("Nicht aufloesbare Regeln eines aktiven Legacy-Courts blockieren Readiness", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  stateStore.init(repository);
  repository.setState("court:1", { matchId: "m9", matchtypId: "9", aktiv: 1 }, 1);
  stateStore.migrateLegacyCourtDisplayRules(matchtypen);
  dataStore.resetForTests();
  for (const table of Object.keys(TABLE_CONFIG)) dataStore.set(table, [["ID"]], { source: "test" });

  const originalPollerStatus = dataPoller.getStatus;
  const originalCourtStatus = courtPoller.getStatus;
  const originalCourtData = courtPoller.getLastData;
  dataPoller.getStatus = () => ({ running: true, tickCount: 0 });
  courtPoller.getStatus = () => ({ courtActive: { "1": true, "2": false } });
  courtPoller.getLastData = () => ({ source: { stale: false } });
  try {
    const status = readiness({ repository, initialized: true, shuttingDown: false });
    assert.equal(status.ready, false);
    assert.equal(status.court.displayRulesReady, false);
    assert.equal(status.court.unresolvedActiveRules[0].court, "1");
  } finally {
    dataPoller.getStatus = originalPollerStatus;
    courtPoller.getStatus = originalCourtStatus;
    courtPoller.getLastData = originalCourtData;
    dataStore.resetForTests();
    repository.close();
  }
});

test("ein vollstaendiger Startsnapshot verlangt auch Matchtyp-Daten", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  stateStore.init(repository);
  dataStore.resetForTests();
  for (const table of Object.keys(TABLE_CONFIG)) {
    if (table !== "matchtyp") dataStore.set(table, [["ID"]], { source: "test" });
  }

  const originalPollerStatus = dataPoller.getStatus;
  const originalCourtStatus = courtPoller.getStatus;
  const originalCourtData = courtPoller.getLastData;
  dataPoller.getStatus = () => ({ running: true, tickCount: 0 });
  courtPoller.getStatus = () => ({ courtActive: { "1": false, "2": false } });
  courtPoller.getLastData = () => ({ source: { stale: true } });
  try {
    const status = readiness({ repository, initialized: true, shuttingDown: false });
    assert.equal(status.ready, false);
    assert.equal(status.data.ready, false);
    assert.equal(status.data.tables.matchtyp.current, false);
  } finally {
    dataPoller.getStatus = originalPollerStatus;
    courtPoller.getStatus = originalCourtStatus;
    courtPoller.getLastData = originalCourtData;
    dataStore.resetForTests();
    repository.close();
  }
});
