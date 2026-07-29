const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { MonitorBroker } = require("../monitorBroker.js");
const { StateRepository } = require("../stateRepository.js");

function fakeStateStore(repository) {
  const targets = new Map();
  return {
    getNavigatorTarget(monitorId) {
      return targets.get(monitorId) || { monitorId, commandId: "", path: "", issuedAt: 0, revision: 0, updatedAt: 0 };
    },
    applyNavigatorTargetOperation(monitorId, value, operation) {
      const current = this.getNavigatorTarget(monitorId);
      const outcome = repository.applyStateOperation({
        stateKey: `monitor-target:${monitorId}`,
        fallback: current,
        expectedRevision: operation.expectedRevision,
        actorKey: `${operation.principal.type}:${operation.principal.id}`,
        operationId: operation.operationId,
        endpoint: operation.endpoint,
        payload: operation.payload,
        update: () => ({ monitorId, ...value }),
        resultForSnapshot: (snapshot) => ({ success: true, commandId: value.commandId, targetRevision: snapshot.revision }),
      });
      if (outcome.repeated) return { result: { ...outcome.result, repeated: true }, target: null, repeated: true };
      const target = { ...outcome.snapshot.value, revision: outcome.snapshot.revision, updatedAt: outcome.snapshot.updatedAt };
      targets.set(monitorId, target);
      return { result: outcome.result, target, repeated: false };
    },
  };
}

test("Monitor-Kommandos sind korreliert, geordnet und bei Disconnect abgeschlossen", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  repository.provisionMonitor("Hauptmonitor", "monitor-1");
  const sent = [];
  const published = [];
  const closed = [];
  const broker = new MonitorBroker({
    repository,
    stateStore: fakeStateStore(repository),
    dataStore: { get: () => [["ID"], ["cup-1"]] },
  });
  broker.setTransport({
    send: (_info, message) => {
      sent.push(message);
      return true;
    },
    publish: (topic, value) => published.push({ topic, value }),
    close: (_info, code, reason) => closed.push({ code, reason }),
  });
  const deviceInfo = { principal: { type: "device", id: "monitor-1", role: "device" } };
  const operator = { type: "user", id: "operator-1", name: "Operator" };
  broker.register(deviceInfo);

  const navigation = broker.navigate(operator, {
    monitorId: "monitor-1",
    operationId: "00000000-0000-4000-8000-000000000201",
    path: "/scoreboard.html",
  });
  assert.equal(navigation.delivery, "sent");
  assert.equal(sent.filter((message) => message.data?.kind === "navigate").length, 1);

  const repeatedNavigation = broker.navigate(operator, {
    monitorId: "monitor-1",
    operationId: "00000000-0000-4000-8000-000000000201",
    path: "/scoreboard.html",
  });
  assert.equal(repeatedNavigation.repeated, true);
  assert.equal(repeatedNavigation.commandId, navigation.commandId);
  assert.equal(repeatedNavigation.delivery, "known");
  assert.equal(sent.filter((message) => message.data?.kind === "navigate").length, 1);

  for (const status of ["received", "loading", "loaded"]) {
    assert.deepEqual(broker.acknowledge(deviceInfo.principal, {
      kind: "navigate",
      commandId: navigation.commandId,
      status,
    }), { success: true });
  }
  assert.deepEqual(broker.acknowledge(deviceInfo.principal, {
    kind: "navigate",
    commandId: navigation.commandId,
    status: "loaded",
  }), { success: true, duplicate: true });
  assert.throws(() => broker.acknowledge(deviceInfo.principal, {
    kind: "navigate",
    commandId: navigation.commandId,
    status: "failed",
    errorCode: "LATE_ERROR",
  }), { code: "ACK_INVALID" });

  const pendingNavigation = broker.navigate(operator, {
    monitorId: "monitor-1",
    operationId: "00000000-0000-4000-8000-000000000204",
    path: "/Matches1.html",
  });
  broker.acknowledge(deviceInfo.principal, {
    kind: "navigate",
    commandId: pendingNavigation.commandId,
    status: "received",
  });

  const firstScroll = broker.scroll(operator, {
    monitorId: "monitor-1",
    operationId: "00000000-0000-4000-8000-000000000202",
    direction: "down",
  });
  const firstStatuses = published
    .filter(({ value }) => value.commandId === firstScroll.commandId)
    .map(({ value }) => value.status);
  assert.deepEqual(firstStatuses, ["queued", "sent"]);

  const secondScroll = broker.scroll(operator, {
    monitorId: "monitor-1",
    operationId: "00000000-0000-4000-8000-000000000203",
    direction: "up",
  });
  assert.equal(sent.filter((message) => message.data?.kind === "scroll").length, 1);
  assert.deepEqual(broker.acknowledge(deviceInfo.principal, {
    kind: "scroll",
    commandId: firstScroll.commandId,
    status: "applied",
  }), { success: true });
  assert.equal(sent.filter((message) => message.data?.kind === "scroll").length, 2);
  assert.deepEqual(broker.acknowledge(deviceInfo.principal, {
    kind: "scroll",
    commandId: firstScroll.commandId,
    status: "applied",
  }), { success: true, duplicate: true });

  broker.disconnect("monitor-1", 4003, "test disconnect");
  assert.equal(published.some(({ value }) => (
    value.commandId === pendingNavigation.commandId
    && value.status === "failed"
    && value.errorCode === "MONITOR_OFFLINE"
  )), true);
  assert.equal(published.some(({ value }) => value.commandId === secondScroll.commandId && value.status === "failed"), true);
  assert.equal(published.findLast(({ value }) => value.kind === "presence").value.status, "offline");
  assert.deepEqual(closed, [{ code: 4003, reason: "test disconnect" }]);
  assert.equal(broker.listMonitors()[0].online, false);

  repository.close();
});

test("Scroll-Retry sendet dieselbe Command-ID nach Reconnect erneut", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  repository.provisionMonitor("Hauptmonitor", "monitor-1");
  const sent = [];
  const broker = new MonitorBroker({
    repository,
    stateStore: fakeStateStore(repository),
    dataStore: { get: () => [["ID"]] },
  });
  broker.setTransport({ send: (_info, message) => { sent.push(message); return true; } });
  const firstInfo = { principal: { type: "device", id: "monitor-1", role: "device" } };
  const operator = { type: "user", id: "operator-1", name: "Operator" };
  const params = {
    monitorId: "monitor-1",
    operationId: "00000000-0000-4000-8000-000000000220",
    direction: "down",
  };
  broker.register(firstInfo);
  const first = broker.scroll(operator, params);
  broker.unregister(firstInfo);
  repository.db.prepare(`
    UPDATE operations SET result_json = ? WHERE actor_key = ? AND operation_id = ?
  `).run(JSON.stringify({ ...first, expiresAt: Date.now() - 1 }), "user:operator-1", params.operationId);
  const secondInfo = { principal: { type: "device", id: "monitor-1", role: "device" } };
  broker.register(secondInfo);
  const repeated = broker.scroll(operator, params);

  assert.equal(repeated.repeated, true);
  assert.equal(repeated.delivery, "replayed");
  assert.equal(repeated.commandId, first.commandId);
  assert.deepEqual(sent.filter((message) => message.data?.kind === "scroll").map((message) => message.data.commandId), [first.commandId, first.commandId]);
  assert.equal(sent.at(-1).data.probe, true);
  broker.acknowledge(secondInfo.principal, { kind: "scroll", commandId: first.commandId, status: "applied" });
  const completed = broker.scroll(operator, params);
  assert.equal(completed.terminalStatus.status, "applied");
  assert.equal(sent.filter((message) => message.data?.kind === "scroll").length, 2);
  broker.shutdown();
  repository.close();
});

test("Provisionierung und Rotation sind idempotent ohne Klartexttoken im Operation-Store", () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const broker = new MonitorBroker({
    repository,
    stateStore: fakeStateStore(repository),
    dataStore: { get: () => [["ID"]] },
  });
  const admin = { type: "user", id: "admin-1", name: "Admin" };
  const provisionParams = {
    label: "Monitor",
    operationId: "00000000-0000-4000-8000-000000000210",
  };
  const provisioned = broker.provision(admin, provisionParams);
  assert.ok(provisioned.monitor.token);
  const storedProvision = repository.db.prepare(
    "SELECT result_json FROM operations WHERE actor_key = ? AND operation_id = ?",
  ).get("user:admin-1", provisionParams.operationId).result_json;
  assert.equal(storedProvision.includes(provisioned.monitor.token), false);
  const repeatedProvision = broker.provision(admin, provisionParams);
  assert.equal(repeatedProvision.repeated, true);
  assert.equal(repeatedProvision.tokenUnavailable, true);
  assert.equal(repeatedProvision.monitor.token, undefined);
  assert.equal(repository.listMonitors().length, 1);

  const rotateParams = {
    monitorId: provisioned.monitor.monitorId,
    operationId: "00000000-0000-4000-8000-000000000211",
  };
  const rotated = broker.rotate(admin, rotateParams);
  assert.ok(rotated.monitor.token);
  const storedRotation = repository.db.prepare(
    "SELECT result_json FROM operations WHERE actor_key = ? AND operation_id = ?",
  ).get("user:admin-1", rotateParams.operationId).result_json;
  assert.equal(storedRotation.includes(rotated.monitor.token), false);
  assert.equal(broker.rotate(admin, rotateParams).tokenUnavailable, true);

  const revoked = broker.revoke(admin, {
    monitorId: provisioned.monitor.monitorId,
    operationId: "00000000-0000-4000-8000-000000000212",
  });
  assert.ok(revoked.monitor.revokedAt);
  repository.close();
});
