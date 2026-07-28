import {
  createEndpoint,
  onConnectionState,
  onResync,
  restartConnection,
  subscribe,
} from "./dataClient.js";

const readMonitorTarget = createEndpoint("monitorTarget");
const acknowledgeMonitor = createEndpoint("monitorAck");
const LOAD_TIMEOUT_MS = 20000;
const PREFLIGHT_TIMEOUT_MS = 8000;
const MAX_APPLIED_SCROLL_IDS = 200;
const MAX_SCROLL_STREAMS = 20;
const APPLIED_SCROLL_STORAGE_KEY = "epiberMonitorAppliedScrolls";

const stage = document.getElementById("monitor-stage");
const overlay = document.getElementById("monitor-overlay");
const enrollment = document.getElementById("monitor-enrollment");
const enrollmentForm = document.getElementById("monitor-enrollment-form");
const tokenInput = document.getElementById("monitor-token-input");
const enrollmentStatus = document.getElementById("monitor-enrollment-status");
const disconnectButton = document.getElementById("monitor-disconnect");

let device = null;
let activeFrame = null;
let activeCommandId = "";
let navigationJob = null;
let sessionRequest = null;
let queuedNavigation = null;
let queuedScrollCommands = [];
let scrollChain = Promise.resolve();
let connectionSnapshot = { state: "idle", connected: false };

const appliedScrollIds = new Map();
const highestScrollSequence = new Map();

function persistAppliedScrolls() {
  if (!device) return;
  try {
    localStorage.setItem(APPLIED_SCROLL_STORAGE_KEY, JSON.stringify({
      monitorId: device.id,
      entries: [...appliedScrollIds].map(([commandId, value]) => [commandId, value]),
    }));
  } catch {
    // Persistence is best effort; in-memory deduplication remains active.
  }
}

function restoreAppliedScrolls() {
  appliedScrollIds.clear();
  if (!device) return;
  try {
    const stored = JSON.parse(localStorage.getItem(APPLIED_SCROLL_STORAGE_KEY) || "null");
    if (stored?.monitorId !== device.id || !Array.isArray(stored.entries)) return;
    for (const entry of stored.entries.slice(-MAX_APPLIED_SCROLL_IDS)) {
      if (!Array.isArray(entry) || !validIdentifier(entry[0]) || !entry[1] || typeof entry[1] !== "object") continue;
      if (Number(entry[1].expiresAt) <= Date.now()) continue;
      appliedScrollIds.set(entry[0], entry[1]);
    }
  } catch {
    try { localStorage.removeItem(APPLIED_SCROLL_STORAGE_KEY); } catch {}
  }
}

function setConnectionText(message, state) {
  const node = document.getElementById("monitor-connection");
  if (!node) return;
  node.textContent = message;
  node.dataset.state = state;
}

function renderConnection() {
  const labels = {
    connected: device ? `Verbunden: ${device.label}` : "Verbindung hergestellt",
    connecting: "Verbindung wird hergestellt",
    backoff: "Verbindung wird wiederhergestellt",
    stale: "Verbindung ist veraltet",
    offline: "Browser offline",
    idle: "Nicht verbunden",
    stopped: "Verbindung beendet",
  };
  setConnectionText(labels[connectionSnapshot.state] || "Nicht verbunden", connectionSnapshot.state);
}

function setOverlay(message = "", state = "info") {
  if (!overlay) return;
  overlay.textContent = message;
  overlay.dataset.state = state;
  overlay.hidden = !message;
  overlay.classList.toggle("monitor-overlay-empty", !activeFrame);
}

function setEnrollmentStatus(message = "", state = "info") {
  if (!enrollmentStatus) return;
  enrollmentStatus.textContent = message;
  enrollmentStatus.dataset.state = state;
}

function setDevice(nextDevice) {
  const id = String(nextDevice?.id || nextDevice?.monitorId || "").trim();
  if (!id) return false;
  const changed = device?.id !== id;
  device = { id, label: String(nextDevice?.label || id) };
  if (changed) restoreAppliedScrolls();
  if (enrollment) enrollment.hidden = true;
  const bar = document.getElementById("monitor-device-bar");
  if (bar) bar.hidden = false;
  const label = document.getElementById("monitor-device-label");
  if (label) label.textContent = device.label;
  renderConnection();
  flushQueuedCommands();
  return true;
}

function cancelNavigationJob() {
  const job = navigationJob;
  if (!job) return;
  job.cancelled = true;
  clearTimeout(job.timeoutId);
  job.controller.abort();
  job.frame?.remove();
  navigationJob = null;
}

function clearDevice({ removeFrame = true } = {}) {
  device = null;
  cancelNavigationJob();
  queuedNavigation = null;
  queuedScrollCommands = [];
  appliedScrollIds.clear();
  highestScrollSequence.clear();
  try { localStorage.removeItem(APPLIED_SCROLL_STORAGE_KEY); } catch {}
  if (removeFrame) {
    activeFrame?.remove();
    activeFrame = null;
    activeCommandId = "";
  }
  const bar = document.getElementById("monitor-device-bar");
  if (bar) bar.hidden = true;
  if (enrollment) enrollment.hidden = false;
  renderConnection();
  setOverlay("Monitor ist noch nicht provisioniert.", "waiting");
}

function httpError(body, fallback) {
  const error = new Error(body?.error?.message || fallback);
  error.code = body?.error?.code || "HTTP_ERROR";
  return error;
}

async function monitorSession(method = "GET", body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch("/api/monitor/session", {
      method,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw Object.assign(new Error("Monitor-Sitzungsanfrage hat zu lange gedauert"), { code: "HTTP_TIMEOUT" });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw httpError(data, "Monitor-Sitzung konnte nicht verarbeitet werden");
  return data;
}

async function checkMonitorSession() {
  if (sessionRequest) return sessionRequest;
  sessionRequest = (async () => {
    try {
      const data = await monitorSession();
      if (data.authenticated && data.monitor) {
        setDevice(data.monitor);
        setEnrollmentStatus("");
        if (!activeFrame) setOverlay("Warte auf Navigation...", "waiting");
      } else {
        clearDevice();
      }
      return data;
    } catch (error) {
      if (!device) {
        if (enrollment) enrollment.hidden = false;
        setEnrollmentStatus(error?.message || "Monitor-Sitzung konnte nicht geprüft werden", "error");
      }
      return null;
    } finally {
      sessionRequest = null;
    }
  })();
  return sessionRequest;
}

function validIdentifier(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function boundedErrorCode(value, fallback = "LOAD_FAILED") {
  if (typeof value === "string" && value.length >= 1 && value.length <= 64 && /^[A-Z0-9_]+$/.test(value)) return value;
  return fallback;
}

function backendError(data, fallback) {
  const error = new Error(data?.error?.message || fallback);
  error.code = data?.error?.code || "REQUEST_FAILED";
  return error;
}

async function sendAcknowledgement(payload) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await acknowledgeMonitor(payload);
      if (!response?.data || response.data.success === false) {
        throw backendError(response?.data, "Monitor-ACK wurde abgelehnt");
      }
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  console.warn("Monitor-ACK konnte nicht bestätigt werden:", lastError?.code || lastError?.message);
  return false;
}

function validateTargetPath(rawPath, commandId) {
  if (typeof rawPath !== "string" || rawPath.length < 1 || rawPath.length > 512) {
    throw Object.assign(new Error("Monitorziel ist ungültig"), { code: "PATH_INVALID" });
  }
  if (!rawPath.startsWith("/") || rawPath.startsWith("//") || /[\x00-\x1f\\#]/.test(rawPath)) {
    throw Object.assign(new Error("Monitorziel ist nicht lokal"), { code: "PATH_FORBIDDEN" });
  }
  const rawPathname = rawPath.split("?", 1)[0];
  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(rawPathname);
  } catch {
    throw Object.assign(new Error("Monitorziel ist ungültig codiert"), { code: "PATH_INVALID" });
  }
  if (decodedPathname.split("/").some((part) => part === "." || part === "..") || /%2f|%5c/i.test(rawPathname)) {
    throw Object.assign(new Error("Monitorziel enthält unzulässige Pfadsegmente"), { code: "PATH_FORBIDDEN" });
  }

  let url;
  try {
    url = new URL(rawPath, window.location.origin);
  } catch {
    throw Object.assign(new Error("Monitorziel ist ungültig"), { code: "PATH_INVALID" });
  }
  if (url.origin !== window.location.origin || url.username || url.password || url.hash) {
    throw Object.assign(new Error("Monitorziel ist nicht gleicher Herkunft"), { code: "PATH_FORBIDDEN" });
  }
  url.searchParams.set("monitor", "1");
  url.searchParams.set("_command", commandId);
  url.searchParams.set("_t", String(Date.now()));
  return url;
}

async function preflightCandidate(job, url) {
  const remaining = Math.max(1, job.deadline - Date.now());
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    job.controller.abort();
  }, Math.min(PREFLIGHT_TIMEOUT_MS, remaining));
  try {
    const response = await fetch(url.href, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: job.controller.signal,
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Monitorziel antwortet mit HTTP ${response.status}`), { code: "PREFLIGHT_HTTP" });
    }
    const contentType = response.headers.get("Content-Type") || "";
    if (contentType && !contentType.toLowerCase().includes("text/html")) {
      throw Object.assign(new Error("Monitorziel ist keine HTML-Seite"), { code: "PREFLIGHT_CONTENT" });
    }
    if (response.body) response.body.cancel().catch(() => {});
  } catch (error) {
    if (job.cancelled) throw error;
    if (timedOut) throw Object.assign(new Error("Vorprüfung des Monitorziels hat zu lange gedauert"), { code: "PREFLIGHT_TIMEOUT" });
    if (error?.code) throw error;
    throw Object.assign(new Error("Monitorziel konnte nicht vorab geladen werden"), { code: "PREFLIGHT_FAILED" });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function failNavigation(job, code, message) {
  if (!job || job.finished || job.cancelled) return;
  job.finished = true;
  clearTimeout(job.timeoutId);
  job.controller.abort();
  job.frame?.remove();
  if (navigationJob === job) navigationJob = null;
  const errorCode = boundedErrorCode(code);
  setOverlay(message || `Navigation fehlgeschlagen (${errorCode})`, "failed");
  await sendAcknowledgement({
    kind: "navigate",
    commandId: job.commandId,
    status: "failed",
    errorCode,
  });
}

async function finishNavigation(job) {
  if (!job || job.finished || job.cancelled || !job.frameLoaded || !job.appReady) return;
  const acknowledged = await sendAcknowledgement({ kind: "navigate", commandId: job.commandId, status: "loaded" });
  if (!acknowledged || job.finished || job.cancelled || navigationJob !== job) {
    if (!job.finished && !job.cancelled) await failNavigation(job, "ACK_FAILED", "Monitorstatus konnte nicht bestaetigt werden.");
    return;
  }
  job.finished = true;
  clearTimeout(job.timeoutId);
  if (navigationJob === job) navigationJob = null;

  const previousFrame = activeFrame;
  previousFrame?.removeAttribute("id");
  job.frame.classList.remove("monitor-frame-candidate");
  job.frame.classList.add("monitor-frame-active");
  job.frame.id = "monitor-frame";
  job.frame.title = "Monitorinhalt";
  job.frame.setAttribute("aria-hidden", "false");
  activeFrame = job.frame;
  activeCommandId = job.commandId;
  previousFrame?.remove();
  setOverlay("");
}

function createCandidateFrame(job, url) {
  const frame = document.createElement("iframe");
  frame.className = "monitor-frame monitor-frame-candidate";
  frame.title = "Monitorinhalt wird geladen";
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.referrerPolicy = "same-origin";
  frame.addEventListener("load", () => {
    if (job.finished || job.cancelled || navigationJob !== job) return;
    try {
      const loadedUrl = new URL(frame.contentWindow.location.href);
      if (
        loadedUrl.origin !== window.location.origin
        || loadedUrl.pathname !== url.pathname
        || loadedUrl.searchParams.get("monitor") !== "1"
        || loadedUrl.searchParams.get("_command") !== job.commandId
      ) {
        failNavigation(job, "FRAME_LOCATION_INVALID", "Monitorziel hat die Seite unerwartet gewechselt.");
        return;
      }
    } catch {
      failNavigation(job, "FRAME_ORIGIN_INVALID", "Monitorziel hat die Herkunft gewechselt.");
      return;
    }
    job.frameLoaded = true;
    finishNavigation(job);
  });
  frame.addEventListener("error", () => {
    failNavigation(job, "FRAME_LOAD_FAILED", "Monitorziel konnte nicht geladen werden.");
  });
  frame.src = url.href;
  job.frame = frame;
  stage?.appendChild(frame);
}

async function beginNavigation(command) {
  if (!device || command.monitorId !== device.id) return;
  if (!validIdentifier(command.commandId)) return;

  if (command.commandId === activeCommandId && activeFrame) {
    await sendAcknowledgement({ kind: "navigate", commandId: command.commandId, status: "loaded" });
    return;
  }
  if (navigationJob?.commandId === command.commandId) {
    const status = navigationJob.phase === "loading" ? "loading" : "received";
    await sendAcknowledgement({ kind: "navigate", commandId: command.commandId, status });
    return;
  }

  cancelNavigationJob();
  const job = {
    commandId: command.commandId,
    monitorId: command.monitorId,
    deadline: Date.now() + LOAD_TIMEOUT_MS,
    controller: new AbortController(),
    timeoutId: null,
    frame: null,
    frameLoaded: false,
    appReady: false,
    phase: "received",
    finished: false,
    cancelled: false,
  };
  navigationJob = job;
  job.timeoutId = setTimeout(() => {
    failNavigation(job, "LOAD_TIMEOUT", "Monitorziel war nach 20 Sekunden nicht bereit.");
  }, LOAD_TIMEOUT_MS);
  setOverlay("Navigationsbefehl empfangen...", "received");

  const received = await sendAcknowledgement({ kind: "navigate", commandId: job.commandId, status: "received" });
  if (!received || job.finished || job.cancelled || navigationJob !== job) {
    if (navigationJob === job) cancelNavigationJob();
    return;
  }

  let url;
  try {
    url = validateTargetPath(command.path, command.commandId);
    await preflightCandidate(job, url);
  } catch (error) {
    if (!job.cancelled && !job.finished) {
      await failNavigation(job, boundedErrorCode(error?.code, "PREFLIGHT_FAILED"), error?.message);
    }
    return;
  }
  if (job.finished || job.cancelled || navigationJob !== job) return;

  job.phase = "loading";
  const loading = await sendAcknowledgement({ kind: "navigate", commandId: job.commandId, status: "loading" });
  if (!loading || job.finished || job.cancelled || navigationJob !== job) {
    if (navigationJob === job) cancelNavigationJob();
    return;
  }
  setOverlay("Neues Monitorziel wird vorbereitet...", "loading");
  createCandidateFrame(job, url);
}

function rememberAppliedScroll(commandId, status, errorCode) {
  appliedScrollIds.set(commandId, { status, errorCode, expiresAt: Date.now() + 5 * 60 * 1000 });
  if (appliedScrollIds.size > MAX_APPLIED_SCROLL_IDS) {
    appliedScrollIds.delete(appliedScrollIds.keys().next().value);
  }
  persistAppliedScrolls();
}

async function applyScroll(command) {
  if (!device || command.monitorId !== device.id) return;
  if (!validIdentifier(command.commandId) || !validIdentifier(command.streamId)) return;
  if (!Number.isInteger(command.seq) || command.seq < 1) return;
  if (!Number.isFinite(command.deltaY) || Math.abs(command.deltaY) > 2000) return;

  const lastSequence = highestScrollSequence.get(command.streamId) || 0;
  const completed = appliedScrollIds.get(command.commandId);
  const expired = Number.isFinite(command.expiresAt) && command.expiresAt <= Date.now();
  if (completed) {
    await sendAcknowledgement({ kind: "scroll", commandId: command.commandId, status: completed.status, errorCode: completed.errorCode });
    return;
  }
  if (command.seq <= lastSequence) {
    await sendAcknowledgement({ kind: "scroll", commandId: command.commandId, status: "failed", errorCode: "STALE_SEQUENCE" });
    return;
  }
  highestScrollSequence.set(command.streamId, Math.max(lastSequence, command.seq));
  if (highestScrollSequence.size > MAX_SCROLL_STREAMS) {
    highestScrollSequence.delete(highestScrollSequence.keys().next().value);
  }
  if (expired) {
    rememberAppliedScroll(command.commandId, "failed", "COMMAND_EXPIRED");
    await sendAcknowledgement({ kind: "scroll", commandId: command.commandId, status: "failed", errorCode: "COMMAND_EXPIRED" });
    return;
  }
  const scrollBy = activeFrame?.contentWindow?.scrollBy;
  if (typeof scrollBy !== "function") {
    rememberAppliedScroll(command.commandId, "failed", "NO_ACTIVE_FRAME");
    await sendAcknowledgement({ kind: "scroll", commandId: command.commandId, status: "failed", errorCode: "NO_ACTIVE_FRAME" });
    return;
  }
  try {
    scrollBy.call(activeFrame.contentWindow, 0, command.deltaY);
  } catch (error) {
    console.warn("Monitor konnte nicht scrollen:", error?.message);
    rememberAppliedScroll(command.commandId, "failed", "SCROLL_FAILED");
    await sendAcknowledgement({ kind: "scroll", commandId: command.commandId, status: "failed", errorCode: "SCROLL_FAILED" });
    return;
  }
  rememberAppliedScroll(command.commandId, "applied");
  await sendAcknowledgement({ kind: "scroll", commandId: command.commandId, status: "applied" });
}

function handleMonitorCommand(command) {
  if (!command || (command.kind !== "navigate" && command.kind !== "scroll")) return;
  if (!device) {
    if (command.kind === "navigate") {
      queuedNavigation = command;
    } else if (queuedScrollCommands.length < 50) {
      queuedScrollCommands.push(command);
    }
    return;
  }
  if (command.monitorId !== device.id) return;
  if (command.kind === "navigate") {
    beginNavigation(command).catch((error) => {
      console.error("Navigationskommando fehlgeschlagen:", error);
    });
  } else {
    scrollChain = scrollChain.then(() => applyScroll(command)).catch((error) => {
      console.error("Scrollkommando fehlgeschlagen:", error);
    });
  }
}

function flushQueuedCommands() {
  if (!device) return;
  const navigation = queuedNavigation;
  const scrollCommands = queuedScrollCommands;
  queuedNavigation = null;
  queuedScrollCommands = [];
  if (navigation) handleMonitorCommand(navigation);
  for (const command of scrollCommands) handleMonitorCommand(command);
}

async function synchronizeTarget() {
  if (!device) return;
  try {
    const response = await readMonitorTarget();
    if (!response?.data || response.data.success === false) return;
    const target = response.data.target;
    if (target?.commandId && target?.path && target.monitorId === device.id) {
      handleMonitorCommand({ kind: "navigate", ...target, resync: true });
    } else if (!activeFrame) {
      setOverlay("Warte auf Navigation...", "waiting");
    }
  } catch (error) {
    console.warn("Monitorziel konnte nicht synchronisiert werden:", error?.message);
  }
}

async function enrollMonitor(event) {
  event.preventDefault();
  let token = tokenInput?.value.trim() || "";
  if (tokenInput) tokenInput.value = "";
  if (token.length < 32 || token.length > 128) {
    setEnrollmentStatus("Der Gerätetoken ist ungültig.", "error");
    token = "";
    return;
  }
  const submit = document.getElementById("monitor-enroll-submit");
  if (submit) submit.disabled = true;
  setEnrollmentStatus("Gerät wird angemeldet...");
  try {
    const data = await monitorSession("POST", { token });
    token = "";
    if (!setDevice(data.monitor)) throw new Error("Monitor-Antwort ist unvollständig");
    setEnrollmentStatus("");
    setOverlay("Geräteverbindung wird hergestellt...", "loading");
    restartConnection({ allowTerminal: true }).catch(() => {});
  } catch (error) {
    token = "";
    setEnrollmentStatus(error?.message || "Gerät konnte nicht angemeldet werden", "error");
    if (enrollment) enrollment.hidden = false;
  } finally {
    token = "";
    if (submit) submit.disabled = false;
  }
}

async function disconnectMonitor() {
  if (!window.confirm("Dieses Monitorgerät wirklich abmelden?")) return;
  if (disconnectButton) disconnectButton.disabled = true;
  try {
    await monitorSession("DELETE");
    clearDevice();
    setEnrollmentStatus("Gerät wurde abgemeldet.", "success");
    restartConnection({ allowTerminal: true }).catch(() => {});
  } catch (error) {
    setOverlay(error?.message || "Gerät konnte nicht abgemeldet werden", "failed");
  } finally {
    if (disconnectButton) disconnectButton.disabled = false;
  }
}

window.addEventListener("message", (event) => {
  const job = navigationJob;
  if (!job?.frame || job.finished || job.cancelled) return;
  if (event.origin !== window.location.origin || event.source !== job.frame.contentWindow) return;
  const message = event.data;
  if (!message || message.type !== "epiber-monitor-ready" || message.commandId !== job.commandId) return;
  if (message.status === "failed") {
    failNavigation(job, boundedErrorCode(message.errorCode, "APP_INIT_FAILED"), "Monitoranwendung konnte nicht gestartet werden.");
    return;
  }
  if (message.status !== "ready") return;
  job.appReady = true;
  finishNavigation(job);
});

subscribe("monitor-command", handleMonitorCommand);

onConnectionState((snapshot) => {
  connectionSnapshot = snapshot;
  renderConnection();
  if (snapshot.state === "stopped" && snapshot.closeCode === 4003) checkMonitorSession();
  if (snapshot.state === "stopped" && snapshot.closeCode === 4009) {
    setOverlay("Dieser Monitor ist bereits in einem anderen Fenster verbunden.", "failed");
  }
});

onResync(({ welcome }) => {
  if (welcome?.principal?.type === "device" && welcome.principal.monitor) {
    setDevice(welcome.principal.monitor);
    synchronizeTarget();
  } else {
    checkMonitorSession();
  }
});

enrollmentForm?.addEventListener("submit", enrollMonitor);
disconnectButton?.addEventListener("click", disconnectMonitor);
checkMonitorSession();
