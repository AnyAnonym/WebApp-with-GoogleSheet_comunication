import { ready, subscribeAuth } from "./authClient.js";
import {
  createEndpoint,
  getOperationId,
  releaseOperationId,
} from "./dataClient.js";
import { diagnostic } from "./diagnostics.js";

const readSheetDataStatus = createEndpoint("sheetDataStatus");
const refreshSheetData = createEndpoint("refreshSheetData");
const REFRESH_OPERATION_KEY = "refreshSheetData";
const STATUS_POLL_MS = 2000;
const AGE_UPDATE_MS = 30000;
const SUPPORT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

let authorized = false;
let busy = false;
let generation = 0;
let snapshot = null;
let snapshotReceivedAt = 0;
let pollTimer = null;
let ageTimer = null;

function element(id) {
  return document.getElementById(id);
}

function parseTimestamp(value, field) {
  if (value === null) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw invalidResponse(field);
  return timestamp;
}

function invalidResponse(field) {
  const error = new Error("Der Server hat unvollständige Datenstatusinformationen geliefert.");
  error.code = "INVALID_RESPONSE";
  error.field = field;
  return error;
}

function normalizeFailure(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || typeof value.message !== "string" || !value.message.trim()) {
    throw invalidResponse("lastControlledFailure");
  }
  const supportId = value.supportId == null ? null : String(value.supportId);
  return {
    at: parseTimestamp(value.at, "lastControlledFailure.at"),
    message: value.message.trim(),
    supportId: supportId && SUPPORT_ID_PATTERN.test(supportId) ? supportId : null,
  };
}

function normalizeSnapshot(data) {
  if (data?.success !== true || !(data.inProgress === null || typeof data.inProgress === "object")) {
    throw invalidResponse("status");
  }
  const dataAgeMs = data.dataAgeMs === null ? null : Number(data.dataAgeMs);
  if (dataAgeMs !== null && (!Number.isFinite(dataAgeMs) || dataAgeMs < 0)) throw invalidResponse("dataAgeMs");

  let inProgress = null;
  if (data.inProgress) {
    inProgress = { startedAt: parseTimestamp(data.inProgress.startedAt, "inProgress.startedAt") };
  }
  return {
    lastSuccessfulRefreshAt: parseTimestamp(data.lastSuccessfulRefreshAt, "lastSuccessfulRefreshAt"),
    dataAgeMs,
    inProgress,
    bootstrapRecoveryActive: data.bootstrapRecoveryActive === true,
    lastControlledFailure: normalizeFailure(data.lastControlledFailure),
  };
}

function formatDate(timestamp) {
  if (timestamp === null) return "Noch keine erfolgreiche Aktualisierung";
  return new Intl.DateTimeFormat("de-AT", { dateStyle: "medium", timeStyle: "medium" }).format(timestamp);
}

function formatAge(milliseconds) {
  if (milliseconds === null) return "Nicht verfügbar";
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60000));
  if (totalMinutes < 1) return "Weniger als eine Minute";
  if (totalMinutes < 60) return `${totalMinutes} ${totalMinutes === 1 ? "Minute" : "Minuten"}`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours} Std. ${minutes} Min.` : `${hours} Std.`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days} T. ${remainingHours} Std.` : `${days} ${days === 1 ? "Tag" : "Tage"}`;
}

function errorMessage(error) {
  const message = typeof error?.message === "string" && error.message ? error.message : "Der Vorgang ist fehlgeschlagen.";
  return error?.supportId && !message.includes(error.supportId) ? `${message} (Referenz: ${error.supportId})` : message;
}

function setFeedback(message = "", state = "") {
  const feedback = element("service-feedback");
  feedback.textContent = message;
  if (state) feedback.dataset.state = state;
  else delete feedback.dataset.state;
}

function setBusy(nextBusy) {
  busy = nextBusy;
  const button = element("service-refresh");
  button.disabled = nextBusy || Boolean(snapshot?.inProgress) || !authorized;
  button.setAttribute("aria-busy", String(nextBusy));
}

function stopTimers() {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  if (ageTimer !== null) window.clearInterval(ageTimer);
  pollTimer = null;
  ageTimer = null;
}

function renderAge() {
  if (!snapshot) return;
  const elapsed = Math.max(0, Date.now() - snapshotReceivedAt);
  element("service-data-age").textContent = formatAge(snapshot.dataAgeMs === null ? null : snapshot.dataAgeMs + elapsed);
}

function renderSnapshot() {
  if (!snapshot) return;
  element("service-last-success").textContent = formatDate(snapshot.lastSuccessfulRefreshAt);
  renderAge();

  const progress = element("service-progress");
  progress.hidden = !snapshot.inProgress;
  if (snapshot.inProgress) {
    element("service-progress-detail").textContent = `Gestartet am ${formatDate(snapshot.inProgress.startedAt)}. Der Status wird automatisch aktualisiert.`;
  }

  const failure = element("service-failure");
  failure.hidden = !snapshot.lastControlledFailure;
  if (snapshot.lastControlledFailure) {
    element("service-failure-message").textContent = snapshot.lastControlledFailure.message;
    element("service-failure-time").textContent = `Aufgetreten am ${formatDate(snapshot.lastControlledFailure.at)}`;
    const support = element("service-failure-support");
    support.hidden = !snapshot.lastControlledFailure.supportId;
    support.textContent = snapshot.lastControlledFailure.supportId
      ? `Support-ID: ${snapshot.lastControlledFailure.supportId}`
      : "";
  }

  const badge = element("service-state-badge");
  const recovering = snapshot.bootstrapRecoveryActive && snapshot.lastSuccessfulRefreshAt === null;
  badge.textContent = snapshot.inProgress ? "Aktualisierung läuft" : recovering ? "Startimport wird wiederholt" : "Bereit";
  badge.dataset.state = snapshot.inProgress || recovering ? "busy" : "ready";
  setBusy(busy);
}

function schedulePoll() {
  if (!authorized || !snapshot?.inProgress || pollTimer !== null) return;
  pollTimer = window.setTimeout(() => {
    pollTimer = null;
    loadStatus({ quiet: true });
  }, STATUS_POLL_MS);
}

async function loadStatus({ quiet = false } = {}) {
  if (!authorized) return false;
  const requestGeneration = generation;
  if (!quiet) setFeedback("Datenstatus wird geladen...", "loading");
  try {
    const response = await readSheetDataStatus();
    if (!authorized || requestGeneration !== generation) return false;
    snapshot = normalizeSnapshot(response.data);
    snapshotReceivedAt = Date.now();
    renderSnapshot();
    if (!quiet) setFeedback("Datenstatus ist aktuell.", "success");
    schedulePoll();
    return true;
  } catch (error) {
    if (!authorized || requestGeneration !== generation) return false;
    if (!quiet) setFeedback(errorMessage(error), "error");
    diagnostic.error("sheet_data_status_load_failed", error);
    schedulePoll();
    return false;
  }
}

async function startRefresh() {
  if (!authorized || busy || snapshot?.inProgress) return;
  const requestGeneration = generation;
  let operationError = null;
  setBusy(true);
  setFeedback("Sheet-Daten werden aktualisiert...", "loading");
  try {
    await refreshSheetData({ operationId: getOperationId(REFRESH_OPERATION_KEY) });
    if (!authorized || requestGeneration !== generation) return;
    releaseOperationId(REFRESH_OPERATION_KEY);
    await loadStatus({ quiet: true });
    if (!authorized || requestGeneration !== generation) return;
    setFeedback("Die Sheet-Daten wurden erfolgreich aktualisiert.", "success");
  } catch (error) {
    operationError = error;
    releaseOperationId(REFRESH_OPERATION_KEY, error);
    if (!authorized || requestGeneration !== generation) return;
    await loadStatus({ quiet: true });
    if (!authorized || requestGeneration !== generation) return;
    setFeedback(errorMessage(error), "error");
    diagnostic.error("sheet_data_refresh_failed", error);
  } finally {
    if (authorized && requestGeneration === generation) setBusy(false);
  }
  return operationError === null;
}

function accessMessage(user, authState) {
  if (authState.status === "loading") return "Sitzung wird geprüft...";
  if (authState.status === "unavailable") return "Die Anmeldung ist derzeit nicht erreichbar. Bitte später erneut versuchen.";
  if (!user) return "Bitte anmelden. Diese Seite ist ausschließlich für Administratoren verfügbar.";
  return "Ihr Konto besitzt keine Administratorrechte für diese Seite.";
}

function showAccess(user, authState) {
  authorized = false;
  generation += 1;
  busy = false;
  snapshot = null;
  stopTimers();
  element("service-refresh").disabled = true;
  element("service-app").hidden = true;
  element("service-access").hidden = false;
  element("service-access-message").textContent = accessMessage(user, authState);
  setFeedback();
}

function applyAuth(user, authState) {
  if (user?.role !== "admin" || authState.status !== "authenticated") {
    showAccess(user, authState);
    return;
  }
  if (authorized) return;
  authorized = true;
  generation += 1;
  element("service-access").hidden = true;
  element("service-app").hidden = false;
  setBusy(false);
  ageTimer = window.setInterval(renderAge, AGE_UPDATE_MS);
  loadStatus();
}

element("service-refresh").addEventListener("click", startRefresh);
subscribeAuth(applyAuth);
window.addEventListener("pagehide", stopTimers);
window.addEventListener("pageshow", (event) => {
  if (!event.persisted || !authorized) return;
  if (ageTimer === null) ageTimer = window.setInterval(renderAge, AGE_UPDATE_MS);
  loadStatus({ quiet: true });
});
ready.catch((error) => diagnostic.error("service_area_auth_failed", error));
