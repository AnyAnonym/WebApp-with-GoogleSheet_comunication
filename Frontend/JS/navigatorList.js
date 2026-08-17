import {
  createEndpoint,
  getOperationId,
  onConnectionState,
  onResync,
  releaseOperationId,
  subscribe,
  subscribeInvalidations,
} from "./dataClient.js";
import { getUser, hasRole, ready, subscribeAuth } from "./authClient.js";
import { diagnostic } from "./diagnostics.js";

const readNavigator = createEndpoint("navigator");
const readPreMatches = createEndpoint("preMatches");
const readPlayersList = createEndpoint("players");
const readBewerbe = createEndpoint("bewerbe");
const readMonitors = createEndpoint("monitorList");
const navigateMonitor = createEndpoint("monitorNavigate");
const provisionMonitor = createEndpoint("monitorProvision");
const rotateMonitor = createEndpoint("monitorRotate");
const revokeMonitor = createEndpoint("monitorRevoke");
const assignCourt = createEndpoint("courtAssign");
const setCourtActive = createEndpoint("courtSetActive");
const readScoreboardCourts = createEndpoint("getScoreboardCourts");

const navParams = new URLSearchParams(window.location.search);
const NAV_PROFILE = navParams.get("profil") || "1";
const MAX_COMMAND_HISTORY = 200;
const navigationStatusRank = { offline: 0, sent: 0, received: 1, loading: 2, loaded: 3, failed: 3 };

let domReady = false;
let authorized = false;
let admin = false;
let connectionSnapshot = { state: "idle", connected: false };
let selectedMonitorId = "";
let monitors = new Map();
let navigatorEntries = [];
let playerMap = new Map();
let playerDetails = [];
let competitionMap = new Map();
let nextMatches = [];
let navigatorLoadGeneration = 0;
let monitorLoadGeneration = 0;
let authGeneration = 0;
let authPrincipalKey = "";
let navigationRequestInFlight = false;

const navigationBindings = new Map();
const monitorStatusCache = new Map();
const monitorSubscriptions = new Map();
const selectionListeners = new Set();
const selectedStatusListeners = new Set();

function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function clear(node) {
  if (node) node.replaceChildren();
}

function setText(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

function errorFromData(data, fallback) {
  const error = new Error(data?.error?.message || fallback);
  error.code = data?.error?.code || "REQUEST_FAILED";
  error.details = data?.error?.details;
  return error;
}

async function endpointData(endpoint, params, fallback) {
  const response = await endpoint(params);
  if (!response?.data || response.data.success === false) {
    throw errorFromData(response?.data, fallback);
  }
  return response.data;
}

function readableError(error, fallback = "Anfrage fehlgeschlagen") {
  return error?.message || fallback;
}

function showNotice(message = "", type = "info") {
  const notice = document.getElementById("navigator-notice");
  if (!notice) return;
  notice.textContent = message;
  notice.dataset.type = type;
  notice.hidden = !message;
}

function statusKey(monitorId, commandId) {
  return `${monitorId}:${commandId}`;
}

function adminOperationId(key) {
  return getOperationId(`navigator:${key}`);
}

function clearAdminOperation(key, error = null) {
  releaseOperationId(`navigator:${key}`, error);
}

function trimCommandHistory(map) {
  if (map.size > MAX_COMMAND_HISTORY) map.delete(map.keys().next().value);
}

function rememberMonitorStatus(status) {
  if (!status?.monitorId || !status?.commandId) return status;
  const key = statusKey(status.monitorId, status.commandId);
  const previous = monitorStatusCache.get(key);
  if (!previous) {
    monitorStatusCache.set(key, status);
    trimCommandHistory(monitorStatusCache);
    return status;
  }
  if (status.kind !== previous.kind) return previous;
  if (status.kind === "navigate" && status.resync) {
    monitorStatusCache.set(key, status);
    return status;
  }
  if (status.kind === "navigate") {
    const previousRank = navigationStatusRank[previous.status] ?? -1;
    const nextRank = navigationStatusRank[status.status] ?? -1;
    if (nextRank < previousRank) return previous;
  }
  monitorStatusCache.set(key, { ...previous, ...status });
  return monitorStatusCache.get(key);
}

function selectedMonitor() {
  return selectedMonitorId ? monitors.get(selectedMonitorId) || null : null;
}

export function getSelectedMonitorContext() {
  const monitor = selectedMonitor();
  const revoked = !!monitor?.revokedAt;
  return {
    monitorId: monitor?.monitorId || "",
    label: monitor?.label || "",
    online: !!monitor?.online,
    revoked,
    connected: !!connectionSnapshot.connected,
    canNavigate: !!(authorized && connectionSnapshot.connected && monitor && !revoked),
    canScroll: !!(authorized && connectionSnapshot.connected && monitor?.online && monitor?.status?.status === "loaded" && !revoked),
  };
}

export function onSelectedMonitorChange(callback) {
  selectionListeners.add(callback);
  callback(getSelectedMonitorContext());
  return () => selectionListeners.delete(callback);
}

export function onSelectedMonitorStatus(callback) {
  selectedStatusListeners.add(callback);
  return () => selectedStatusListeners.delete(callback);
}

function notifySelectionListeners() {
  const context = getSelectedMonitorContext();
  for (const listener of selectionListeners) {
    try {
      listener(context);
    } catch (error) {
      diagnostic.error("monitor_selection_listener_failed", error);
    }
  }
}

function notifyStatusListeners(status) {
  for (const listener of selectedStatusListeners) {
    try {
      listener(status);
    } catch (error) {
      diagnostic.error("monitor_status_listener_failed", error);
    }
  }
}

function connectionLabel(snapshot) {
  if (snapshot.statusText) return snapshot.statusText;
  if (snapshot.state === "connected") return "Verbunden";
  if (snapshot.state === "stale") return "Bitte kurz warten";
  if (snapshot.state === "offline") return "Bitte kurz warten";
  if (snapshot.state === "backoff") return "Bitte kurz warten";
  if (snapshot.state === "connecting") return "Verbinden...";
  return "Nicht verbunden";
}

function renderConnection() {
  const node = document.getElementById("navigator-connection");
  if (!node) return;
  node.textContent = connectionLabel(connectionSnapshot);
  node.dataset.state = connectionSnapshot.state;
  updateControlAvailability();
  notifySelectionListeners();
}

function formatUser(user) {
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.id || "Benutzer";
  return `${name} (${user?.role || "unbekannt"})`;
}

function renderAccess(user) {
  const access = document.getElementById("navigator-access");
  const app = document.getElementById("navigator-app");
  if (!access || !app) return;

  access.hidden = authorized;
  app.hidden = !authorized;
  setText("navigator-session", authorized ? formatUser(user) : "Keine berechtigte Sitzung");
  const accessMessage = user
    ? `Die Rolle "${user.role || "unbekannt"}" darf Monitore nicht steuern.`
    : "Für diese Seite ist eine Anmeldung als Operator oder Administrator erforderlich.";
  setText("navigator-access-message", accessMessage);

  const adminPanel = document.getElementById("admin-monitor-panel");
  if (adminPanel) adminPanel.hidden = !admin;
}

function resetOperatorState() {
  for (const unsubscribe of monitorSubscriptions.values()) unsubscribe();
  monitorSubscriptions.clear();
  selectedMonitorId = "";
  monitors = new Map();
  navigatorEntries = [];
  navigationBindings.clear();
  monitorStatusCache.clear();
  clear(document.getElementById("navigator-container"));
  clear(document.getElementById("admin-monitor-list"));
  dismissOneTimeToken();
  notifySelectionListeners();
}

async function applyAuth(user) {
  const generation = ++authGeneration;
  const nextPrincipalKey = user ? `${user.id || ""}:${user.role || ""}` : "";
  const identityChanged = nextPrincipalKey !== authPrincipalKey;
  const nextAuthorized = !!user && hasRole("operator", "admin");
  const nextAdmin = !!user && hasRole("admin");
  const changed = identityChanged || authorized !== nextAuthorized || admin !== nextAdmin;
  authPrincipalKey = nextPrincipalKey;
  authorized = nextAuthorized;
  admin = nextAdmin;
  if (identityChanged || !admin) dismissOneTimeToken();
  renderAccess(user);

  if (!authorized) {
    resetOperatorState();
    return;
  }

  if (changed) showNotice("");
  await Promise.allSettled([loadNavigator(), loadMonitors()]);
  if (generation !== authGeneration) return;
  updateControlAvailability();
}

function monitorOptionText(monitor) {
  const state = monitor.revokedAt ? "widerrufen" : monitor.online ? "online" : "offline";
  return `${monitor.label || monitor.monitorId} (${state})`;
}

function activeMonitors() {
  return [...monitors.values()].filter((monitor) => !monitor.revokedAt);
}

function renderMonitorOptions() {
  const select = document.getElementById("monitor-select");
  if (!select) return;
  clear(select);
  const available = activeMonitors();
  if (!available.length) {
    const option = element("option", "", "Keine aktiven Monitore");
    option.value = "";
    select.appendChild(option);
    select.disabled = true;
    return;
  }
  for (const monitor of available) {
    const option = element("option", "", monitorOptionText(monitor));
    option.value = monitor.monitorId;
    option.selected = monitor.monitorId === selectedMonitorId;
    select.appendChild(option);
  }
  select.disabled = false;
}

function renderMonitorSummary() {
  const monitor = selectedMonitor();
  const presence = document.getElementById("monitor-presence");
  if (presence) {
    presence.textContent = !monitor ? "Kein Monitor ausgewählt" : monitor.online ? "Monitor online" : "Monitor offline";
    presence.dataset.state = !monitor ? "none" : monitor.online ? "online" : "offline";
  }

  const command = document.getElementById("monitor-command-status");
  if (!command) return;
  if (!monitor) {
    command.textContent = "Navigation: kein Monitor";
    command.dataset.state = "idle";
    return;
  }
  const target = monitor.target;
  const status = monitor.status;
  if (!target?.commandId || !target.path) {
    command.textContent = "Navigation: noch kein Ziel";
    command.dataset.state = "idle";
    return;
  }
  if (!status || status.commandId !== target.commandId || status.monitorId !== monitor.monitorId) {
    command.textContent = `Navigation: Status wird synchronisiert (${target.path})`;
    command.dataset.state = "pending";
    return;
  }
  const labels = {
    offline: "wartet auf Monitor",
    sent: "gesendet",
    received: "empfangen",
    loading: "wird geladen",
    loaded: "geladen",
    failed: "fehlgeschlagen",
  };
  const detail = status.errorCode ? `, ${status.errorCode}` : "";
  command.textContent = `Navigation: ${labels[status.status] || status.status}${detail} (${target.path})`;
  command.dataset.state = status.status;
}

function clearNavigationClasses() {
  for (const entry of navigatorEntries) {
    if (entry.action.kind !== "navigate") continue;
    entry.button.classList.remove("active", "blink-yellow", "command-failed");
    entry.button.removeAttribute("aria-busy");
  }
}

function navigationEntryForPath(path) {
  return navigatorEntries.find((entry) => entry.action.kind === "navigate" && entry.action.path === path) || null;
}

function renderNavigationState() {
  clearNavigationClasses();
  const monitor = selectedMonitor();
  if (!monitor?.target?.commandId || !monitor.target.path) {
    renderMonitorSummary();
    return;
  }
  const status = monitor.status;
  if (!status || status.commandId !== monitor.target.commandId || status.monitorId !== monitor.monitorId) {
    renderMonitorSummary();
    return;
  }
  const binding = navigationBindings.get(statusKey(monitor.monitorId, status.commandId));
  const entry = navigationEntryForPath(monitor.target.path) || binding?.entry;
  if (!entry) {
    renderMonitorSummary();
    return;
  }
  if (status.status === "loaded") {
    entry.button.classList.add("active");
  } else if (status.status === "failed") {
    entry.button.classList.add("command-failed");
  } else {
    entry.button.classList.add("blink-yellow");
    entry.button.setAttribute("aria-busy", "true");
  }
  renderMonitorSummary();
}

function updateControlAvailability() {
  const context = getSelectedMonitorContext();
  for (const entry of navigatorEntries) {
    if (entry.action.kind === "disabled") {
      entry.button.disabled = true;
    } else if (entry.action.kind === "navigate") {
      entry.button.disabled = navigationRequestInFlight || !context.canNavigate;
    } else {
      entry.button.disabled = !authorized || !connectionSnapshot.connected;
    }
  }

  const provisionButton = document.getElementById("monitor-provision");
  if (provisionButton) provisionButton.disabled = !admin || !connectionSnapshot.connected;
  renderAdminMonitorList();
}

function selectMonitor(monitorId) {
  const nextId = monitors.has(monitorId) && !monitors.get(monitorId).revokedAt ? monitorId : "";
  if (nextId === selectedMonitorId) {
    renderMonitorOptions();
    renderMonitorSummary();
    renderNavigationState();
    notifySelectionListeners();
    return;
  }

  selectedMonitorId = nextId;
  clearNavigationClasses();
  renderMonitorOptions();
  renderMonitorSummary();
  renderNavigationState();
  updateControlAvailability();
  notifySelectionListeners();
}

function mergeMonitorSnapshot(snapshot) {
  if (!snapshot?.monitorId) return;
  const current = monitors.get(snapshot.monitorId) || {};
  const merged = { ...current, ...snapshot };
  if (snapshot.status?.kind === "navigate") {
    merged.status = rememberMonitorStatus(snapshot.status);
  }
  monitors.set(snapshot.monitorId, merged);
}

function handleMonitorStatus(rawStatus) {
  if (!rawStatus?.monitorId) return;
  const monitor = monitors.get(rawStatus.monitorId);
  if (!monitor) return;

  if (!rawStatus.kind) {
    mergeMonitorSnapshot(rawStatus);
  } else if (rawStatus.kind === "presence") {
    monitor.online = rawStatus.status === "online";
  } else {
    const status = rememberMonitorStatus(rawStatus);
    if (status.kind === "navigate") {
      const targetMatches = monitor.target?.commandId === status.commandId;
      const binding = navigationBindings.get(statusKey(status.monitorId, status.commandId));
      if (targetMatches) {
        monitor.status = status;
      } else if (!monitor.target?.commandId && binding) {
        monitor.target = { monitorId: status.monitorId, commandId: status.commandId, path: binding.path };
        monitor.status = status;
      } else if (status.path) {
        monitor.target = { monitorId: status.monitorId, commandId: status.commandId, path: status.path };
        monitor.status = status;
      }
    }
    notifyStatusListeners(status);
  }

  renderMonitorOptions();
  renderMonitorSummary();
  renderNavigationState();
  renderAdminMonitorList();
  updateControlAvailability();
  notifySelectionListeners();
}

function syncMonitorSubscriptions() {
  const desired = new Set(activeMonitors().map((monitor) => monitor.monitorId));
  for (const [monitorId, unsubscribe] of monitorSubscriptions) {
    if (desired.has(monitorId)) continue;
    unsubscribe();
    monitorSubscriptions.delete(monitorId);
  }
  for (const monitorId of desired) {
    if (monitorSubscriptions.has(monitorId)) continue;
    monitorSubscriptions.set(monitorId, subscribe(`monitor-status:${monitorId}`, handleMonitorStatus));
  }
}

async function loadMonitors(preferredMonitorId = "") {
  if (!authorized) return;
  const generation = ++monitorLoadGeneration;
  try {
    const data = await endpointData(readMonitors, {}, "Monitore konnten nicht geladen werden");
    if (generation !== monitorLoadGeneration || !authorized) return;
    const values = Array.isArray(data.monitors) ? data.monitors : [];
    const next = new Map();
    for (const value of values) {
      if (!value?.monitorId) continue;
      if (value.status?.kind === "navigate") value.status = rememberMonitorStatus(value.status);
      next.set(value.monitorId, value);
    }
    monitors = next;
    syncMonitorSubscriptions();
    const available = activeMonitors();
    const desired = [preferredMonitorId, selectedMonitorId].find((id) => id && next.has(id) && !next.get(id).revokedAt)
      || available.find((monitor) => monitor.online)?.monitorId
      || available[0]?.monitorId
      || "";
    renderAdminMonitorList();
    selectMonitor(desired);
  } catch (error) {
    if (generation !== monitorLoadGeneration) return;
    showNotice(readableError(error, "Monitore konnten nicht geladen werden"), "error");
  }
}

async function sendNavigation(entry) {
  const context = getSelectedMonitorContext();
  if (!context.canNavigate || entry.action.kind !== "navigate") {
    showNotice("Bitte zuerst einen aktiven Monitor auswählen und die Verbindung prüfen.", "warning");
    return;
  }

  const monitorId = context.monitorId;
  const operationKey = `navigate:${monitorId}:${entry.action.path}`;
  const operationId = adminOperationId(operationKey);
  navigationRequestInFlight = true;
  entry.button.classList.add("command-sending");
  updateControlAvailability();
  showNotice("");
  try {
    const data = await endpointData(navigateMonitor, {
      operationId,
      monitorId,
      path: entry.action.path,
    }, "Navigation konnte nicht gesendet werden");
    if (!data.commandId) throw new Error("Der Server hat keine Kommando-ID geliefert");
    clearAdminOperation(operationKey);

    const binding = { entry, monitorId, path: entry.action.path };
    navigationBindings.set(statusKey(monitorId, data.commandId), binding);
    trimCommandHistory(navigationBindings);
    const monitor = monitors.get(monitorId);
    if (monitor) {
      monitor.target = {
        monitorId,
        commandId: data.commandId,
        path: entry.action.path,
        revision: data.targetRevision,
      };
      monitor.status = monitorStatusCache.get(statusKey(monitorId, data.commandId)) || {
        kind: "navigate",
        monitorId,
        commandId: data.commandId,
        path: entry.action.path,
        status: data.delivery === "offline" ? "offline" : "sent",
      };
    }
    if (selectedMonitorId === monitorId) renderNavigationState();
  } catch (error) {
    clearAdminOperation(operationKey, error);
    entry.button.classList.add("command-failed");
    showNotice(readableError(error, "Navigation konnte nicht gesendet werden"), "error");
  } finally {
    navigationRequestInFlight = false;
    entry.button.classList.remove("command-sending");
    updateControlAvailability();
  }
}

function normalizedAction(rawAction) {
  if (!rawAction || typeof rawAction !== "object") return { kind: "disabled", error: "ACTION_INVALID" };
  if (rawAction.kind === "navigate" && typeof rawAction.path === "string") {
    return { kind: "navigate", path: rawAction.path };
  }
  if (rawAction.kind === "court.assign" && ["1", "2"].includes(String(rawAction.court))) {
    return { kind: "court.assign", court: String(rawAction.court) };
  }
  if (rawAction.kind === "court.activation") return { kind: "court.activation" };
  return { kind: "disabled", error: String(rawAction.error || "ACTION_DISABLED") };
}

function renderNavigatorItems(items) {
  const container = document.getElementById("navigator-container");
  if (!container) return;
  clear(container);
  navigatorEntries = [];

  if (!items.length) {
    container.appendChild(element("p", "navigator-empty", "Keine Navigationseinträge gefunden."));
    return;
  }

  container.style.setProperty("--nav-rows", String(Math.max(1, Math.ceil(items.length / 4))));
  for (const item of items) {
    const action = normalizedAction(item.action);
    const button = element("button", "nav-btn", item.label || item.id || "Ohne Bezeichnung");
    button.type = "button";
    if (action.kind === "navigate") {
      button.addEventListener("click", () => sendNavigation(entry));
    } else if (action.kind === "court.assign") {
      button.addEventListener("click", () => openCourtAssignmentOverlay(action.court));
    } else if (action.kind === "court.activation") {
      button.addEventListener("click", openCourtActivationOverlay);
    } else {
      button.disabled = true;
      button.title = action.error;
      button.classList.add("nav-btn-disabled");
    }
    const entry = { id: String(item.id || ""), action, button };
    navigatorEntries.push(entry);
    container.appendChild(button);
  }
  renderNavigationState();
  updateControlAvailability();
}

async function loadNavigator() {
  if (!authorized) return;
  const generation = ++navigatorLoadGeneration;
  const container = document.getElementById("navigator-container");
  if (container && !navigatorEntries.length) {
    clear(container);
    container.appendChild(element("p", "navigator-empty", "Navigation wird geladen..."));
  }
  try {
    const data = await endpointData(readNavigator, { profil: NAV_PROFILE }, "Navigation konnte nicht geladen werden");
    if (generation !== navigatorLoadGeneration || !authorized) return;
    renderNavigatorItems(Array.isArray(data.items) ? data.items : []);
  } catch (error) {
    if (generation !== navigatorLoadGeneration || !container) return;
    clear(container);
    container.appendChild(element("p", "navigator-empty navigator-error", readableError(error)));
  }
}

function dismissOneTimeToken() {
  const panel = document.getElementById("monitor-token-panel");
  const token = document.getElementById("monitor-token");
  if (token) token.textContent = "";
  if (panel) panel.hidden = true;
}

function showOneTimeToken(token, label) {
  const panel = document.getElementById("monitor-token-panel");
  const value = document.getElementById("monitor-token");
  const heading = document.getElementById("monitor-token-heading");
  if (!panel || !value || !heading) return;
  value.textContent = token;
  heading.textContent = `Einmaliger Token für ${label}`;
  panel.hidden = false;
}

function setAdminStatus(message = "", type = "info") {
  const status = document.getElementById("admin-monitor-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.type = type;
}

async function rotateMonitorToken(monitor) {
  if (!admin || !connectionSnapshot.connected) return;
  if (!window.confirm(`Token für "${monitor.label}" wirklich rotieren? Das Gerät wird getrennt.`)) return;
  setAdminStatus("Token wird rotiert...");
  const operationKey = `rotate:${monitor.monitorId}`;
  try {
    const data = await endpointData(rotateMonitor, {
      monitorId: monitor.monitorId,
      operationId: adminOperationId(operationKey),
    }, "Token konnte nicht rotiert werden");
    clearAdminOperation(operationKey);
    if (data.tokenUnavailable) {
      setAdminStatus("Die Rotation wurde bereits ausgefuehrt, der Token konnte aber nicht erneut angezeigt werden. Bitte eine neue Rotation starten.", "warning");
      await loadMonitors(monitor.monitorId);
      return;
    }
    if (!data.monitor?.token) throw new Error("Der Server hat keinen neuen Token geliefert");
    showOneTimeToken(data.monitor.token, monitor.label);
    setAdminStatus("Token rotiert. Er wird nur dieses eine Mal angezeigt.", "success");
    await loadMonitors(monitor.monitorId);
  } catch (error) {
    clearAdminOperation(operationKey, error);
    setAdminStatus(readableError(error), "error");
  }
}

async function revokeMonitorDevice(monitor) {
  if (!admin || !connectionSnapshot.connected || monitor.revokedAt) return;
  if (!window.confirm(`Monitor "${monitor.label}" wirklich widerrufen?`)) return;
  setAdminStatus("Monitor wird widerrufen...");
  const operationKey = `revoke:${monitor.monitorId}`;
  try {
    await endpointData(revokeMonitor, {
      monitorId: monitor.monitorId,
      operationId: adminOperationId(operationKey),
    }, "Monitor konnte nicht widerrufen werden");
    clearAdminOperation(operationKey);
    setAdminStatus("Monitor wurde widerrufen.", "success");
    await loadMonitors();
  } catch (error) {
    clearAdminOperation(operationKey, error);
    setAdminStatus(readableError(error), "error");
  }
}

function renderAdminMonitorList() {
  const list = document.getElementById("admin-monitor-list");
  if (!list || !admin) return;
  clear(list);
  if (!monitors.size) {
    list.appendChild(element("p", "admin-monitor-empty", "Noch keine Monitore vorhanden."));
    return;
  }

  for (const monitor of monitors.values()) {
    const row = element("div", "admin-monitor-row");
    const details = element("div", "admin-monitor-details");
    details.appendChild(element("strong", "", monitor.label || monitor.monitorId));
    details.appendChild(element("span", "admin-monitor-id", monitor.monitorId));
    const state = monitor.revokedAt ? "Widerrufen" : monitor.online ? "Online" : "Offline";
    details.appendChild(element("span", `admin-monitor-state ${monitor.revokedAt ? "revoked" : monitor.online ? "online" : "offline"}`, state));

    const actions = element("div", "admin-monitor-actions");
    const rotateButton = element("button", "navigator-secondary-btn", monitor.revokedAt ? "Neu aktivieren" : "Token rotieren");
    rotateButton.type = "button";
    rotateButton.disabled = !connectionSnapshot.connected;
    rotateButton.addEventListener("click", () => rotateMonitorToken(monitor));
    const revokeButton = element("button", "navigator-danger-btn", "Widerrufen");
    revokeButton.type = "button";
    revokeButton.disabled = !connectionSnapshot.connected || !!monitor.revokedAt;
    revokeButton.addEventListener("click", () => revokeMonitorDevice(monitor));
    actions.append(rotateButton, revokeButton);
    row.append(details, actions);
    list.appendChild(row);
  }
}

function normalizedHeader(values) {
  if (!Array.isArray(values) || !Array.isArray(values[0])) return [];
  return values[0].map((value) => String(value || "").trim().toLowerCase());
}

async function loadPlayers() {
  const data = await endpointData(readPlayersList, {}, "Spieler konnten nicht geladen werden");
  const values = data.values;
  const header = normalizedHeader(values);
  const idIndex = header.indexOf("id");
  const firstNameIndex = header.indexOf("vorname");
  const lastNameIndex = header.indexOf("nachname");
  const activeIndex = header.indexOf("aktiv");
  if (!Array.isArray(values) || idIndex < 0) throw new Error("Spielerliste hat kein ID-Feld");

  const nextMap = new Map();
  const details = [];
  for (const row of values.slice(1)) {
    if (!Array.isArray(row) || (activeIndex >= 0 && String(row[activeIndex] || "1").trim() !== "1")) continue;
    const id = String(row[idIndex] || "").trim();
    if (!id) continue;
    const firstName = firstNameIndex < 0 ? "" : String(row[firstNameIndex] || "").trim();
    const lastName = lastNameIndex < 0 ? "" : String(row[lastNameIndex] || "").trim();
    const fullName = `${firstName} ${lastName}`.trim() || id;
    const display = `${lastName} ${firstName}`.trim() || id;
    nextMap.set(id, fullName);
    details.push({ id, display, lastName });
  }
  playerMap = nextMap;
  playerDetails = details.sort((left, right) => left.lastName.localeCompare(right.lastName, "de"));
}

async function loadCompetitions() {
  const data = await endpointData(readBewerbe, {}, "Bewerbe konnten nicht geladen werden");
  const values = data.values;
  const header = normalizedHeader(values);
  const idIndex = header.indexOf("id");
  const nameIndex = header.indexOf("bezeichnung");
  if (!Array.isArray(values) || idIndex < 0 || nameIndex < 0) throw new Error("Bewerbsliste ist unvollständig");
  const nextMap = new Map();
  for (const row of values.slice(1)) {
    const id = String(row[idIndex] || "").trim();
    if (id) nextMap.set(id, String(row[nameIndex] || "").trim());
  }
  competitionMap = nextMap;
}

function cleanPlayerId(value) {
  const normalized = String(value || "").trim();
  if (normalized.endsWith("[wo]")) return normalized.slice(0, -4).trim();
  if (normalized.endsWith("[ret]")) return normalized.slice(0, -5).trim();
  return normalized;
}

function dateToTimestamp(raw) {
  const match = String(raw || "").trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!match) return 0;
  const [, yy, month, day, hour, minute] = match;
  const year = Number(yy) >= 50 ? 1900 + Number(yy) : 2000 + Number(yy);
  return new Date(year, Number(month) - 1, Number(day), Number(hour), Number(minute)).getTime();
}

async function loadNextMatches() {
  const data = await endpointData(readPreMatches, {}, "Matches konnten nicht geladen werden");
  const values = data.values;
  const header = normalizedHeader(values);
  const index = (name) => header.indexOf(name);
  const indexes = {
    id: index("id"),
    player1: index("spieler1id"),
    player2: index("spieler2id"),
    player3: index("spieler3id"),
    player4: index("spieler4id"),
    date: index("matchdate"),
    result: index("ergebnis"),
    competition: index("bewerbid"),
    round: index("bewerbrunde"),
  };
  if (!Array.isArray(values) || indexes.id < 0 || indexes.player1 < 0 || indexes.player3 < 0) {
    throw new Error("Matchliste ist unvollständig");
  }

  nextMatches = values.slice(1)
    .filter((row) => {
      if (!Array.isArray(row) || !row[indexes.id] || !row[indexes.player1] || !row[indexes.player3]) return false;
      const participantIndexes = [indexes.player1, indexes.player2, indexes.player3, indexes.player4].filter((index) => index >= 0);
      const participants = participantIndexes.map((index) => String(row[index] || "").trim());
      const player1 = participants[0];
      const player3 = String(row[indexes.player3] || "").trim();
      if (/^BYE$/i.test(player1) || /^BYE$/i.test(player3)) return false;
      if (participants.some((participant) => participant.endsWith("[wo]") || participant.endsWith("[ret]"))) return false;
      return indexes.result < 0 || !String(row[indexes.result] || "").trim();
    })
    .map((row) => ({
      matchId: String(row[indexes.id] || "").trim(),
      player1: cleanPlayerId(row[indexes.player1]),
      player2: indexes.player2 < 0 ? "" : cleanPlayerId(row[indexes.player2]),
      player3: cleanPlayerId(row[indexes.player3]),
      player4: indexes.player4 < 0 ? "" : cleanPlayerId(row[indexes.player4]),
      competitionId: indexes.competition < 0 ? "" : String(row[indexes.competition] || "").trim(),
      date: indexes.date < 0 ? "" : String(row[indexes.date] || "").trim(),
      round: indexes.round < 0 ? "" : String(row[indexes.round] || "").trim(),
      timestamp: indexes.date < 0 ? 0 : dateToTimestamp(row[indexes.date]),
    }))
    .sort((left, right) => {
      if (left.timestamp && right.timestamp) return left.timestamp - right.timestamp;
      return left.timestamp ? -1 : right.timestamp ? 1 : 0;
    })
    .slice(0, 20);
}

function displaySheetDate(raw) {
  const match = String(raw || "").trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!match) return String(raw || "");
  const [, , month, day, hour, minute] = match;
  return `${day}.${month}. - ${hour}:${minute}`;
}

function displayRound(raw) {
  const match = String(raw || "").trim().toUpperCase().match(/^(R\d+|AF|VF|HF|F|G\d+)/);
  if (!match) return "";
  const code = match[1];
  if (/^R\d+$/.test(code)) return `${code.slice(1)}. Runde`;
  if (code === "AF") return "Achtelfinale";
  if (code === "VF") return "Viertelfinale";
  if (code === "HF") return "Halbfinale";
  if (code === "F") return "Finale";
  if (/^G\d+$/.test(code)) return `${code.slice(1)}. Gruppe`;
  return code;
}

function createOverlay(titleText) {
  const overlay = element("div", "platz-overlay");
  const box = element("div", "platz-overlay-box");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", titleText);
  box.appendChild(element("div", "platz-overlay-title", titleText));
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  return { overlay, box };
}

function openPlayerOverlay(label, excludedIds = new Set()) {
  return new Promise((resolve) => {
    const { overlay, box } = createOverlay(label);
    const list = element("div", "platz-overlay-list");
    let selected = null;
    for (const player of playerDetails) {
      if (excludedIds.has(player.id)) continue;
      const button = element("button", "platz-overlay-option");
      button.type = "button";
      button.appendChild(element("span", "platz-overlay-paarung", player.display));
      button.addEventListener("click", () => {
        for (const option of list.querySelectorAll(".platz-overlay-option")) option.classList.remove("selected");
        button.classList.add("selected");
        selected = player;
      });
      list.appendChild(button);
    }
    box.appendChild(list);

    const actions = element("div", "platz-overlay-actions");
    const cancel = element("button", "platz-overlay-btn cancel", "Abbrechen");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      overlay.remove();
      resolve(null);
    });
    const submit = element("button", "platz-overlay-btn submit", "Übernehmen");
    submit.type = "button";
    submit.addEventListener("click", () => {
      if (!selected) return;
      overlay.remove();
      resolve({ id: selected.id });
    });
    actions.append(cancel, submit);
    box.appendChild(actions);
  });
}

async function freshCourtData() {
  const data = await endpointData(readScoreboardCourts, {}, "Platzdaten konnten nicht geladen werden");
  if (!data.courts || typeof data.courts !== "object") throw new Error("Platzdaten fehlen");
  return data.courts;
}

async function refreshCourtRevision(court, fallback) {
  try {
    const courts = await freshCourtData();
    return Number.isInteger(courts[court]?.revision) ? courts[court].revision : fallback;
  } catch {
    return fallback;
  }
}

async function openCourtAssignmentOverlay(court) {
  if (!connectionSnapshot.connected) {
    showNotice("Die Verbindung muss vor einer Platzzuweisung hergestellt sein.", "warning");
    return;
  }
  showNotice("Platzdaten werden geladen...");
  let courts;
  try {
    [, , , courts] = await Promise.all([loadPlayers(), loadCompetitions(), loadNextMatches(), freshCourtData()]);
  } catch (error) {
    showNotice(readableError(error, "Daten für die Platzzuweisung konnten nicht geladen werden"), "error");
    return;
  }
  showNotice("");

  let expectedRevision = courts[court]?.revision;
  if (!Number.isInteger(expectedRevision)) {
    showNotice("Für den Platz fehlt eine gültige Revision.", "error");
    return;
  }

  const { overlay, box } = createOverlay(`Platz ${court} - Spielzuweisung`);
  const list = element("div", "platz-overlay-list");
  const status = element("div", "platz-overlay-status");
  status.setAttribute("role", "status");
  let selection = null;

  const emptyButton = element("button", "platz-overlay-option");
  emptyButton.type = "button";
  emptyButton.appendChild(element("span", "platz-overlay-paarung", "kein Spiel zuweisen"));
  emptyButton.addEventListener("click", () => {
    for (const option of list.querySelectorAll(".platz-overlay-option")) option.classList.remove("selected");
    emptyButton.classList.add("selected");
    selection = { kind: "empty" };
  });
  list.appendChild(emptyButton);

  for (const individual of [
    { label: "Individual Einzel", kind: "individual-single" },
    { label: "Individual Doppel", kind: "individual-doubles" },
  ]) {
    const button = element("button", "platz-overlay-option");
    button.type = "button";
    button.appendChild(element("span", "platz-overlay-paarung", individual.label));
    button.addEventListener("click", () => {
      for (const option of list.querySelectorAll(".platz-overlay-option")) option.classList.remove("selected");
      button.classList.add("selected");
      selection = { kind: individual.kind };
    });
    list.appendChild(button);
  }

  for (const match of nextMatches) {
    const home = [match.player1, match.player2].filter(Boolean).map((id) => playerMap.get(id) || id).join(" / ");
    const guest = [match.player3, match.player4].filter(Boolean).map((id) => playerMap.get(id) || id).join(" / ");
    const info = [displaySheetDate(match.date), competitionMap.get(match.competitionId), displayRound(match.round)].filter(Boolean);
    const button = element("button", "platz-overlay-option");
    button.type = "button";
    button.appendChild(element("span", "platz-overlay-paarung", `${home} vs. ${guest}`));
    button.appendChild(element("span", "platz-overlay-bewerb", info.join(" | ")));
    button.addEventListener("click", () => {
      for (const option of list.querySelectorAll(".platz-overlay-option")) option.classList.remove("selected");
      button.classList.add("selected");
      selection = { kind: "match", matchId: match.matchId };
    });
    list.appendChild(button);
  }
  box.appendChild(list);

  const actions = element("div", "platz-overlay-actions");
  const cancel = element("button", "platz-overlay-btn cancel", "Abbrechen");
  cancel.type = "button";
  cancel.addEventListener("click", () => overlay.remove());
  const submit = element("button", "platz-overlay-btn submit", "Übernehmen");
  submit.type = "button";
  submit.addEventListener("click", async () => {
    if (!selection || submit.disabled) return;
    submit.disabled = true;
    status.textContent = "Zuweisung wird gespeichert...";
    let operationKey = "";
    try {
      let assignment;
      if (selection.kind === "match") {
        assignment = { matchId: selection.matchId };
      } else if (selection.kind === "empty") {
        assignment = { empty: true };
      } else {
        const labels = selection.kind === "individual-doubles"
          ? ["Heim Spieler 1", "Heim Spieler 2", "Gast Spieler 1", "Gast Spieler 2"]
          : ["Spieler Heim", "Spieler Gast"];
        const players = [];
        for (const label of labels) {
          const player = await openPlayerOverlay(label, new Set(players.map((entry) => entry.id)));
          if (!player) return;
          players.push(player);
        }
        const homePlayerCount = selection.kind === "individual-doubles" ? 2 : 1;
        assignment = {
          homePlayerIds: players.slice(0, homePlayerCount).map((player) => player.id),
          guestPlayerIds: players.slice(homePlayerCount).map((player) => player.id),
        };
      }
      operationKey = `court-assign:${court}:${JSON.stringify(assignment)}`;
      await endpointData(assignCourt, {
        operationId: adminOperationId(operationKey),
        court,
        ...assignment,
        expectedRevision,
      }, "Platz konnte nicht zugewiesen werden");
      clearAdminOperation(operationKey);
      overlay.remove();
      showNotice(`Platz ${court} wurde zugewiesen.`, "success");
    } catch (error) {
      if (operationKey) clearAdminOperation(operationKey, error);
      status.textContent = readableError(error, "Platz konnte nicht zugewiesen werden");
      status.dataset.type = "error";
      expectedRevision = await refreshCourtRevision(court, expectedRevision);
    } finally {
      if (overlay.isConnected) submit.disabled = false;
    }
  });
  actions.append(cancel, submit);
  box.append(status, actions);
}

async function openCourtActivationOverlay() {
  if (!connectionSnapshot.connected) {
    showNotice("Die Verbindung muss vor einer Platzaktivierung hergestellt sein.", "warning");
    return;
  }
  let courtData;
  try {
    courtData = await freshCourtData();
  } catch (error) {
    showNotice(readableError(error, "Platzstatus konnte nicht geladen werden"), "error");
    return;
  }

  const { overlay, box } = createOverlay("Platzaktivierung");
  const list = element("div", "platz-overlay-list aktivierung-list");
  const status = element("div", "platz-overlay-status");
  status.setAttribute("role", "status");
  const buttons = new Map();

  function updateButton(court) {
    const button = buttons.get(court);
    if (!button) return;
    const active = courtData[court]?.aktiv === 1;
    button.textContent = `Platz ${court}: ${active ? "aktiv" : "inaktiv"}`;
    button.classList.toggle("aktivierung-active", active);
    button.classList.toggle("aktivierung-inactive", !active);
  }

  async function toggleCourt(court) {
    const current = courtData[court];
    const button = buttons.get(court);
    if (!current || !Number.isInteger(current.revision) || !button) {
      status.textContent = "Für diesen Platz fehlt eine gültige Revision.";
      status.dataset.type = "error";
      return;
    }
    button.disabled = true;
    status.textContent = "Status wird gespeichert...";
    const operationKey = `court-active:${court}:${current.aktiv !== 1}:${current.revision}`;
    try {
      const data = await endpointData(setCourtActive, {
        operationId: adminOperationId(operationKey),
        court,
        active: current.aktiv !== 1,
        expectedRevision: current.revision,
      }, "Platzstatus konnte nicht geändert werden");
      clearAdminOperation(operationKey);
      courtData[court] = data.court;
      status.textContent = "Platzstatus gespeichert.";
      status.dataset.type = "success";
    } catch (error) {
      clearAdminOperation(operationKey, error);
      status.textContent = readableError(error, "Platzstatus konnte nicht geändert werden");
      status.dataset.type = "error";
      try {
        courtData = await freshCourtData();
      } catch {
        // Keep the last known revisions until the operator retries the overlay.
      }
    } finally {
      updateButton("1");
      updateButton("2");
      button.disabled = false;
    }
  }

  for (const court of ["1", "2"]) {
    const button = element("button", "platz-aktivierung-btn");
    button.type = "button";
    button.addEventListener("click", () => toggleCourt(court));
    buttons.set(court, button);
    list.appendChild(button);
    updateButton(court);
  }
  box.appendChild(list);
  const actions = element("div", "platz-overlay-actions");
  const close = element("button", "platz-overlay-btn cancel", "Schließen");
  close.type = "button";
  close.addEventListener("click", () => overlay.remove());
  actions.appendChild(close);
  box.append(status, actions);
}

async function handleProvision(event) {
  event.preventDefault();
  if (!admin || !connectionSnapshot.connected) return;
  const input = document.getElementById("monitor-label");
  const label = input?.value.trim();
  if (!label) {
    setAdminStatus("Bitte eine Bezeichnung eingeben.", "error");
    return;
  }
  const submit = document.getElementById("monitor-provision");
  if (submit) submit.disabled = true;
  dismissOneTimeToken();
  setAdminStatus("Monitor wird angelegt...");
  const operationKey = `provision:${label.toLowerCase()}`;
  try {
    const data = await endpointData(provisionMonitor, {
      label,
      operationId: adminOperationId(operationKey),
    }, "Monitor konnte nicht angelegt werden");
    clearAdminOperation(operationKey);
    if (data.tokenUnavailable) {
      if (input) input.value = "";
      setAdminStatus("Der Monitor wurde bereits angelegt, der einmalige Token ist nicht erneut abrufbar. Bitte den Monitor auswaehlen und den Token rotieren.", "warning");
      await loadMonitors(data.monitor?.monitorId || "");
      return;
    }
    if (!data.monitor?.token || !data.monitor?.monitorId) throw new Error("Der Server hat keinen Gerätetoken geliefert");
    if (input) input.value = "";
    showOneTimeToken(data.monitor.token, data.monitor.label || label);
    setAdminStatus("Monitor angelegt. Der Token wird nur dieses eine Mal angezeigt.", "success");
    await loadMonitors(data.monitor.monitorId);
  } catch (error) {
    clearAdminOperation(operationKey, error);
    setAdminStatus(readableError(error), "error");
  } finally {
    if (submit) submit.disabled = !connectionSnapshot.connected;
  }
}

async function copyOneTimeToken() {
  const token = document.getElementById("monitor-token")?.textContent || "";
  if (!token) return;
  try {
    await navigator.clipboard.writeText(token);
    setAdminStatus("Token wurde in die Zwischenablage kopiert.", "success");
  } catch {
    setAdminStatus("Token konnte nicht automatisch kopiert werden. Bitte manuell markieren.", "warning");
  }
}

async function refreshOperatorData() {
  if (!authorized) return;
  await Promise.allSettled([loadNavigator(), loadMonitors()]);
}

function bindPageEvents() {
  document.getElementById("monitor-select")?.addEventListener("change", (event) => selectMonitor(event.target.value));
  document.getElementById("monitor-provision-form")?.addEventListener("submit", handleProvision);
  document.getElementById("monitor-token-copy")?.addEventListener("click", copyOneTimeToken);
  document.getElementById("monitor-token-dismiss")?.addEventListener("click", dismissOneTimeToken);
}

onConnectionState((snapshot) => {
  connectionSnapshot = snapshot;
  if (domReady) renderConnection();
});

onResync(() => {
  if (domReady && authorized) refreshOperatorData();
});

async function initialize() {
  domReady = true;
  bindPageEvents();
  renderConnection();
  await ready;
  subscribeInvalidations(["navigator", "monitors"], refreshOperatorData);
  subscribeAuth((user) => {
    applyAuth(user).catch((error) => showNotice(readableError(error), "error"));
  });
  if (getUser() === null) renderAccess(null);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}
