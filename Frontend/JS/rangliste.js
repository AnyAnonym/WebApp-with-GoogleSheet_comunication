import { createEndpoint, subscribeInvalidations } from "./dataClient.js";
import { ready, getUser, isAuthenticated, subscribeAuth } from "./authClient.js";
import { signalMonitorReady, signalMonitorFailed } from "./monitorReady.js";

const readRlPlatzierung     = createEndpoint("rlPlatzierung");
const readPlayersList       = createEndpoint("players");
const readPreMatches        = createEndpoint("preMatches");
const readMatchRestrictions = createEndpoint("readMatchRestrictions");
const readBewerbe           = createEndpoint("bewerbe");

const params    = new URLSearchParams(window.location.search);
const BEWERB_ID = params.get("id")
  || document.getElementById("rankingContainer")?.dataset.bewerbId
  || "2";
const protectionIntervals = new Set();
let restrictionExpiryTimer = null;
let rankingRefresh = Promise.resolve();

function queueRankingRefresh() {
  rankingRefresh = rankingRefresh.catch(() => {}).then(() => renderRanking());
  return rankingRefresh;
}

function clearProtectionTimers() {
  for (const interval of protectionIntervals) clearInterval(interval);
  protectionIntervals.clear();
}

function scheduleRestrictionExpiry(dates) {
  if (restrictionExpiryTimer) clearTimeout(restrictionExpiryTimer);
  restrictionExpiryTimer = null;
  const now = Date.now();
  const next = dates.map((date) => date?.getTime()).filter((value) => Number.isFinite(value) && value > now).sort((a, b) => a - b)[0];
  if (!next) return;
  restrictionExpiryTimer = setTimeout(() => {
    restrictionExpiryTimer = null;
    queueRankingRefresh().catch(() => {});
  }, Math.min(2147483647, Math.max(1, next - now + 50)));
}

function errorMessage(value, fallback) {
  if (value instanceof Error && value.message) return value.message;
  if (value?.error?.message) return value.error.message;
  if (typeof value?.error === "string") return value.error;
  if (value?.message) return value.message;
  return fallback;
}

// ═══════════════════════════════════════════════════════════════════════════
//  COUNTDOWN-TIMER (analog zu clock.js: new Date(), update jede Minute)
// ═══════════════════════════════════════════════════════════════════════════
function startProtectionTimer(box, endDate) {
  box.querySelector(".box-timer")?.remove();

  const el = document.createElement("span");
  el.className = "box-timer";
  box.appendChild(el);

  let intervalId = null;

  function tick() {
    const ms = endDate - new Date();   // ← wie clock.js: aktuelles Datum
    if (ms <= 0) {
      if (intervalId) {
        clearInterval(intervalId);
        protectionIntervals.delete(intervalId);
      }
      el.remove();
      return;
    }
    const days  = Math.floor(ms / 86_400_000);
    const hours = Math.floor((ms % 86_400_000) / 3_600_000);
    const mins  = Math.floor((ms % 3_600_000)  /    60_000);
    el.textContent = days > 0 ? `🔒 ${days}T ${hours}h` : `🔒 ${hours}h ${mins}m`;
  }

  tick();
  if (el.isConnected) {
    intervalId = setInterval(tick, 60_000); // jede Minute, wie clock.js
    protectionIntervals.add(intervalId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  DATEN-LOADER  (jeder unabhängig – kein Fehler blockiert den anderen)
// ═══════════════════════════════════════════════════════════════════════════

/** Lädt IDs aller Spieler in offener Forderung + Rohdaten für Gegner-Analyse */
async function fetchBusyIds() {
  const res = await readPreMatches();
  const { success, values = [] } = res?.data || {};
  if (!success || !Array.isArray(values) || values.length < 1) {
    throw new Error("Offene Forderungen sind nicht verfuegbar.");
  }

  const header = values[0].map((h) => h.trim().toLowerCase());
  const bewerbIdx = header.indexOf("bewerbid");
  const ergebnisIdx = header.indexOf("ergebnis");
  const p1Idx = header.indexOf("spieler1id");
  const p2Idx = header.indexOf("spieler2id");
  const p3Idx = header.indexOf("spieler3id");
  const p4Idx = header.indexOf("spieler4id");
  if ([bewerbIdx, ergebnisIdx, p1Idx, p3Idx].includes(-1)) {
    throw new Error("Matchdaten sind unvollstaendig.");
  }

  const busyIds = new Set();
  values.slice(1).forEach((row) => {
    if (bewerbIdx !== -1) {
      const rowBewerb = String(row[bewerbIdx] || "").trim();
      if (rowBewerb !== BEWERB_ID) return;
    }
    // Offen = kein Ergebnis
    const ergebnis = ergebnisIdx !== -1 ? String(row[ergebnisIdx] || "").trim() : "";
    if (!ergebnis) {
      [row[p1Idx], row[p2Idx], row[p3Idx], row[p4Idx]]
        .filter(Boolean)
        .forEach((id) => busyIds.add(String(id).trim().replace(/\[.*?\]/g, "").trim()));
    }
  });
  return { busyIds, preMatches: values };
}

/**
 * Vergleicht Matchdaten mit new Date() (wie clock.js).
 * Gibt zurück, wer Schutzzeit (nach Sieg) bzw. Sperrzeit (nach Niederlage) hat.
 */
async function fetchRestrictions() {
  const res = await readMatchRestrictions({ bewerbId: BEWERB_ID });
  const { success, complete, schutzzeit = [], sperrzeit = [] } = res?.data || {};
  if (!success || complete !== true) throw new Error("Schutz- und Sperrzeiten sind nicht vollstaendig.");

  return {
    schutzzeitMap: new Map(
      schutzzeit.map(({ id, until }) => [String(id).trim(), new Date(until)])
    ),
    sperrzeitMap: new Map(
      sperrzeit.map(({ id, until })  => [String(id).trim(), new Date(until)])
    ),
  };
}

/** Identifiziert den aktuell eingeloggten Spieler */
async function fetchMyState(rankedList) {
  await ready;
  const myPlayerId = String(getUser()?.id || "").trim();
  if (!myPlayerId) return null;

  const myEntry = rankedList.find(
    (player) => String(player.playerId || "").trim() === myPlayerId
  );

  return myEntry
    ? { myPlayerId, myRank: myEntry.rank }
    : { myPlayerId, myRank: null };
}

// ═══════════════════════════════════════════════════════════════════════════
//  ZENTRALE REGEL-FUNKTION  (alle Regeln an einem Ort)
//
//  Reihenfolge der Farbzuweisung:
//   1. Mein Kästchen       → blau  (.selected)
//   2. In offener Forderung → gelb  (.challenged)
//   3. Hat Schutzzeit       → lila  (.protected) + Timer
//   4. Ich habe Sperrzeit   → lila  (.protected) + Timer
//   5. Normal forderbar     → grün  (.challengeable)
//   6. Nicht forderbar      → keine Klasse (grau)
//      Ausnahme: hat Schutzzeit → lila (sichtbar für alle)
// ═══════════════════════════════════════════════════════════════════════════
async function applyAllRules(container, pyramid, rankedList) {

  // ── Schritt 1: Alle Daten PARALLEL laden (Promise.allSettled = kein Fail)
  console.log("📊 Lade Ranglisten-Daten parallel...");

  const [busyRes, restrictRes, myRes] = await Promise.allSettled([
    fetchBusyIds(),
    fetchRestrictions(),
    fetchMyState(rankedList),
  ]);

  const busyData = busyRes.status === "fulfilled"
    ? busyRes.value
    : (console.warn("⚠️ BusyIds nicht geladen:", busyRes.reason),
       { busyIds: new Set(), preMatches: [] });

  const { schutzzeitMap, sperrzeitMap } = restrictRes.status === "fulfilled"
    ? restrictRes.value
    : (console.warn("⚠️ Beschränkungen nicht geladen:", restrictRes.reason),
       { schutzzeitMap: new Map(), sperrzeitMap: new Map() });
  scheduleRestrictionExpiry([...schutzzeitMap.values(), ...sperrzeitMap.values()]);

  const myState = myRes.status === "fulfilled"
    ? myRes.value
    : (console.warn("⚠️ Eigener Spieler nicht geladen:", myRes.reason), null);

  const ruleDataComplete = busyRes.status === "fulfilled" && restrictRes.status === "fulfilled";
  let warning = document.getElementById("rankingDataWarning");
  if (!ruleDataComplete && !warning) {
    warning = document.createElement("div");
    warning.id = "rankingDataWarning";
    warning.className = "ranking-data-warning";
    warning.setAttribute("role", "alert");
    container.parentElement?.insertBefore(warning, container);
  }
  if (warning) {
    warning.textContent = ruleDataComplete
      ? ""
      : "Forderungen sind voruebergehend deaktiviert, weil Regeldaten unvollstaendig sind.";
    warning.hidden = ruleDataComplete;
  }

  console.log(`✅ Daten geladen | Busy: ${busyData.busyIds.size} | Schutz: ${schutzzeitMap.size} | Sperre: ${sperrzeitMap.size}`);

  // ── Schritt 2: Meine Position in der Pyramide finden
  let myPlayerId = null, myRow = -1, myCol = -1;

  if (myState?.myRank != null) {
    myPlayerId = myState.myPlayerId;
    for (let r = 0; r < pyramid.length; r++) {
      const idx = pyramid[r].findIndex((p) => p.rank === myState.myRank);
      if (idx !== -1) { myRow = r; myCol = idx; break; }
    }
  } else if (myState?.myPlayerId) {
    myPlayerId = myState.myPlayerId;
  }

  // ── Schritt 3: Forderbare IDs berechnen (Regelwerk)
  const challengeableIds = new Set();
  if (ruleDataComplete && myRow !== -1 && myCol !== -1) {
    const me = pyramid[myRow][myCol];

    // Gleiche Zeile – alle links von mir
    for (let i = 0; i < myCol; i++) {
      const p = pyramid[myRow][i];
      if (p?.playerId) challengeableIds.add(String(p.playerId).trim());
    }

    // Reihe darüber – alle rechts von meiner Spalte
    const rowAbove = pyramid[myRow - 1];
    if (Array.isArray(rowAbove)) {
      for (let j = myCol; j < rowAbove.length; j++) {
        const p = rowAbove[j];
        if (p?.playerId) challengeableIds.add(String(p.playerId).trim());
      }
    }

    // Ausnahme: Rang 3 darf auch Rang 1 fordern
    if (me.rank === 3) {
      const rank1 = pyramid.flat().find((p) => p.rank === 1);
      if (rank1?.playerId) challengeableIds.add(String(rank1.playerId).trim());
    }
  }

  // ── Schritt 4: Bin ich selbst gesperrt? (Sperrzeit nach Niederlage)
  const iAmBlocked     = myPlayerId ? sperrzeitMap.has(myPlayerId) : false;
  const myBlockedUntil = iAmBlocked ? sperrzeitMap.get(myPlayerId) : null;

  if (iAmBlocked) {
    console.log(`⛔ Du bist gesperrt bis: ${myBlockedUntil.toLocaleString("de-AT")}`);
  }

  // ── Schritt 4b: Habe ich selbst eine offene Forderung?
  const iAmBusy = myPlayerId ? busyData.busyIds.has(myPlayerId) : false;

  // ── Schritt 5: Gegner bei Forderungen mit mir ermitteln
  const myChallengeOpponents = new Set();
  if (myPlayerId && busyData.preMatches.length >= 2) {
    const pmHeader = busyData.preMatches[0].map((h) => h.trim().toLowerCase());
    const pmP1Idx = pmHeader.indexOf("spieler1id");
    const pmP2Idx = pmHeader.indexOf("spieler2id");
    const pmP3Idx = pmHeader.indexOf("spieler3id");
    const pmP4Idx = pmHeader.indexOf("spieler4id");
    const pmErgebnisIdx = pmHeader.indexOf("ergebnis");
    const pmBewerbIdx = pmHeader.indexOf("bewerbid");
    busyData.preMatches.slice(1).forEach((row) => {
      if (pmBewerbIdx !== -1 && String(row[pmBewerbIdx] || "").trim() !== BEWERB_ID) return;
      // Offen = kein Ergebnis
      const ergebnis = pmErgebnisIdx !== -1 ? String(row[pmErgebnisIdx] || "").trim() : "";
      if (ergebnis) return; // Gespielt → nicht relevant für Gegner-Analyse
      const players = [pmP1Idx, pmP2Idx, pmP3Idx, pmP4Idx]
        .map((idx) => (idx !== -1 ? String(row[idx] || "").trim() : ""))
        .filter(Boolean);
      if (players.includes(myPlayerId)) {
        players.forEach((p) => { if (p !== myPlayerId) myChallengeOpponents.add(p); });
      }
    });
  }

  // ── Schritt 6: DOM ATOMAR aktualisieren  ← erst HIER werden Klassen geändert
  container.querySelectorAll(".box").forEach((b) => {
    b.classList.remove("selected", "challengeable", "challenged", "protected",
      "schutz", "sperrzeit", "challenge-with-me");
    b.style.cursor = "";
    b.title = "";
    b.querySelector(".box-timer")?.remove();
  });

  // Mein Kästchen → immer blau
  if (myRow !== -1 && myCol !== -1) {
    pyramid[myRow][myCol].box.classList.add("selected");
  }

  pyramid.flat().forEach(({ playerId, box, rank }) => {
    const id = String(playerId).trim();

    // Eigenes Kästchen nie überschreiben
    if (myPlayerId && id === myPlayerId) return;

    // ── 1. Offene Forderung (gilt für alle, nicht nur forderbare)
    if (busyData.busyIds.has(id)) {
      box.classList.add("challenged");
      if (myChallengeOpponents.has(id)) {
        // Forderung MIT mir → gelber Hintergrund + blauer Rahmen
        box.classList.add("challenge-with-me");
      }
      // Forderung zwischen anderen → gelber Hintergrund + schwarzer Rahmen
      box.style.cursor = "not-allowed";
      box.title = "Dieser Spieler hat bereits eine offene Forderung";
      return;
    }

    // ── 2. Schutzzeit nach Sieg → rosa (gilt für alle, nicht nur forderbare)
    if (schutzzeitMap.has(id)) {
      box.classList.add("schutz");
      box.style.cursor = "default";
      box.title = `Schutzzeit nach Sieg – läuft ab am ${schutzzeitMap.get(id).toLocaleString("de-AT")}`;
      startProtectionTimer(box, schutzzeitMap.get(id));
      return;
    }

    // ── 3. Sperrzeit nach Niederlage → sichtbar für alle
    if (sperrzeitMap.has(id)) {
      box.classList.add("sperrzeit");
      box.title = `Sperrzeit nach Niederlage – läuft ab am ${sperrzeitMap.get(id).toLocaleString("de-AT")}`;
      startProtectionTimer(box, sperrzeitMap.get(id));
    }

    // ── 4. Nur forderbare Positionen werden hier weiter behandelt
    if (challengeableIds.has(id)) {
      if (iAmBusy) {
        // Ich habe bereits eine offene Forderung → nicht forderbar
        box.title = "Du hast bereits eine offene Forderung";
        box.style.cursor = "not-allowed";

      } else if (iAmBlocked) {
        // Ich selbst habe Sperrzeit → forderbare Positionen sind nicht klickbar
        box.style.cursor = "not-allowed";
        box.title = `Du hast Sperrzeit – läuft ab am ${myBlockedUntil.toLocaleString("de-AT")}`;

      } else {
        // Alles OK → grün, kann gefordert werden
        box.classList.add("challengeable");
        box.style.cursor = "grab";
        box.title = "Diesen Spieler fordern";
      }
    }
    // ── 4. Nicht forderbar, kein gelb/lila → bleibt grau (keine Klasse)
  });

  console.log(`🎨 Forderbar: ${challengeableIds.size} | Busy: ${
    [...challengeableIds].filter(id => busyData.busyIds.has(id)).length} | Schutz: ${
    [...challengeableIds].filter(id => schutzzeitMap.has(id)).length} | Sperre: ${
    [...challengeableIds].filter(id => sperrzeitMap.has(id)).length}`);

  return myState;
}

// ═══════════════════════════════════════════════════════════════════════════
//  RANGLISTE LADEN
// ═══════════════════════════════════════════════════════════════════════════
export async function loadRanking() {
  const [rankRes, playersRes] = await Promise.all([
    readRlPlatzierung({ bewerbId: BEWERB_ID }),
    readPlayersList(),
  ]);

  if (!rankRes.data?.success || !playersRes.data?.success) {
    const failedData = !rankRes.data?.success ? rankRes.data : playersRes.data;
    throw new Error(errorMessage(failedData, "Fehler beim Laden der Ranglisten-Daten."));
  }

  const rankValues = rankRes.data.values || [];
  const playerValues = playersRes.data.values || [];

  if (rankValues.length < 2 || playerValues.length < 2) return [];

  const rHeader = rankValues[0].map((h) => String(h || "").trim().toLowerCase());
  const bewerbIdIdx = rHeader.indexOf("bewerbid");
  const rankIdx = rHeader.indexOf("rang");
  const personIdIdx = rHeader.indexOf("personid");

  const pHeader = playerValues[0].map((h) => String(h || "").trim().toLowerCase());
  const pIdIdx = pHeader.indexOf("id");
  const pFnIdx = pHeader.indexOf("vorname");
  const pLnIdx = pHeader.indexOf("nachname");

  const playerMap = new Map();
  playerValues.slice(1).forEach((row) => {
    const id = String(row[pIdIdx] || "").trim();
    const firstName = String(row[pFnIdx] || "").trim();
    const lastName = String(row[pLnIdx] || "").trim();
    if (id) playerMap.set(id, { firstName, lastName });
  });

  const rankedList = rankValues.slice(1)
    .filter((row) => {
      const bewerbId = String(row[bewerbIdIdx] || "").trim();
      return !BEWERB_ID || bewerbId === BEWERB_ID;
    })
    .map((row) => {
      const playerId = String(row[personIdIdx] || "").trim();
      const player = playerMap.get(playerId) || { firstName: "Unbekannt", lastName: "" };
      return {
        bewerbId: String(row[bewerbIdIdx] || "").trim(),
        rank: Number(row[rankIdx]),
        playerId,
        firstName: player.firstName,
        lastName: player.lastName,
        name: `${player.firstName} ${player.lastName}`.trim(),
      };
    })
    .sort((a, b) => a.rank - b.rank);

  console.log(`🏆 ${rankedList.length} Spieler geladen (BewerbID: ${BEWERB_ID})`);
  return rankedList;
}

// ═══════════════════════════════════════════════════════════════════════════
//  PYRAMIDE AUFBAUEN
// ═══════════════════════════════════════════════════════════════════════════
function renderRankingLegend() {
  const section = document.getElementById("rankingSection");
  if (!section) return;

  const heading = section.querySelector("h2");
  let body = section.querySelector(".ranking-body");
  if (!body) {
    body = document.createElement("div");
    body.className = "ranking-body";
    if (heading && heading.nextSibling) {
      section.insertBefore(body, heading.nextSibling);
    } else {
      section.appendChild(body);
    }
  }

  const container = document.getElementById("rankingContainer");
  if (container && container.parentElement !== body) {
    body.appendChild(container);
  }

  let legend = document.getElementById("rankingLegend");
  if (!legend) {
    legend = document.createElement("div");
    legend.id = "rankingLegend";
    legend.className = "ranking-legend";
    body.insertBefore(legend, body.firstChild);
  }

  const authenticated = isAuthenticated();

  const itemsBox = [];
  const itemsFrame = [];
  // "Forderbar" und "Ich" nur sichtbar für eingeloggte Nutzer
  if (authenticated) {
    itemsBox.push('<div class="legend-item"><span class="legend-swatch challengeable"></span><span>Forderbar</span></div>');
    itemsBox.push('<div class="legend-item"><span class="legend-swatch selected"></span><span>Ich</span></div>');
  }
  // Diese Einträge sind für alle sichtbar
  itemsBox.push('<div class="legend-item"><span class="legend-swatch challenged"></span><span>In offener Forderung</span></div>');
  itemsBox.push('<div class="legend-item"><span class="legend-swatch schutz"></span><span>Schutzzeit</span></div>');
  itemsBox.push('<div class="legend-item"><span class="legend-swatch sperrzeit"></span><span>Sperrzeit</span></div>');

  // Rahmen-Sektion (nur für eingeloggte Nutzer)
  if (authenticated) {
    itemsFrame.push('<div class="legend-item"><span class="legend-swatch challenge-with-me"></span><span>Mit mir in einer offenen Forderung</span></div>');
  }

  const sections = [];
  sections.push('<div class="legend-subheading">Kästchen</div>');
  sections.push('<div class="legend-items">' + itemsBox.join("") + '</div>');
  if (itemsFrame.length) {
    sections.push('<div class="legend-subheading">Rahmen</div>');
    sections.push('<div class="legend-items">' + itemsFrame.join("") + '</div>');
  }

  legend.innerHTML = `
    <div class="legend-label">Legende:</div>
    ${sections.join("\n")}
  `;
}

export async function renderRanking() {
  const container = document.getElementById("rankingContainer");
  if (!container) {
    const error = new Error("Ranglisten-Container fehlt.");
    error.code = "RANKING_CONTAINER_MISSING";
    throw error;
  }

  await ready;
  clearProtectionTimers();

  const h2 = document.querySelector("#rankingSection h2");
  if (h2) {
    try {
      const res = await readBewerbe();
      const bewerbeValues = res.data?.values || [];
      if (bewerbeValues.length > 1) {
        const bHeader = bewerbeValues[0].map((h) => h.trim().toLowerCase());
        const bIdIdx = bHeader.indexOf("id");
        const bBezIdx = bHeader.indexOf("bezeichnung");
        const bewerbRow = bewerbeValues.slice(1).find((r) => String(r[bIdIdx] || "").trim() === BEWERB_ID);
        h2.textContent = bewerbRow ? (bewerbRow[bBezIdx] || "Rangliste") : "Rangliste";
      } else {
        h2.textContent = "Rangliste";
      }
    } catch {
      h2.textContent = "Rangliste";
    }
  }

  renderRankingLegend();

  const rankedList = await loadRanking();
  container.replaceChildren();

  if (!rankedList.length) {
    const message = document.createElement("p");
    message.textContent = "Es gibt noch keine Spieler für diese Rangliste.";
    container.appendChild(message);
    return;
  }

  rankedList.sort((a, b) => a.rank - b.rank);

  const pyramid = [];
  let current = 0, level = 1;

  while (current < rankedList.length) {
    const remaining = rankedList.length - current;
    const rowSize   = Math.min(level, remaining);
    const rowEl     = document.createElement("div");
    rowEl.className = "row";
    rowEl.style.justifyContent = "flex-start";
    rowEl.style.gap = "20px";

    const rowBoxes = [];

    for (let i = 0; i < rowSize && current < rankedList.length; i++, current++) {
      const player = rankedList[current];
      const box    = document.createElement("div");
      box.className = "box";

      const rankElement = document.createElement("span");
      rankElement.className = "box-rank-bg";
      rankElement.textContent = String(player.rank);

      const nameElement = document.createElement("span");
      nameElement.className = "box-name";
      nameElement.appendChild(document.createTextNode(player.firstName || "Unbekannt"));
      nameElement.appendChild(document.createElement("br"));
      nameElement.appendChild(document.createTextNode(player.lastName || ""));

      box.appendChild(rankElement);
      box.appendChild(nameElement);

      rowEl.appendChild(box);
      box.addEventListener("click", () => {
        window.openProfileModal?.({
          playerId: player.playerId || "",
          boxElement: box,
          bewerbId: BEWERB_ID,
          canChallenge: box.classList.contains("challengeable"),
        });
      });

      rowBoxes.push({
        rank:     player.rank,
        playerId: String(player.playerId || "").trim(),
        name:     player.name,
        box,
      });
    }

    // Leere Platzhalter für visuelle Balance
    for (let i = rowSize; i < level; i++) {
      const ph = document.createElement("div");
      ph.className = "box";
      ph.style.visibility = "hidden";
      rowEl.appendChild(ph);
    }

    pyramid.push(rowBoxes);
    container.appendChild(rowEl);
    level++;
  }

  // Alle Regeln anwenden (Daten zuerst, dann DOM)
  const myState = await applyAllRules(container, pyramid, rankedList);
  renderRankingLegend();
}

let rankingInitialized = false;
let observedUserId = null;

subscribeAuth((user) => {
  const nextUserId = String(user?.id || "");
  const authChanged = rankingInitialized && nextUserId !== observedUserId;
  observedUserId = nextUserId;
  if (!authChanged) return;

  if (!user) {
    document.querySelectorAll("#rankingContainer .box").forEach((box) => {
      box.classList.remove("selected", "challengeable", "challenge-with-me");
    });
    renderRankingLegend();
  }

  rankingRefresh = queueRankingRefresh()
    .catch((error) => {
      console.error("Rangliste konnte nach der Authentifizierungsänderung nicht aktualisiert werden:", error);
    });
});

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await ready;
    const initialUserId = String(getUser()?.id || "");
    observedUserId = initialUserId;
    let renderedUserId = initialUserId;

    try {
      await renderRanking();
    } catch (error) {
      const changedUserId = String(getUser()?.id || "");
      if (changedUserId === initialUserId) throw error;
      await renderRanking();
      renderedUserId = changedUserId;
    }

    const latestSessionId = String(getUser()?.id || "");
    if (latestSessionId !== renderedUserId) await renderRanking();
    observedUserId = latestSessionId;
    rankingInitialized = true;
    subscribeInvalidations(["ranking", "matches", "players", "bewerbe"], () => {
      return queueRankingRefresh();
    });
    signalMonitorReady();
  } catch (error) {
    console.error("Rangliste konnte nicht initialisiert werden:", error);
    const container = document.getElementById("rankingContainer");
    if (container) {
      const message = document.createElement("p");
      message.textContent = errorMessage(error, "Rangliste konnte nicht geladen werden.");
      container.replaceChildren(message);
    }
    signalMonitorFailed(error.code || "RANKING_LOAD_FAILED");
  }
});
