import { createEndpoint, onConnectionState, subscribe } from "./dataClient.js";

const POLL_INTERVAL_MS = 2000;
const readCourtScores = createEndpoint("courtScores");
const pollData = document.getElementById("pollData");
const subscriptionData = document.getElementById("wsData");
const statusBadge = document.getElementById("statusBadge");
const updateCountElement = document.getElementById("updateCount");
const lastUpdateElement = document.getElementById("lastUpdate");
const logContainer = document.getElementById("logContainer");
const pollButton = document.getElementById("btnPoll");
const subscriptionButton = document.getElementById("btnWs");

let mode = "off";
let generation = 0;
let pollTimer = null;
let unsubscribeScores = null;
let updateCount = 0;

function log(message, type = "") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  entry.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
  logContainer.prepend(entry);
  while (logContainer.children.length > 200) logContainer.lastElementChild.remove();
}

function scoreCell(value, className = "") {
  const element = document.createElement("span");
  element.className = `score-cell ${className}`;
  element.textContent = String(value || "-");
  return element;
}

function scoreRow(label, court, side) {
  const row = document.createElement("div");
  row.className = "score-row";
  row.append(
    scoreCell(label, "label"),
    scoreCell(court[`satz1${side}`]),
    scoreCell(court[`satz2${side}`]),
    scoreCell(court[`satz3${side}`]),
    scoreCell(court[`punkte${side}`], "points"),
  );
  return row;
}

function renderCourts(container, snapshot) {
  const courts = Array.isArray(snapshot?.courts) ? snapshot.courts : [];
  if (!courts.length) {
    container.textContent = "Keine Daten";
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const court of courts) {
    const card = document.createElement("div");
    card.className = "court";
    const title = document.createElement("div");
    title.className = "court-title";
    title.textContent = `Platz ${court.platz || "-"}`;
    card.append(title, scoreRow("Heim", court, "home"), scoreRow("Gast", court, "gast"));
    fragment.appendChild(card);
  }
  container.replaceChildren(fragment);
}

function setStatus(text, className = "") {
  statusBadge.textContent = text;
  statusBadge.className = `badge ${className}`;
}

function recordUpdate() {
  updateCount += 1;
  updateCountElement.textContent = String(updateCount);
  lastUpdateElement.textContent = new Date().toLocaleTimeString();
}

function stopAll({ silent = false } = {}) {
  generation += 1;
  mode = "off";
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  unsubscribeScores?.();
  unsubscribeScores = null;
  pollButton.classList.remove("active");
  subscriptionButton.classList.remove("active");
  setStatus("Gestoppt");
  if (!silent) log("Gestoppt");
}

async function poll(currentGeneration) {
  try {
    const response = await readCourtScores();
    const payload = response.data;
    if (!payload?.success) throw new Error(payload?.error?.message || "Court-RPC fehlgeschlagen");
    if (mode !== "poll" || generation !== currentGeneration) return;
    renderCourts(pollData, payload.data);
    recordUpdate();
    log(`RPC-Poll OK (${payload.data?.courts?.length || 0} Courts)`, "poll");
  } catch (error) {
    if (mode === "poll" && generation === currentGeneration) log(`RPC-Poll Fehler: ${error.message}`, "error");
  } finally {
    if (mode === "poll" && generation === currentGeneration) {
      pollTimer = setTimeout(() => poll(currentGeneration), POLL_INTERVAL_MS);
    }
  }
}

function startPolling() {
  stopAll({ silent: true });
  mode = "poll";
  const currentGeneration = generation;
  pollButton.classList.add("active");
  setStatus("RPC-Polling aktiv", "poll");
  log(`RPC-Polling gestartet (${POLL_INTERVAL_MS} ms)`);
  poll(currentGeneration);
}

function startSubscription() {
  stopAll({ silent: true });
  mode = "subscription";
  subscriptionButton.classList.add("active");
  setStatus("Subscription aktiv", "push");
  unsubscribeScores = subscribe("scores", (snapshot) => {
    if (mode !== "subscription") return;
    renderCourts(subscriptionData, snapshot);
    recordUpdate();
    log(`Score-Event (${snapshot?.courts?.length || 0} Courts)`, "push");
  });
  log("Score-Subscription gestartet");
}

onConnectionState((state) => {
  if (mode !== "subscription") return;
  if (state.connected) setStatus("Subscription verbunden", "ok");
  else setStatus(`Verbindung: ${state.state}`, "");
});

pollButton.addEventListener("click", startPolling);
subscriptionButton.addEventListener("click", startSubscription);
document.getElementById("btnStop").addEventListener("click", () => stopAll());
