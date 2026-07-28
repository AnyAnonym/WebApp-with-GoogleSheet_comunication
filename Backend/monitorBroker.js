const crypto = require("crypto");
const { AppError } = require("./errors.js");
const { canonicalizeMonitorPath, idValue, newCommandId, operationId, requireObject, stringValue } = require("./validators.js");

class MonitorBroker {
  constructor({ repository, stateStore, dataStore }) {
    this.repository = repository;
    this.stateStore = stateStore;
    this.dataStore = dataStore;
    this.connections = new Map();
    this.commandStatus = new Map();
    this.send = null;
    this.publish = null;
    this.close = null;
  }

  setTransport({ send, publish, close }) {
    this.send = send;
    this.publish = publish;
    this.close = close;
  }

  listMonitors() {
    return this.repository.listMonitors().map((monitor) => ({
      ...monitor,
      online: this.connections.has(monitor.monitorId),
      target: this.stateStore.getNavigatorTarget(monitor.monitorId),
      status: this.commandStatus.get(monitor.monitorId) || null,
    }));
  }

  publishMonitorList() {
    this.publish?.("monitors", { monitors: this.listMonitors(), at: Date.now() });
  }

  provision(principal, rawParams) {
    const params = requireObject(rawParams);
    const opId = operationId(params.operationId);
    const label = stringValue(params.label, "label", { max: 100 });
    const actorKey = `${principal.type}:${principal.id}`;
    const outcome = this.repository.transaction(() => {
      const existing = this.repository.getOperation(actorKey, opId, "monitorProvision", { label });
      if (existing) return { response: { ...existing, repeated: true, tokenUnavailable: true }, changed: false };
      const monitor = this.repository.provisionMonitor(label, crypto.randomUUID());
      const persisted = {
        success: true,
        monitor: { monitorId: monitor.monitorId, label: monitor.label, createdAt: monitor.createdAt },
      };
      this.repository.saveOperation(actorKey, opId, "monitorProvision", { label }, persisted);
      return { response: { success: true, monitor }, changed: true };
    });
    if (outcome.changed) this.publishMonitorList();
    return outcome.response;
  }

  rotate(principal, rawParams) {
    const params = requireObject(rawParams);
    const id = idValue(params.monitorId, "monitorId");
    const opId = operationId(params.operationId);
    const actorKey = `${principal.type}:${principal.id}`;
    const payload = { monitorId: id };
    const outcome = this.repository.transaction(() => {
      const existing = this.repository.getOperation(actorKey, opId, "monitorRotate", payload);
      if (existing) return { response: { ...existing, repeated: true, tokenUnavailable: true }, changed: false };
      const monitor = this.repository.rotateMonitorToken(id);
      const persisted = { success: true, monitor: { monitorId: monitor.monitorId, updatedAt: monitor.updatedAt } };
      this.repository.saveOperation(actorKey, opId, "monitorRotate", payload, persisted);
      return { response: { success: true, monitor }, changed: true };
    });
    if (!outcome.changed) return outcome.response;
    this.disconnect(id, 4003, "Geraetetoken rotiert");
    this.publishMonitorList();
    return outcome.response;
  }

  revoke(principal, rawParams) {
    const params = requireObject(rawParams);
    const id = idValue(params.monitorId, "monitorId");
    const opId = operationId(params.operationId);
    const actorKey = `${principal.type}:${principal.id}`;
    const payload = { monitorId: id };
    const outcome = this.repository.transaction(() => {
      const existing = this.repository.getOperation(actorKey, opId, "monitorRevoke", payload);
      if (existing) return { response: { ...existing, repeated: true }, changed: false };
      const result = this.repository.revokeMonitor(id);
      const response = { success: true, monitor: result };
      this.repository.saveOperation(actorKey, opId, "monitorRevoke", payload, response);
      return { response, changed: true };
    });
    if (!outcome.changed) return outcome.response;
    this.disconnect(id, 4003, "Geraet widerrufen");
    this.publishMonitorList();
    return outcome.response;
  }

  register(info) {
    const monitorId = info.principal.id;
    this.disconnect(monitorId, 4009, "Neue Monitorverbindung");
    const connection = {
      info,
      streamId: crypto.randomUUID(),
      nextSequence: 1,
      scrollQueue: [],
      scrollInFlight: null,
      appliedScrollIds: new Map(),
      navigationTimer: null,
      scrollTimer: null,
    };
    this.connections.set(monitorId, connection);
    this.publishStatus(monitorId, { kind: "presence", status: "online", at: Date.now() });
    this.publishMonitorList();
    const target = this.stateStore.getNavigatorTarget(monitorId);
    if (target.path && target.commandId) {
      this.publishStatus(monitorId, { kind: "navigate", commandId: target.commandId, status: "sent", path: target.path, resync: true });
      this.sendNavigation(connection, target, true);
    }
  }

  unregister(info) {
    const monitorId = info.principal?.type === "device" ? info.principal.id : null;
    if (!monitorId) return;
    const connection = this.connections.get(monitorId);
    if (!connection || connection.info !== info) return;
    this.failPendingCommands(connection);
    this.connections.delete(monitorId);
    this.publishStatus(monitorId, { kind: "presence", status: "offline", at: Date.now() });
    this.publishMonitorList();
  }

  failPendingCommands(connection) {
    const monitorId = connection.info.principal.id;
    if (connection.navigationTimer) clearTimeout(connection.navigationTimer);
    if (connection.scrollTimer) clearTimeout(connection.scrollTimer);
    connection.navigationTimer = null;
    connection.scrollTimer = null;
    const navigation = this.commandStatus.get(monitorId);
    if (navigation?.kind === "navigate" && !["loaded", "failed", "offline"].includes(navigation.status)) {
      this.publishStatus(monitorId, {
        kind: "navigate",
        commandId: navigation.commandId,
        status: "failed",
        path: navigation.path,
        errorCode: "MONITOR_OFFLINE",
      });
    }
    for (const queued of connection.scrollQueue) {
      this.publishStatus(monitorId, { kind: "scroll", commandId: queued.commandId, status: "failed", errorCode: "MONITOR_OFFLINE" });
    }
    if (connection.scrollInFlight) {
      this.publishStatus(monitorId, { kind: "scroll", commandId: connection.scrollInFlight.commandId, status: "failed", errorCode: "MONITOR_OFFLINE" });
    }
    connection.scrollQueue.length = 0;
    connection.scrollInFlight = null;
  }

  disconnect(monitorId, code, reason) {
    const connection = this.connections.get(monitorId);
    if (!connection) return;
    this.failPendingCommands(connection);
    this.connections.delete(monitorId);
    this.publishStatus(monitorId, { kind: "presence", status: "offline", at: Date.now() });
    this.publishMonitorList();
    this.close?.(connection.info, code, reason);
  }

  publishStatus(monitorId, status) {
    const value = { monitorId, ...status, at: status.at || Date.now() };
    if (status.kind === "navigate") this.commandStatus.set(monitorId, value);
    this.publish?.(`monitor-status:${monitorId}`, value);
  }

  sendNavigation(connection, target, resync = false) {
    const sent = this.send?.(connection.info, {
      type: "event",
      topic: "monitor-command",
      data: {
        kind: "navigate",
        commandId: target.commandId,
        monitorId: target.monitorId,
        targetRevision: target.revision,
        path: target.path,
        issuedAt: target.issuedAt,
        loadDeadlineMs: 20000,
        resync,
      },
    }) === true;
    if (!sent) return false;
    if (connection.navigationTimer) clearTimeout(connection.navigationTimer);
    connection.navigationTimer = setTimeout(() => {
      connection.navigationTimer = null;
      if (this.connections.get(target.monitorId) !== connection) return;
      const current = this.stateStore.getNavigatorTarget(target.monitorId);
      if (current.commandId !== target.commandId) return;
      this.publishStatus(target.monitorId, {
        kind: "navigate",
        commandId: target.commandId,
        status: "failed",
        path: target.path,
        errorCode: "ACK_TIMEOUT",
      });
    }, 20000);
    connection.navigationTimer.unref?.();
    return true;
  }

  navigate(principal, rawParams) {
    const params = requireObject(rawParams);
    const monitorId = idValue(params.monitorId, "monitorId");
    const opId = operationId(params.operationId);
    const path = canonicalizeMonitorPath(params.path, this.dataStore);
    const payload = { monitorId, path };
    const monitor = this.repository.listMonitors().find((entry) => entry.monitorId === monitorId && !entry.revokedAt);
    if (!monitor) throw new AppError("MONITOR_NOT_FOUND", "Monitor wurde nicht gefunden", 404);
    const commandId = newCommandId();
    const issuedAt = Date.now();
    const current = this.stateStore.getNavigatorTarget(monitorId);
    const outcome = this.stateStore.applyNavigatorTargetOperation(
      monitorId,
      { commandId, path, issuedAt },
      {
        principal,
        operationId: opId,
        endpoint: "monitorNavigate",
        payload,
        expectedRevision: current.revision,
      },
    );
    if (outcome.repeated) return outcome.result;
    const target = outcome.target;
    const connection = this.connections.get(monitorId);
    const result = outcome.result;
    const delivered = connection ? this.sendNavigation(connection, target, false) : false;
    const delivery = delivered ? "sent" : "offline";
    this.publishStatus(monitorId, { kind: "navigate", commandId, status: delivery, path });
    return { ...result, delivery };
  }

  scroll(principal, rawParams) {
    const params = requireObject(rawParams);
    const monitorId = idValue(params.monitorId, "monitorId");
    const opId = operationId(params.operationId);
    const direction = stringValue(params.direction, "direction", { max: 4 });
    if (!['up', 'down'].includes(direction)) throw new AppError("VALIDATION_ERROR", "direction muss up oder down sein");
    const payload = { monitorId, direction };
    const actorKey = `${principal.type}:${principal.id}`;
    const existing = this.repository.getOperation(actorKey, opId, "monitorScroll", payload);
    const connection = this.connections.get(monitorId);
    if (!connection) throw new AppError("MONITOR_OFFLINE", "Monitor ist offline", 409);
    if (existing) {
      if (!Number.isFinite(existing.expiresAt)) return { ...existing, repeated: true, delivery: "unavailable" };
      const terminalStatus = connection.appliedScrollIds.get(existing.commandId);
      const terminalIsUncertain = terminalStatus?.status === "failed"
        && ["ACK_TIMEOUT", "MONITOR_OFFLINE", "TRANSPORT_FAILED"].includes(terminalStatus.errorCode);
      if (terminalStatus && !terminalIsUncertain) {
        return { ...existing, repeated: true, delivery: "known", terminalStatus };
      }
      const alreadyKnown = connection.scrollInFlight?.commandId === existing.commandId
        || connection.scrollQueue.some((command) => command.commandId === existing.commandId);
      if (!alreadyKnown) {
        if (connection.scrollQueue.length >= 50) throw new AppError("MONITOR_QUEUE_FULL", "Scroll-Warteschlange ist voll", 429);
        if (terminalIsUncertain) connection.appliedScrollIds.delete(existing.commandId);
        const replay = {
          kind: "scroll",
          commandId: existing.commandId,
          monitorId,
          streamId: connection.streamId,
          seq: connection.nextSequence++,
          deltaY: direction === "up" ? -300 : 300,
          expiresAt: existing.expiresAt,
          ackTimeoutMs: 5000,
          probe: existing.expiresAt <= Date.now() || terminalIsUncertain,
        };
        connection.scrollQueue.push(replay);
        this.publishStatus(monitorId, { kind: "scroll", commandId: replay.commandId, status: "queued", seq: replay.seq, replay: true });
        this.sendNextScroll(connection);
      }
      return {
        ...existing,
        repeated: true,
        delivery: alreadyKnown ? "known" : "replayed",
      };
    }
    if (connection.scrollQueue.length >= 50) throw new AppError("MONITOR_QUEUE_FULL", "Scroll-Warteschlange ist voll", 429);
    const command = {
      kind: "scroll",
      commandId: newCommandId(),
      monitorId,
      streamId: connection.streamId,
      seq: connection.nextSequence++,
      deltaY: direction === "up" ? -300 : 300,
      expiresAt: Date.now() + 30000,
    };
    const result = { success: true, commandId: command.commandId, seq: command.seq, expiresAt: command.expiresAt };
    this.repository.saveOperation(actorKey, opId, "monitorScroll", payload, result);
    connection.scrollQueue.push(command);
    this.publishStatus(monitorId, { kind: "scroll", commandId: command.commandId, status: "queued", seq: command.seq });
    this.sendNextScroll(connection);
    return result;
  }

  sendNextScroll(connection) {
    if (connection.scrollInFlight) return;
    while (connection.scrollQueue.length && !connection.scrollQueue[0].probe && connection.scrollQueue[0].expiresAt <= Date.now()) {
      const expired = connection.scrollQueue.shift();
      connection.appliedScrollIds.set(expired.commandId, { status: "failed", errorCode: "COMMAND_EXPIRED" });
      this.publishStatus(expired.monitorId, { kind: "scroll", commandId: expired.commandId, status: "failed", errorCode: "COMMAND_EXPIRED" });
    }
    const command = connection.scrollQueue.shift();
    if (!command) return;
    connection.scrollInFlight = command;
    const { ackTimeoutMs: _ackTimeoutMs, ...publicCommand } = command;
    const sent = this.send?.(connection.info, { type: "event", topic: "monitor-command", data: publicCommand }) === true;
    if (!sent) {
      connection.scrollInFlight = null;
      this.publishStatus(command.monitorId, { kind: "scroll", commandId: command.commandId, status: "failed", errorCode: "TRANSPORT_FAILED" });
      this.disconnect(command.monitorId, 1011, "Monitortransport fehlgeschlagen");
      return;
    }
    if (connection.scrollTimer) clearTimeout(connection.scrollTimer);
    connection.scrollTimer = setTimeout(() => {
      connection.scrollTimer = null;
      if (this.connections.get(command.monitorId) !== connection || connection.scrollInFlight?.commandId !== command.commandId) return;
      connection.scrollInFlight = null;
      connection.appliedScrollIds.set(command.commandId, { status: "failed", errorCode: "ACK_TIMEOUT" });
      this.publishStatus(command.monitorId, { kind: "scroll", commandId: command.commandId, status: "failed", errorCode: "ACK_TIMEOUT", seq: command.seq });
      this.sendNextScroll(connection);
    }, command.ackTimeoutMs || Math.max(1, command.expiresAt - Date.now()));
    connection.scrollTimer.unref?.();
    this.publishStatus(command.monitorId, { kind: "scroll", commandId: command.commandId, status: "sent", seq: command.seq });
  }

  acknowledge(principal, rawParams) {
    if (principal.type !== "device") throw new AppError("DEVICE_REQUIRED", "Monitor-Geraet erforderlich", 403);
    const params = requireObject(rawParams);
    const commandId = idValue(params.commandId, "commandId");
    const kind = stringValue(params.kind, "kind", { max: 16 });
    const monitorId = principal.id;
    const connection = this.connections.get(monitorId);
    if (!connection) throw new AppError("MONITOR_OFFLINE", "Monitorverbindung ist nicht aktiv", 409);

    if (kind === "scroll") {
      const command = connection.scrollInFlight;
      if (!command || command.commandId !== commandId) {
        if (connection.appliedScrollIds.has(commandId)) return { success: true, duplicate: true };
        throw new AppError("STALE_COMMAND", "Scrollkommando ist nicht mehr aktuell", 409);
      }
      if (!["applied", "failed"].includes(params.status)) throw new AppError("ACK_INVALID", "Scrollstatus ist ungueltig");
      if (connection.scrollTimer) clearTimeout(connection.scrollTimer);
      connection.scrollTimer = null;
      const errorCode = params.status === "failed"
        ? stringValue(params.errorCode || "SCROLL_FAILED", "errorCode", { max: 64, pattern: /^[A-Z0-9_]+$/ })
        : undefined;
      connection.appliedScrollIds.set(commandId, { status: params.status, errorCode });
      if (connection.appliedScrollIds.size > 100) connection.appliedScrollIds.delete(connection.appliedScrollIds.keys().next().value);
      connection.scrollInFlight = null;
      this.publishStatus(monitorId, { kind: "scroll", commandId, status: params.status, errorCode, seq: command.seq });
      this.sendNextScroll(connection);
      return { success: true };
    }

    if (kind !== "navigate") throw new AppError("ACK_INVALID", "Unbekannter ACK-Typ");
    const target = this.stateStore.getNavigatorTarget(monitorId);
    if (target.commandId !== commandId) throw new AppError("STALE_COMMAND", "Navigationskommando ist nicht mehr aktuell", 409);
    const allowed = ["received", "loading", "loaded", "failed"];
    if (!allowed.includes(params.status)) throw new AppError("ACK_INVALID", "Navigationsstatus ist ungueltig");
    const current = this.commandStatus.get(monitorId);
    const order = { sent: 0, offline: 0, received: 1, loading: 2, loaded: 3, failed: 3 };
    if (current?.commandId === commandId && ["loaded", "failed"].includes(current.status)) {
      if (current.status === params.status) return { success: true, duplicate: true };
      throw new AppError("ACK_INVALID", "Navigationskommando ist bereits abgeschlossen", 409);
    }
    if (current?.commandId === commandId && order[params.status] < order[current.status]) {
      throw new AppError("ACK_INVALID", "Status darf nicht zurueckgesetzt werden", 409);
    }
    const errorCode = params.status === "failed"
      ? stringValue(params.errorCode || "LOAD_FAILED", "errorCode", { max: 64, pattern: /^[A-Z0-9_]+$/ })
      : undefined;
    if (["loaded", "failed"].includes(params.status) && connection.navigationTimer) {
      clearTimeout(connection.navigationTimer);
      connection.navigationTimer = null;
    }
    this.publishStatus(monitorId, { kind: "navigate", commandId, status: params.status, path: target.path, errorCode });
    return { success: true };
  }

  status() {
    return {
      online: [...this.connections.keys()],
      commandStatus: Object.fromEntries(this.commandStatus),
    };
  }

  shutdown() {
    for (const monitorId of [...this.connections.keys()]) this.disconnect(monitorId, 1012, "Service restart");
  }
}

module.exports = { MonitorBroker };
