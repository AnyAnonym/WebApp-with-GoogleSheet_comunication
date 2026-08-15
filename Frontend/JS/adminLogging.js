import { getUser, ready, subscribeAuth } from "./authClient.js";
import { diagnostic } from "./diagnostics.js";

const API_PATH = "/api/admin/frontend-logging";
const LEVELS = new Set(["error", "warn", "info", "debug"]);
const settingFields = [
  "enabled",
  "level",
  "includeAnonymous",
  "sampleRatePercent",
  "batchSize",
  "flushIntervalMs",
  "defaultTargetLevel",
  "defaultTargetDurationMinutes",
  "normalRetentionDays",
  "targetedRetentionDays",
];

let snapshot = null;
let authorized = false;
let busy = false;
let loadGeneration = 0;
let remainingTimer = null;

function element(id) {
  return document.getElementById(id);
}

function setStatus(message = "", state = "") {
  const status = element("logging-status");
  if (!status) return;
  status.textContent = message;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

function setBusy(nextBusy) {
  busy = nextBusy;
  document.querySelectorAll("#logging-app button, #logging-app input, #logging-app select").forEach((control) => {
    control.disabled = nextBusy;
  });
}

function accessMessage(user, authState) {
  if (authState.status === "loading") return "Sitzung wird geprüft...";
  if (authState.status === "unavailable") return "Die Anmeldung ist derzeit nicht erreichbar. Bitte später erneut versuchen.";
  if (!user) return "Bitte anmelden. Diese Seite ist ausschließlich für Administratoren verfügbar.";
  return "Ihr Konto besitzt keine Administratorrechte für diese Seite.";
}

function showAccess(user, authState) {
  authorized = false;
  loadGeneration += 1;
  snapshot = null;
  stopRemainingTimer();
  element("logging-app").hidden = true;
  element("logging-access").hidden = false;
  element("logging-access-message").textContent = accessMessage(user, authState);
  setStatus();
}

async function requestJson(path, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error("Die Anfrage hat zu lange gedauert.");
      timeoutError.code = "HTTP_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }

  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.success === false) {
    const error = new Error(body?.error?.message || "Die Anfrage ist fehlgeschlagen.");
    error.code = body?.error?.code || (body ? "HTTP_ERROR" : "INVALID_RESPONSE");
    error.status = response.status;
    error.supportId = body?.supportId;
    throw error;
  }
  return body;
}

function errorMessage(error) {
  const message = typeof error?.message === "string" && error.message
    ? error.message
    : "Der Vorgang ist fehlgeschlagen.";
  return error?.supportId ? `${message} (Referenz: ${error.supportId})` : message;
}

function isRevisionConflict(error) {
  return error?.status === 409 || /REVISION|CONFLICT/.test(error?.code || "");
}

function assertSnapshot(data) {
  if (
    data?.success !== true
    || !data.settings
    || !Number.isInteger(data.settings.revision)
    || !Number.isInteger(data.targetsRevision)
    || !Array.isArray(data.targets)
    || !Array.isArray(data.players)
  ) {
    const error = new Error("Der Server hat unvollständige Loggingdaten geliefert.");
    error.code = "INVALID_RESPONSE";
    throw error;
  }
  return data;
}

function setInputValue(id, value) {
  const input = element(id);
  if (input) input.value = String(value);
}

function populateSettings(settings) {
  element("logging-enabled").checked = Boolean(settings.enabled);
  setInputValue("logging-level", settings.level);
  element("logging-anonymous").checked = Boolean(settings.includeAnonymous);
  setInputValue("logging-sample-rate", settings.sampleRatePercent);
  setInputValue("logging-batch-size", settings.batchSize);
  setInputValue("logging-flush-interval", settings.flushIntervalMs);
  setInputValue("logging-normal-retention", settings.normalRetentionDays);
  setInputValue("logging-targeted-retention", settings.targetedRetentionDays);
  setInputValue("logging-default-target-level", settings.defaultTargetLevel);
  setInputValue("logging-default-target-duration", settings.defaultTargetDurationMinutes);

  const maximum = settings.maxTargetDurationMinutes;
  const defaultDuration = element("logging-default-target-duration");
  const targetDuration = element("logging-target-duration");
  if (Number.isInteger(maximum) && maximum > 0) {
    defaultDuration.max = String(maximum);
    targetDuration.max = String(maximum);
    element("logging-duration-limit").textContent = `Maximal ${maximum} Minuten`;
  } else {
    defaultDuration.removeAttribute("max");
    targetDuration.removeAttribute("max");
    element("logging-duration-limit").textContent = "";
  }
  setInputValue("logging-target-level", settings.defaultTargetLevel);
  setInputValue("logging-target-duration", settings.defaultTargetDurationMinutes);
}

function populatePlayers(players) {
  const select = element("logging-target-person");
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = players.length ? "Spieler auswählen" : "Keine Spieler verfügbar";
  select.replaceChildren(placeholder);

  const sortedPlayers = [...players].sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""), "de"));
  for (const player of sortedPlayers) {
    if (typeof player?.id !== "string" || !player.id) continue;
    const option = document.createElement("option");
    option.value = player.id;
    option.textContent = `${player.name || "Unbenannt"} (${player.id})`;
    select.append(option);
  }
}

function appendCell(row, label, value, className = "") {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  cell.textContent = value;
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unbekannt";
  return new Intl.DateTimeFormat("de-AT", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

function formatRemaining(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days} T ${hours} Std ${minutes} Min`;
  if (hours > 0) return `${hours} Std ${minutes} Min`;
  if (minutes > 0) return `${minutes} Min ${seconds} Sek`;
  return totalSeconds > 0 ? `${seconds} Sek` : "Abgelaufen";
}

function updateRemainingTimes() {
  document.querySelectorAll("[data-logging-deadline]").forEach((cell) => {
    const deadline = Number(cell.dataset.loggingDeadline);
    cell.textContent = Number.isFinite(deadline) ? formatRemaining(deadline - Date.now()) : "Unbekannt";
  });
}

function stopRemainingTimer() {
  if (remainingTimer !== null) window.clearInterval(remainingTimer);
  remainingTimer = null;
}

function startRemainingTimer() {
  stopRemainingTimer();
  updateRemainingTimes();
  remainingTimer = window.setInterval(updateRemainingTimes, 1000);
}

function renderTargets(targets) {
  const list = element("logging-target-list");
  list.replaceChildren();

  for (const target of targets) {
    const row = document.createElement("tr");
    appendCell(row, "Name", target?.name || "Unbekannt");
    appendCell(row, "ID", target?.personId || "-");
    appendCell(row, "Rolle", target?.role || "-");
    appendCell(row, "Level", LEVELS.has(target?.level) ? target.level : "-", "logging-level-badge");

    const remainingCell = appendCell(row, "Restzeit", "Unbekannt");
    const remaining = Number(target?.remainingMs);
    if (Number.isFinite(remaining)) remainingCell.dataset.loggingDeadline = String(Date.now() + Math.max(0, remaining));

    appendCell(row, "Ablauf", formatDate(target?.expiresAt));
    const creator = target?.createdByName || target?.createdBy || "Unbekannt";
    appendCell(row, "Ersteller", creator);

    const actionCell = document.createElement("td");
    actionCell.dataset.label = "Aktion";
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "logging-remove-button";
    removeButton.dataset.personId = target?.personId || "";
    removeButton.textContent = "Entfernen";
    removeButton.disabled = busy || !target?.personId;
    actionCell.append(removeButton);
    row.append(actionCell);
    list.append(row);
  }

  element("logging-target-empty").hidden = targets.length > 0;
  element("logging-target-table-wrap").hidden = targets.length === 0;
  element("logging-target-count").textContent = `${targets.length} aktiv`;
  if (targets.length) startRemainingTimer();
  else stopRemainingTimer();
}

function renderSnapshot(data) {
  snapshot = data;
  populateSettings(data.settings);
  populatePlayers(data.players);
  renderTargets(data.targets);
}

async function loadData({ silent = false } = {}) {
  if (!authorized) return;
  const generation = ++loadGeneration;
  if (!silent) setStatus("Loggingkonfiguration wird geladen...", "loading");
  setBusy(true);
  try {
    const data = assertSnapshot(await requestJson(API_PATH));
    if (!authorized || generation !== loadGeneration) return;
    renderSnapshot(data);
    if (!silent) setStatus("Loggingkonfiguration ist aktuell.", "success");
  } catch (error) {
    if (!authorized || generation !== loadGeneration) return;
    setStatus(errorMessage(error), "error");
    diagnostic.error("admin_logging_load_failed", error);
  } finally {
    if (authorized && generation === loadGeneration) setBusy(false);
  }
}

function integerValue(id) {
  const value = Number(element(id).value);
  return Number.isInteger(value) ? value : NaN;
}

function settingsPayload() {
  return {
    enabled: element("logging-enabled").checked,
    level: element("logging-level").value,
    includeAnonymous: element("logging-anonymous").checked,
    sampleRatePercent: integerValue("logging-sample-rate"),
    batchSize: integerValue("logging-batch-size"),
    flushIntervalMs: integerValue("logging-flush-interval"),
    defaultTargetLevel: element("logging-default-target-level").value,
    defaultTargetDurationMinutes: integerValue("logging-default-target-duration"),
    normalRetentionDays: integerValue("logging-normal-retention"),
    targetedRetentionDays: integerValue("logging-targeted-retention"),
  };
}

async function handleRevisionConflict(error) {
  if (!isRevisionConflict(error)) return false;
  setStatus("Die Konfiguration wurde zwischenzeitlich geändert und wird neu geladen.", "error");
  await loadData();
  return true;
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!authorized || busy || !snapshot || !form.reportValidity()) return;
  const payload = settingsPayload();
  if (!settingFields.every((field) => Object.hasOwn(payload, field))) return;

  setBusy(true);
  setStatus("Einstellungen werden gespeichert...", "loading");
  try {
    await requestJson(API_PATH, {
      method: "POST",
      body: JSON.stringify({ ...payload, expectedRevision: snapshot.settings.revision }),
    });
    setBusy(false);
    await loadData({ silent: true });
    setStatus("Einstellungen wurden gespeichert.", "success");
  } catch (error) {
    setBusy(false);
    if (await handleRevisionConflict(error)) return;
    setStatus(errorMessage(error), "error");
    diagnostic.error("admin_logging_settings_save_failed", error);
  }
}

async function addTarget(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!authorized || busy || !snapshot || !form.reportValidity()) return;
  const personId = element("logging-target-person").value;
  const level = element("logging-target-level").value;
  const durationMinutes = integerValue("logging-target-duration");

  setBusy(true);
  setStatus("Diagnoseziel wird aktiviert...", "loading");
  try {
    await requestJson(`${API_PATH}/targets`, {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: snapshot.targetsRevision,
        personId,
        level,
        durationMinutes,
      }),
    });
    setBusy(false);
    await loadData({ silent: true });
    setStatus("Diagnoseziel wurde aktiviert.", "success");
  } catch (error) {
    setBusy(false);
    if (await handleRevisionConflict(error)) return;
    setStatus(errorMessage(error), "error");
    diagnostic.error("admin_logging_target_add_failed", error);
  }
}

async function removeTarget(personId) {
  if (!authorized || busy || !snapshot || !personId) return;
  setBusy(true);
  setStatus("Diagnoseziel wird entfernt...", "loading");
  try {
    await requestJson(`${API_PATH}/targets`, {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision: snapshot.targetsRevision, personId }),
    });
    setBusy(false);
    await loadData({ silent: true });
    setStatus("Diagnoseziel wurde entfernt.", "success");
  } catch (error) {
    setBusy(false);
    if (await handleRevisionConflict(error)) return;
    setStatus(errorMessage(error), "error");
    diagnostic.error("admin_logging_target_remove_failed", error);
  }
}

function handleTargetListClick(event) {
  const button = event.target instanceof Element ? event.target.closest("button[data-person-id]") : null;
  if (!(button instanceof HTMLButtonElement)) return;
  removeTarget(button.dataset.personId || "");
}

function applyAuth(user, authState) {
  if (user?.role !== "admin" || authState.status !== "authenticated") {
    showAccess(user, authState);
    return;
  }
  if (authorized) return;
  authorized = true;
  element("logging-access").hidden = true;
  element("logging-app").hidden = false;
  loadData();
}

function bindEvents() {
  element("logging-settings-form").addEventListener("submit", saveSettings);
  element("logging-target-form").addEventListener("submit", addTarget);
  element("logging-target-list").addEventListener("click", handleTargetListClick);
  element("logging-reload").addEventListener("click", () => loadData());
  window.addEventListener("pagehide", stopRemainingTimer, { once: true });
}

async function initialize() {
  bindEvents();
  subscribeAuth(applyAuth);
  await ready;
  const user = getUser();
  if (user?.role === "admin" && !authorized) applyAuth(user, { status: "authenticated" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}
