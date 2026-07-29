import { createEndpoint, getOperationId, releaseOperationId } from "./dataClient.js";
import {
  getSelectedMonitorContext,
  onSelectedMonitorChange,
  onSelectedMonitorStatus,
} from "./navigatorList.js";

const scrollMonitor = createEndpoint("monitorScroll");
const MAX_COMMAND_HISTORY = 200;
const statusRank = { queued: 0, sent: 1, applied: 2, failed: 2 };
const buttons = new Map([
  ["up", document.getElementById("scroll-up")],
  ["down", document.getElementById("scroll-down")],
]);

let monitorContext = getSelectedMonitorContext();
let selectedMonitorId = monitorContext.monitorId;
const commandBindings = new Map();
const cachedStatuses = new Map();
const latestCommandByDirection = new Map();
const pendingDirections = new Set();
const uncertainOperationKeys = new Set();

function commandKey(monitorId, commandId) {
  return `${monitorId}:${commandId}`;
}

function directionKey(monitorId, direction) {
  return `${monitorId}:${direction}`;
}

function trimCommandHistory(map) {
  if (map.size > MAX_COMMAND_HISTORY) map.delete(map.keys().next().value);
}

function setScrollStatus(message, state = "idle") {
  const node = document.getElementById("scroll-status");
  if (!node) return;
  node.textContent = message;
  node.dataset.state = state;
}

function requestError(data, fallback) {
  const error = new Error(data?.error?.message || fallback);
  error.code = data?.error?.code || "REQUEST_FAILED";
  return error;
}

async function endpointData(endpoint, params, fallback) {
  const response = await endpoint(params);
  if (!response?.data || response.data.success === false) throw requestError(response?.data, fallback);
  return response.data;
}

function clearButtonState(button) {
  button?.classList.remove("command-sending", "command-pending", "command-success", "command-failed");
  button?.removeAttribute("aria-busy");
}

function clearAllButtonStates() {
  for (const button of buttons.values()) clearButtonState(button);
}

function updateDisabledState() {
  for (const [direction, button] of buttons) {
    if (!button) continue;
    button.disabled = !monitorContext.canScroll || pendingDirections.has(direction);
  }
}

function rememberStatus(status) {
  const key = commandKey(status.monitorId, status.commandId);
  const previous = cachedStatuses.get(key);
  if (previous && (statusRank[status.status] ?? -1) < (statusRank[previous.status] ?? -1)) return previous;
  const next = { ...previous, ...status };
  cachedStatuses.set(key, next);
  trimCommandHistory(cachedStatuses);
  return next;
}

function directionLabel(direction) {
  return direction === "up" ? "Nach oben" : "Nach unten";
}

function applyCommandStatus(rawStatus) {
  if (rawStatus?.kind !== "scroll" || !rawStatus.commandId || !rawStatus.monitorId) return;
  const status = rememberStatus(rawStatus);
  const binding = commandBindings.get(commandKey(status.monitorId, status.commandId));
  if (!binding) return;
  const uncertain = status.status === "failed" && ["ACK_TIMEOUT", "MONITOR_OFFLINE", "TRANSPORT_FAILED"].includes(status.errorCode);
  if (status.status === "applied") {
    uncertainOperationKeys.delete(binding.operationKey);
    releaseOperationId(binding.operationKey);
  } else if (status.status === "failed") {
    if (uncertain) uncertainOperationKeys.add(binding.operationKey);
    else uncertainOperationKeys.delete(binding.operationKey);
    releaseOperationId(binding.operationKey, { code: status.errorCode });
  }
  if (status.monitorId !== monitorContext.monitorId) return;
  if (latestCommandByDirection.get(directionKey(status.monitorId, binding.direction)) !== status.commandId) return;

  const button = buttons.get(binding.direction);
  if (!button) return;
  clearButtonState(button);
  const label = directionLabel(binding.direction);
  if (status.status === "applied") {
    button.classList.add("command-success");
    pendingDirections.delete(binding.direction);
    setScrollStatus(`${label}: angewendet`, "applied");
  } else if (status.status === "failed") {
    button.classList.add("command-failed");
    pendingDirections.delete(binding.direction);
    const detail = status.errorCode ? ` (${status.errorCode})` : "";
    setScrollStatus(uncertain
      ? `${label}: Status unklar${detail}. Erneutes Scrollen kann die Bewegung wiederholen.`
      : `${label}: fehlgeschlagen${detail}`, "failed");
  } else {
    button.classList.add("command-pending");
    button.setAttribute("aria-busy", "true");
    pendingDirections.add(binding.direction);
    setScrollStatus(`${label}: ${status.status === "sent" ? "gesendet" : "wartet"}`, status.status);
  }
  updateDisabledState();
}

async function sendScroll(direction) {
  const button = buttons.get(direction);
  const context = getSelectedMonitorContext();
  if (!button || !context.canScroll || pendingDirections.has(direction)) {
    setScrollStatus("Scrollen ist nur mit einem verbundenen Online-Monitor möglich.", "failed");
    return;
  }

  const monitorId = context.monitorId;
  const operationKey = `monitor:scroll:${monitorId}:${direction}`;
  uncertainOperationKeys.delete(operationKey);
  pendingDirections.add(direction);
  clearButtonState(button);
  button.classList.add("command-sending");
  button.setAttribute("aria-busy", "true");
  setScrollStatus(`${directionLabel(direction)}: wird gesendet`, "sending");
  updateDisabledState();

  try {
    const data = await endpointData(scrollMonitor, {
      operationId: getOperationId(operationKey),
      monitorId,
      direction,
    }, "Scrollkommando konnte nicht gesendet werden");
    if (!data.commandId) throw new Error("Der Server hat keine Kommando-ID geliefert");

    commandBindings.set(commandKey(monitorId, data.commandId), { monitorId, direction, operationKey });
    trimCommandHistory(commandBindings);
    latestCommandByDirection.set(directionKey(monitorId, direction), data.commandId);
    if (data.terminalStatus) {
      applyCommandStatus({ kind: "scroll", monitorId, commandId: data.commandId, ...data.terminalStatus });
    }
    if (monitorContext.monitorId !== monitorId) {
      pendingDirections.delete(direction);
      return;
    }
    const cached = cachedStatuses.get(commandKey(monitorId, data.commandId));
    if (cached) {
      applyCommandStatus(cached);
    } else {
      clearButtonState(button);
      button.classList.add("command-pending");
      button.setAttribute("aria-busy", "true");
      setScrollStatus(`${directionLabel(direction)}: wartet`, "queued");
    }
  } catch (error) {
    releaseOperationId(operationKey, error);
    pendingDirections.delete(direction);
    clearButtonState(button);
    button.classList.add("command-failed");
    setScrollStatus(error?.message || "Scrollkommando konnte nicht gesendet werden", "failed");
  } finally {
    button.classList.remove("command-sending");
    updateDisabledState();
  }
}

for (const [direction, button] of buttons) {
  button?.addEventListener("click", () => sendScroll(direction));
}

onSelectedMonitorStatus((status) => {
  if (status?.kind === "scroll") applyCommandStatus(status);
});

onSelectedMonitorChange((context) => {
  const monitorChanged = context.monitorId !== selectedMonitorId;
  monitorContext = context;
  selectedMonitorId = context.monitorId;
  if (monitorChanged) {
    pendingDirections.clear();
    clearAllButtonStates();
    setScrollStatus(context.monitorId ? "Scroll: bereit" : "Scroll: kein Monitor", "idle");
  } else if (!context.online || !context.connected) {
    pendingDirections.clear();
    clearAllButtonStates();
    setScrollStatus(context.connected ? "Scroll: Monitor offline" : "Scroll: Verbindung unterbrochen", "failed");
  }
  updateDisabledState();
});
