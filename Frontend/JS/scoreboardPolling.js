import { createEndpoint, onConnectionState, onResync, subscribe } from "./dataClient.js";
import { signalMonitorFailed, signalMonitorReady } from "./monitorReady.js";

const readScoreboardSnapshot = createEndpoint("scoreboardSnapshot");
const SNAPSHOT_DEBOUNCE_MS = 75;
const SNAPSHOT_RETRY_MAX_MS = 30000;

let matchRasterMap = new Map();
let connectionStatus = { state: "idle", connected: false };
let scoreboardSynchronized = false;
let courtSource = null;
let hasRenderedSnapshot = false;
let initializationFailed = false;

let snapshotTimer = null;
let snapshotRetryTimer = null;
let snapshotRetryAttempt = 0;
let snapshotInFlight = false;
let snapshotQueued = false;
let snapshotGeneration = 0;
let playerNameSizingFrame = null;
const requiredRevisions = { players: null, bewerbe: null, matches1: null };

let courtEventSequence = 0;
let scoreEventSequence = 0;
let latestCourtEvent = null;
let latestScoreEvent = null;
let latestScoreRevision = -1;

function normalizedHeader(values) {
  if (!Array.isArray(values) || !Array.isArray(values[0])) return [];
  return values[0].map((value) => String(value ?? "").trim().toLowerCase());
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function buildPlayerMap(values) {
  const header = normalizedHeader(values);
  const idIdx = header.indexOf("id");
  const fnIdx = header.indexOf("vorname");
  const lnIdx = header.indexOf("nachname");
  const map = new Map();
  if (idIdx === -1) return map;

  values.slice(1).forEach((row) => {
    if (!Array.isArray(row)) return;
    const id = String(row[idIdx] || "").trim();
    const firstName = fnIdx === -1 ? "" : String(row[fnIdx] || "");
    const lastName = lnIdx === -1 ? "" : String(row[lnIdx] || "");
    const name = `${firstName} ${lastName}`.trim();
    if (id) map.set(id, name || id);
  });
  return map;
}

function buildBewerbMap(values) {
  const header = normalizedHeader(values);
  const idIdx = header.indexOf("id");
  const nameIdx = header.indexOf("bezeichnung");
  const map = new Map();
  if (idIdx === -1 || nameIdx === -1) return map;

  values.slice(1).forEach((row) => {
    if (!Array.isArray(row)) return;
    const id = String(row[idIdx] || "").trim();
    if (id) map.set(id, String(row[nameIdx] || "").trim());
  });
  return map;
}

function parseSheetDate(raw) {
  if (!raw) return "";
  const value = String(raw).trim();
  const sheetMatch = value.match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (sheetMatch) {
    const [, , mm, dd, hh, mi] = sheetMatch;
    return `${dd}.${mm}. - ${hh}:${mi}`;
  }
  const displayMatch = value.match(/^(\d{2})\.(\d{2})\.(?:,)?\s*(\d{2}):(\d{2})$/);
  if (displayMatch) {
    const [, dd, mm, hh, mi] = displayMatch;
    return `${dd}.${mm}. - ${hh}:${mi}`;
  }
  return value;
}

function dateToTs(raw) {
  if (!raw) return 0;
  const m = String(raw).trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return 0;
  const [, yy, mm, dd, hh, mi] = m;
  const yyyy = parseInt(yy, 10) >= 50 ? 1900 + parseInt(yy) : 2000 + parseInt(yy);
  return new Date(yyyy, parseInt(mm) - 1, parseInt(dd), parseInt(hh), parseInt(mi)).getTime();
}

function parsePlayerId(raw) {
  const s = String(raw || "").trim();
  const wo = /\[w\.?o\.?\]/i.test(s);
  const ret = /\[ret\]/i.test(s);
  const cleanId = s.replace(/\[w\.?o\.?\]/gi, "").replace(/\[ret\]/gi, "").trim();
  const special = wo ? "wo" : ret ? "ret" : null;
  return { cleanId, special };
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function createBadge(type) {
  if (type !== "wo" && type !== "ret") return null;
  return createElement("span", "badge badge-wo", type === "wo" ? "w.o." : "ret.");
}

function parseRunde(raw) {
  if (!raw) return "";
  const s = String(raw).trim().toUpperCase();
  const roundMatch = s.match(/^(R\d+|AF|VF|HF|F|G\d+)/);
  if (!roundMatch) return "";
  const code = roundMatch[1];
  if (/^R(\d+)$/.test(code)) return code.replace(/^R/, "") + ".Runde";
  if (code === "AF") return "Achtelfinale";
  if (code === "VF") return "Viertelfinale";
  if (code === "HF") return "Halbfinale";
  if (code === "F") return "Finale";
  if (/^G(\d+)$/.test(code)) return code.replace(/^G/, "") + ".Gruppe";
  return code;
}

// Ermittelt Gewinner: 1 = Team1/Spieler1 gewinnt, 2 = Team2/Spieler3 gewinnt, 0 = unentschieden/unklar
function determineWinner(ergebnis) {
  if (!ergebnis) return 0;
  const sets = String(ergebnis).split("/").filter(Boolean);
  let wins1 = 0, wins2 = 0;
  sets.forEach((s) => {
    const clean = s.replace(/\(\d+\)/g, '').trim();
    const parts = clean.split("-").map(Number);
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      if (parts[0] > parts[1]) wins1++;
      else if (parts[1] > parts[0]) wins2++;
    }
  });
  if (wins1 > wins2) return 1;
  if (wins2 > wins1) return 2;
  return 0;
}

function appendPlayer(container, name, badgeType) {
  container.append(document.createTextNode(String(name || "")));
  const badge = createBadge(badgeType);
  if (badge) container.append(document.createTextNode(" "), badge);
}

function buildPlayersElement(p1, p2, p3, p4, p1badge, p2badge, p3badge, p4badge, winner) {
  const cls1 = winner === 1 ? "ae-winner" : winner === 2 ? "ae-loser" : "";
  const cls2 = winner === 2 ? "ae-winner" : winner === 1 ? "ae-loser" : "";
  const isDouble = p2 || p4;
  const players = createElement("div", "ae-players");

  if (isDouble) {
    const team1 = createElement("div", `ae-team${cls1 ? ` ${cls1}` : ""}`);
    appendPlayer(team1, p1, p1badge);
    if (p2) {
      team1.append(document.createTextNode(" / "));
      appendPlayer(team1, p2, p2badge);
    }

    const team2 = createElement("div", `ae-team${cls2 ? ` ${cls2}` : ""}`);
    appendPlayer(team2, p3, p3badge);
    if (p4) {
      team2.append(document.createTextNode(" / "));
      appendPlayer(team2, p4, p4badge);
    }

    players.append(team1, createElement("div", "ae-separator", "-"), team2);
    return players;
  }

  const line = document.createElement("span");
  const player1 = createElement("span", cls1);
  const player3 = createElement("span", cls2);
  appendPlayer(player1, p1, p1badge);
  appendPlayer(player3, p3, p3badge);
  line.append(player1, document.createTextNode(" - "), player3);
  players.append(line);
  return players;
}

function matchIndexes(values) {
  const header = normalizedHeader(values);
  const idx = (label) => header.indexOf(label);
  return {
    i1: idx("spieler1id"),
    i3: idx("spieler3id"),
    i2: idx("spieler2id"),
    i4: idx("spieler4id"),
    ergebnisIdx: idx("ergebnis"),
    d: idx("matchdate"),
    bewerbIdIdx: idx("bewerbid"),
    rasterIdx: idx("bewerbrunde"),
  };
}

function createMatchEntry(row, indexes, maps, upcoming) {
  const { i1, i2, i3, i4, ergebnisIdx, d, bewerbIdIdx, rasterIdx } = indexes;
  const pid1 = parsePlayerId(row[i1]);
  const pid3 = parsePlayerId(row[i3]);
  const pid2 = parsePlayerId(row[i2]);
  const pid4 = parsePlayerId(row[i4]);
  const p1 = maps.players.get(pid1.cleanId) || pid1.cleanId;
  const p3 = maps.players.get(pid3.cleanId) || pid3.cleanId;
  const p2 = pid2.cleanId ? (maps.players.get(pid2.cleanId) || pid2.cleanId) : "";
  const p4 = pid4.cleanId ? (maps.players.get(pid4.cleanId) || pid4.cleanId) : "";

  const datum = parseSheetDate(row[d]);
  const bewerbId = bewerbIdIdx !== -1 ? String(row[bewerbIdIdx] || "").trim() : "";
  const bewerbName = maps.bewerbe.get(bewerbId) || "";
  const runde = rasterIdx !== -1 ? parseRunde(row[rasterIdx]) : "";
  const headerText = [datum, bewerbName, runde].filter(Boolean).join(" | ");

  let winner = upcoming ? 0 : determineWinner(row[ergebnisIdx]);
  if (!upcoming && !winner) {
    if (pid1.special === "wo") winner = 2;
    else if (pid3.special === "wo") winner = 1;
  }

  const entry = createElement("div", upcoming ? "pre-entry" : "archived-entry");
  const content = createElement("div", "ae-content");
  content.append(buildPlayersElement(
    p1,
    p2,
    p3,
    p4,
    pid1.special,
    pid2.special,
    pid3.special,
    pid4.special,
    winner,
  ));
  if (!upcoming) {
    const result = String(row[ergebnisIdx] || "").replace(/\((\d+)\)/g, "").trim();
    content.append(createElement("div", "ae-result", result || "—"));
  }
  entry.append(createElement("div", "ae-header", headerText), content);
  return entry;
}

function buildRecentMatches(values, maps) {
  const indexes = matchIndexes(values);
  const { i1, i3, ergebnisIdx, d } = indexes;

  const all = values.slice(1)
    .filter((row) => {
      if (!Array.isArray(row) || !row[i1]) return false;
      if (/^BYE$/i.test(String(row[i1]))) return false;
      if (row[i3] && /^BYE$/i.test(String(row[i3]))) return false;
      // Nur gespielte Matches (mit Ergebnis oder [wo])
      const erg = ergebnisIdx >= 0 ? String(row[ergebnisIdx] || "").trim() : "";
      const p1raw = String(row[i1] || "").trim();
      const p3raw = String(row[i3] || "").trim();
      const hasWo = /\[w\.?o\.?\]/i.test(p1raw) || /\[w\.?o\.?\]/i.test(p3raw);
      if (!erg && !hasWo) return false;
      return true;
    })
    .sort((a, b) => dateToTs(b[d]) - dateToTs(a[d]))
    .slice(0, 6);

  const fragment = document.createDocumentFragment();
  fragment.append(createElement("div", "archived-title", "Letzte Spiele"));
  if (all.length === 0) {
    fragment.append(createElement("div", "archived-empty", "–"));
    return fragment;
  }

  all.forEach((row) => fragment.append(createMatchEntry(row, indexes, maps, false)));
  return fragment;
}

function buildUpcomingMatches(values, maps) {
  const indexes = matchIndexes(values);
  const { i1, i3, ergebnisIdx, d } = indexes;

  const all = values.slice(1)
    .filter((row) => {
      if (!Array.isArray(row) || !row[i1]) return false;
      if (/^BYE$/i.test(String(row[i1]))) return false;
      if (row[i3] && /^BYE$/i.test(String(row[i3]))) return false;
      // Nur offene Matches (ohne Ergebnis und ohne [wo]/[ret])
      const erg = ergebnisIdx >= 0 ? String(row[ergebnisIdx] || "").trim() : "";
      if (erg) return false;
      const p1raw = String(row[i1] || "");
      const p3raw = String(row[i3] || "");
      if (/\[w\.?o\.?\]/i.test(p1raw) || /\[w\.?o\.?\]/i.test(p3raw)) return false;
      if (/\[ret\]/i.test(p1raw) || /\[ret\]/i.test(p3raw)) return false;
      return true;
    })
    .map((row) => ({ row, ts: dateToTs(row[d]) }))
    .sort((a, b) => {
      if (a.ts && b.ts) return a.ts - b.ts;
      return a.ts ? -1 : b.ts ? 1 : 0;
    })
    .slice(0, 6);

  const fragment = document.createDocumentFragment();
  fragment.append(createElement("div", "archived-title", "Nächste Spiele"));
  if (all.length === 0) {
    fragment.append(createElement("div", "archived-empty", "–"));
    return fragment;
  }

  all.forEach(({ row }) => fragment.append(createMatchEntry(row, indexes, maps, true)));
  return fragment;
}

function buildRasterMap(values) {
  const header = normalizedHeader(values);
  const idIdx = header.indexOf("id");
  const rIdx = header.indexOf("bewerbrunde");
  const map = new Map();
  if (idIdx === -1 || rIdx === -1) return map;
  values.slice(1).forEach((row) => {
    if (!Array.isArray(row)) return;
    const id = String(row[idIdx] || "").trim();
    const raster = String(row[rIdx] || "").trim();
    if (id && raster) map.set(id, raster);
  });
  return map;
}

// ── Hilfsfunktionen DOM ──

const courtActive = { "1": false, "2": false };

function setText(id, value, fallback = "-") {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = value === null || value === undefined || value === "" ? fallback : String(value);
}

function setPlayerName(id, value) {
  const element = document.getElementById(id);
  if (!element) return;
  const name = value === null || value === undefined || value === "" ? "-" : String(value);
  const parts = name.includes(" / ") ? name.split(" / ") : null;
  element.classList.toggle("platz-cell-double", Boolean(parts));
  if (!parts) {
    element.textContent = name;
    return;
  }

  const names = parts.map((part) => createElement("div", "", part.trim()));
  element.replaceChildren(...names);
}

function playerNamesFit(elements) {
  return elements.every((element) => {
    const style = getComputedStyle(element);
    const availableWidth = element.clientWidth
      - parseFloat(style.paddingLeft)
      - parseFloat(style.paddingRight)
      - 4;
    if (availableWidth <= 0) return false;
    const lines = element.classList.contains("platz-cell-double") ? [...element.children] : [element];
    return lines.every((line) => {
      const range = document.createRange();
      range.selectNodeContents(line);
      return range.getBoundingClientRect().width <= availableWidth;
    });
  });
}

function applyCourtPlayerNameSize(elements, fontSize) {
  elements.forEach((element) => {
    element.style.fontSize = `${fontSize}px`;
    element.style.minHeight = "";
  });
  const commonHeight = Math.max(...elements.map((element) => element.offsetHeight));
  elements.forEach((element) => { element.style.minHeight = `${commonHeight}px`; });
}

function sizeCourtPlayerNames(courtKey) {
  const court = document.getElementById(`platz${courtKey}`);
  const elements = [
    document.getElementById(`p${courtKey}-name-h`),
    document.getElementById(`p${courtKey}-name-g`),
  ].filter(Boolean);
  if (!court || elements.length !== 2 || elements.some((element) => element.clientWidth <= 0)) return;

  elements.forEach((element) => {
    element.style.fontSize = "";
    element.style.minHeight = "";
  });
  const maximum = Math.min(...elements.map((element) => parseFloat(getComputedStyle(element).fontSize)));
  let lower = Math.min(8, maximum);
  let upper = maximum;
  const fits = () => playerNamesFit(elements) && court.scrollHeight <= court.clientHeight + 1;

  applyCourtPlayerNameSize(elements, upper);
  if (!fits()) {
    for (let iteration = 0; iteration < 10; iteration++) {
      const candidate = (lower + upper) / 2;
      applyCourtPlayerNameSize(elements, candidate);
      if (fits()) lower = candidate;
      else upper = candidate;
    }
    applyCourtPlayerNameSize(elements, lower);
  }
}

function schedulePlayerNameSizing() {
  if (playerNameSizingFrame !== null) cancelAnimationFrame(playerNameSizingFrame);
  playerNameSizingFrame = requestAnimationFrame(() => {
    playerNameSizingFrame = null;
    sizeCourtPlayerNames("1");
    sizeCourtPlayerNames("2");
  });
}

// ── Verbindungs- und Quellenstatus ──

function setStatusText(element, text) {
  if (element && element.textContent !== text) element.textContent = text;
}

function setStatusClass(element, state) {
  if (!element) return;
  element.classList.remove("is-connected", "is-reconnecting", "is-stale", "is-synchronized", "is-unsynchronized", "is-source-current", "is-source-inactive", "is-source-unknown");
  element.classList.add(`is-${state}`);
}

function formatSourceAge() {
  if (!courtSource || courtSource.ageMs === null) return "unbekannt";
  const elapsed = Math.max(0, Date.now() - courtSource.receivedAt);
  const ageMs = Math.max(0, courtSource.ageMs + elapsed);
  if (ageMs < 1000) return "< 1 s";
  if (ageMs < 60000) return `${Math.floor(ageMs / 1000)} s`;
  if (ageMs < 3600000) return `${Math.floor(ageMs / 60000)} min`;
  return `${Math.floor(ageMs / 3600000)} h`;
}

function currentSourceAge() {
  if (!courtSource || courtSource.ageMs === null) return null;
  return Math.max(0, courtSource.ageMs + Math.max(0, Date.now() - courtSource.receivedAt));
}

function updateStatus() {
  const container = document.getElementById("scoreboard-status");
  const connectionElement = document.getElementById("scoreboard-connection-state");
  const syncElement = document.getElementById("scoreboard-sync-state");
  const sourceElement = document.getElementById("scoreboard-source-state");
  const sourceIsStale = courtSource?.stale === true || (
    courtSource?.active === true
    && currentSourceAge() !== null
    && currentSourceAge() > courtSource.staleAfterMs
  );
  const connectionState = connectionStatus.state === "stale" || sourceIsStale
    ? "stale"
    : connectionStatus.connected ? "connected" : "reconnecting";
  const synchronized = connectionStatus.connected && scoreboardSynchronized;

  const connectionLabels = {
    connected: "Verbunden",
    reconnecting: "Verbindung wird wiederhergestellt",
    stale: "Daten veraltet",
  };
  setStatusText(connectionElement, connectionLabels[connectionState]);
  setStatusClass(connectionElement, connectionState);
  setStatusText(syncElement, synchronized ? "Synchronisiert" : "Nicht synchronisiert");
  setStatusClass(syncElement, synchronized ? "synchronized" : "unsynchronized");

  let sourceText = `Court-Quelle: Alter ${formatSourceAge()}`;
  let sourceState = "source-current";
  if (!courtSource) {
    sourceState = "source-unknown";
  } else if (!courtSource.active) {
    sourceText += ", inaktiv";
    sourceState = "source-inactive";
  } else if (sourceIsStale) {
    sourceText += ", veraltet";
    sourceState = "stale";
  }
  setStatusText(sourceElement, sourceText);
  setStatusClass(sourceElement, sourceState);

  if (container) {
    container.dataset.connectionState = connectionState;
    container.dataset.synchronized = String(synchronized);
  }
}

function updateCourtSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  const suppliedAge = nonNegativeNumber(source.ageMs);
  const lastSuccessAt = nonNegativeNumber(source.lastSuccessAt);
  let ageMs = suppliedAge;
  if (ageMs === null && lastSuccessAt !== null && lastSuccessAt > 0) {
    ageMs = Math.max(0, Date.now() - lastSuccessAt);
  }
  courtSource = {
    active: source.active === true,
    stale: source.stale === true,
    ageMs,
    staleAfterMs: nonNegativeNumber(source.staleAfterMs) || 30000,
    receivedAt: Date.now(),
  };
}

// ── Court data (Live-Scores via dataClient WebSocket) ──

function scoreRevision(data) {
  return nonNegativeNumber(data?.revision);
}

function updateCourt(court) {
  if (!court || typeof court !== "object") return;
  const courtKey = String(court.platz ?? "");
  if (courtKey !== "1" && courtKey !== "2") return;
  const prefix = `p${courtKey}`;
  setText(`${prefix}-h-s1`, court.satz1home);
  setText(`${prefix}-h-s2`, court.satz2home);
  setText(`${prefix}-h-s3`, court.satz3home);
  setText(`${prefix}-h-p`, court.punktehome);
  setText(`${prefix}-g-s1`, court.satz1gast);
  setText(`${prefix}-g-s2`, court.satz2gast);
  setText(`${prefix}-g-s3`, court.satz3gast);
  setText(`${prefix}-g-p`, court.punktegast);
}

function applyScoreData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const revision = scoreRevision(data);
  if (revision !== null && revision < latestScoreRevision) return false;
  if (revision !== null) latestScoreRevision = revision;
  updateCourtSource(data.source);
  if (Array.isArray(data.courts)) {
    data.courts.forEach(updateCourt);
  }
  updateStatus();
  return true;
}

function handleScoreEvent(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const revision = scoreRevision(data);
  const pendingRevision = scoreRevision(latestScoreEvent);
  if (revision !== null && pendingRevision !== null && revision < pendingRevision) return;
  if (revision !== null && revision < latestScoreRevision) return;
  scoreEventSequence++;
  latestScoreEvent = data;
  if (hasRenderedSnapshot) applyScoreData(data);
}

// ── Scoreboard-State (Spielernamen + Bewerb + Aktiv-Status aus stateStore) ──

function updateScoreboardCourt(courtKey, value) {
  if (courtKey !== "1" && courtKey !== "2") return;
  const courtData = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const prefix = `p${courtKey}`;
  setPlayerName(`${prefix}-name-h`, courtData.homePlayer);
  setPlayerName(`${prefix}-name-g`, courtData.guestPlayer);
  setText(`${prefix}-datetime`, parseSheetDate(courtData.dateTime));

  const rawRunde = String(courtData.runde || "").trim();
  let runde = parseRunde(rawRunde) || rawRunde;
  if (!runde && courtData.matchId) {
    const rasterRaw = matchRasterMap.get(String(courtData.matchId)) || "";
    runde = parseRunde(rasterRaw);
  }
  const bewerbParts = [courtData.bewerb, runde].filter(Boolean).map(String);
  setText(`${prefix}-bewerb`, bewerbParts.join(" | "));

  const isActive = courtData.aktiv === 1;
  courtActive[courtKey] = isActive;
  const headerElement = document.querySelector(`#platz${courtKey} .platz-header`);
  if (headerElement) {
    headerElement.classList.remove("court-active", "court-inactive");
    headerElement.classList.add(isActive ? "court-active" : "court-inactive");
  }
}

function applyScoreboardCourts(courts) {
  const values = courts && typeof courts === "object" && !Array.isArray(courts) ? courts : {};
  ["1", "2"].forEach((courtKey) => {
    updateScoreboardCourt(courtKey, Object.prototype.hasOwnProperty.call(values, courtKey) ? values[courtKey] : {});
  });
  schedulePlayerNameSizing();
}

function handleScoreboardStateEvent(data) {
  if (!data?.courts || typeof data.courts !== "object" || Array.isArray(data.courts)) return;
  courtEventSequence++;
  latestCourtEvent = data;
  if (hasRenderedSnapshot) applyScoreboardCourts(data.courts);
}

// ── Atomare Snapshots und Resynchronisierung ──

function createSnapshotError(message, terminal = false) {
  const error = new Error(message);
  error.terminal = terminal;
  return error;
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw createSnapshotError("Scoreboard-Snapshot fehlt", true);
  }
  if (snapshot.success !== true) {
    throw createSnapshotError("Scoreboard-Snapshot wurde abgelehnt", true);
  }
  for (const key of ["playersValues", "bewerbValues", "matchesValues"]) {
    if (!Array.isArray(snapshot[key])) throw createSnapshotError(`Scoreboard-Snapshot enthält kein ${key}`, true);
  }
  if (!snapshot.courts || typeof snapshot.courts !== "object" || Array.isArray(snapshot.courts)) {
    throw createSnapshotError("Scoreboard-Snapshot enthält keine Courts", true);
  }
  if (!snapshot.scores || typeof snapshot.scores !== "object" || Array.isArray(snapshot.scores) || !Array.isArray(snapshot.scores.courts)) {
    throw createSnapshotError("Scoreboard-Snapshot enthält keine Scores", true);
  }
  if (!snapshot.revisions || typeof snapshot.revisions !== "object" || Array.isArray(snapshot.revisions)) {
    throw createSnapshotError("Scoreboard-Snapshot enthält keine Revisionen", true);
  }
  for (const key of ["players", "bewerbe", "matches1"]) {
    const revision = nonNegativeNumber(snapshot.revisions[key]);
    if (revision === null) {
      throw createSnapshotError(`Scoreboard-Snapshot enthält keine gültige ${key}-Revision`, true);
    }
  }
  if (scoreRevision(snapshot.scores) === null) {
    throw createSnapshotError("Scoreboard-Snapshot enthält keine gültige Score-Revision", true);
  }
  return snapshot;
}

function prepareSnapshot(rawSnapshot) {
  const snapshot = validateSnapshot(rawSnapshot);
  const maps = {
    players: buildPlayerMap(snapshot.playersValues),
    bewerbe: buildBewerbMap(snapshot.bewerbValues),
    raster: buildRasterMap(snapshot.matchesValues),
  };
  const targets = {
    upcoming: document.getElementById("nächste"),
    recent: document.getElementById("letzte"),
    content: document.getElementById("scoreboard-content"),
  };
  if (!targets.upcoming || !targets.recent || !targets.content) {
    throw createSnapshotError("Scoreboard-DOM ist unvollständig", true);
  }
  return {
    snapshot,
    maps,
    targets,
    upcoming: buildUpcomingMatches(snapshot.matchesValues, maps),
    recent: buildRecentMatches(snapshot.matchesValues, maps),
  };
}

function selectScoreData(snapshotScores, scoreSequenceAtRequest) {
  if (scoreEventSequence !== scoreSequenceAtRequest && latestScoreEvent) return latestScoreEvent;
  const snapshotRevision = scoreRevision(snapshotScores);
  const eventRevision = scoreRevision(latestScoreEvent);
  if (latestScoreEvent && eventRevision !== null && snapshotRevision !== null && eventRevision > snapshotRevision) {
    return latestScoreEvent;
  }
  if (latestScoreEvent && snapshotRevision !== null && latestScoreRevision > snapshotRevision) return latestScoreEvent;
  return snapshotScores;
}

function renderSnapshot(prepared, courtSequenceAtRequest, scoreSequenceAtRequest) {
  const effectiveCourts = courtEventSequence !== courtSequenceAtRequest && latestCourtEvent?.courts
    ? latestCourtEvent.courts
    : prepared.snapshot.courts;
  const effectiveScores = selectScoreData(prepared.snapshot.scores, scoreSequenceAtRequest);

  matchRasterMap = prepared.maps.raster;
  prepared.targets.upcoming.replaceChildren(prepared.upcoming);
  prepared.targets.recent.replaceChildren(prepared.recent);
  applyScoreboardCourts(effectiveCourts);
  applyScoreData(effectiveScores);
  hasRenderedSnapshot = true;
}

function revealScoreboard() {
  const loader = document.getElementById("scoreboard-loader");
  const content = document.getElementById("scoreboard-content");
  content?.classList.add("loaded");
  loader?.classList.add("hidden");
  setTimeout(() => loader?.remove(), 500);
}

function failInitialization(error) {
  if (initializationFailed || hasRenderedSnapshot) return;
  initializationFailed = true;
  scoreboardSynchronized = false;
  if (snapshotTimer) clearTimeout(snapshotTimer);
  if (snapshotRetryTimer) clearTimeout(snapshotRetryTimer);
  snapshotTimer = null;
  snapshotRetryTimer = null;
  const loader = document.getElementById("scoreboard-loader");
  const loaderText = loader?.querySelector(".loader-text");
  loader?.classList.add("failed");
  loader?.setAttribute("role", "alert");
  if (loaderText) {
    const reference = error?.supportId ? ` Referenz: ${error.supportId}` : "";
    loaderText.textContent = `Scoreboard konnte nicht geladen werden.${reference}`;
  }
  updateStatus();
  console.error("Scoreboard-Initialisierung fehlgeschlagen:", error);
  signalMonitorFailed("SCOREBOARD_INIT_FAILED");
}

function scheduleSnapshotRetry() {
  if (initializationFailed || snapshotRetryTimer || !connectionStatus.connected) return;
  const delay = Math.min(SNAPSHOT_RETRY_MAX_MS, 1000 * (2 ** Math.min(snapshotRetryAttempt, 5)));
  snapshotRetryAttempt++;
  snapshotRetryTimer = setTimeout(() => {
    snapshotRetryTimer = null;
    queueSnapshot();
  }, delay);
}

function queueSnapshot() {
  if (initializationFailed) return;
  if (snapshotRetryTimer) clearTimeout(snapshotRetryTimer);
  snapshotRetryTimer = null;
  snapshotGeneration++;
  snapshotQueued = true;
  scoreboardSynchronized = false;
  updateStatus();
  if (snapshotInFlight || snapshotTimer) return;
  snapshotTimer = setTimeout(drainSnapshots, SNAPSHOT_DEBOUNCE_MS);
}

async function drainSnapshots() {
  snapshotTimer = null;
  if (snapshotInFlight || initializationFailed) return;
  snapshotInFlight = true;
  try {
    while (snapshotQueued && !initializationFailed) {
      snapshotQueued = false;
      const requestGeneration = snapshotGeneration;
      const courtSequenceAtRequest = courtEventSequence;
      const scoreSequenceAtRequest = scoreEventSequence;
      try {
        const response = await readScoreboardSnapshot();
        if (requestGeneration !== snapshotGeneration) continue;
        const prepared = prepareSnapshot(response?.data);
        for (const [table, requiredRevision] of Object.entries(requiredRevisions)) {
          if (requiredRevision !== null && Number(prepared.snapshot.revisions[table]) < requiredRevision) {
            throw createSnapshotError(`Scoreboard-Snapshot ist älter als die ${table}-Invalidierung`);
          }
        }

        const firstRender = !hasRenderedSnapshot;
        renderSnapshot(prepared, courtSequenceAtRequest, scoreSequenceAtRequest);
        snapshotRetryAttempt = 0;
        scoreboardSynchronized = connectionStatus.connected;
        updateStatus();
        if (firstRender) {
          revealScoreboard();
          signalMonitorReady();
        }
      } catch (error) {
        if (requestGeneration !== snapshotGeneration && snapshotQueued) continue;
        scoreboardSynchronized = false;
        updateStatus();
        if (!hasRenderedSnapshot && error?.terminal) failInitialization(error);
        else {
          console.error("Scoreboard-Resynchronisierung fehlgeschlagen:", error);
          scheduleSnapshotRetry();
        }
        break;
      }
    }
  } finally {
    snapshotInFlight = false;
    if (snapshotQueued && !snapshotTimer && !initializationFailed) {
      snapshotTimer = setTimeout(drainSnapshots, SNAPSHOT_DEBOUNCE_MS);
    }
  }
}

function handleTableInvalidation(table, data) {
  const revision = nonNegativeNumber(data?.revision);
  if (revision !== null) {
    requiredRevisions[table] = requiredRevisions[table] === null
      ? revision
      : Math.max(requiredRevisions[table], revision);
  }
  if (data?.current === false) {
    scoreboardSynchronized = false;
    updateStatus();
  }
  queueSnapshot();
}

function handleConnectionState(status) {
  connectionStatus = status;
  if (!status.connected) {
    scoreboardSynchronized = false;
    if (snapshotInFlight) snapshotGeneration++;
    if (snapshotRetryTimer) clearTimeout(snapshotRetryTimer);
    snapshotRetryTimer = null;
  } else if (!hasRenderedSnapshot || !scoreboardSynchronized) {
    queueSnapshot();
  }
  updateStatus();
}

function handleResync() {
  for (const table of Object.keys(requiredRevisions)) requiredRevisions[table] = null;
  latestCourtEvent = null;
  latestScoreEvent = null;
  latestScoreRevision = -1;
  courtEventSequence++;
  scoreEventSequence++;
  queueSnapshot();
}

try {
  subscribe("scores", handleScoreEvent);
  subscribe("scoreboard-state", handleScoreboardStateEvent);
  subscribe("matches", (data) => handleTableInvalidation("matches1", data));
  subscribe("players", (data) => handleTableInvalidation("players", data));
  subscribe("bewerbe", (data) => handleTableInvalidation("bewerbe", data));
  onConnectionState(handleConnectionState);
  onResync(handleResync);
  window.addEventListener("resize", schedulePlayerNameSizing);
  window.visualViewport?.addEventListener("resize", schedulePlayerNameSizing);
  const statusTimer = setInterval(updateStatus, 5000);
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) clearInterval(statusTimer);
  }, { once: true });
} catch (error) {
  failInitialization(error);
}
