import { createEndpoint, subscribeInvalidations } from "./dataClient.js";
import { ready, getUser, isAuthenticated, subscribeAuth } from "./authClient.js";
import { signalMonitorReady, signalMonitorFailed } from "./monitorReady.js";
import { diagnostic } from "./diagnostics.js";
import { isActiveRankingRank, isOpenRankingMatch, parseRankingParticipant, rankingPlayerState } from "./rankingMatchState.js";

const readRlPlatzierung     = createEndpoint("rlPlatzierung");
const readPlayersList       = createEndpoint("players");
const readPreMatches        = createEndpoint("preMatches");
const readMatchRestrictions = createEndpoint("readMatchRestrictions");
const readBewerbe           = createEndpoint("bewerbe");
const readRankingChallengeState = createEndpoint("rankingChallengeState");

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
    if (isOpenRankingMatch(row, {
      result: ergebnisIdx,
      p1: p1Idx,
      p2: p2Idx,
      p3: p3Idx,
      p4: p4Idx,
    })) {
      [row[p1Idx], row[p2Idx], row[p3Idx], row[p4Idx]]
        .filter(Boolean)
        .forEach((id) => busyIds.add(parseRankingParticipant(id).id));
    }
  });
  return { busyIds, preMatches: values };
}

/**
 * Vergleicht Matchdaten mit new Date() (wie clock.js).
 * Gibt zurück, wer Schonzeit (nach Sieg) bzw. Sperrzeit (nach Niederlage) hat.
 */
async function fetchRestrictions() {
  const res = await readMatchRestrictions({ bewerbId: BEWERB_ID });
  const { success, complete, schonzeit = [], sperrzeit = [] } = res?.data || {};
  if (!success || complete !== true) throw new Error("Schutz- und Sperrzeiten sind nicht vollstaendig.");

  return {
    schonzeitMap: new Map(
      schonzeit.map(({ id, until }) => [String(id).trim(), new Date(until)])
    ),
    sperrzeitMap: new Map(
      sperrzeit.map(({ id, until })  => [String(id).trim(), new Date(until)])
    ),
  };
}

/** Identifiziert den aktuell eingeloggten Spieler */
async function fetchMyState() {
  await ready;
  const myPlayerId = String(getUser()?.id || "").trim();
  if (!myPlayerId) return null;
  const state = (await readRankingChallengeState({ bewerbId: BEWERB_ID })).data;
  if (!state?.success || !["ranked", "returning", "newcomer", "ineligible"].includes(state.mode)) {
    throw new Error("Ranglistenstatus ist unvollstaendig.");
  }
  return {
    myPlayerId,
    mode: state.mode,
    myRank: Number.isInteger(Number(state.rank)) && Number(state.rank) > 0 ? Number(state.rank) : null,
    returnFromRank: Number.isInteger(Number(state.returnFromRank)) && Number(state.returnFromRank) > 0
      ? Number(state.returnFromRank)
      : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  ZENTRALE REGEL-FUNKTION  (alle Regeln an einem Ort)
//
//  Reihenfolge der Farbzuweisung:
//   1. Mein Kästchen       → blau  (.selected)
//   2. In offener Forderung → gelb  (.challenged)
//   3. Hat Schonzeit        → lila  (.protected) + Timer
//   4. Ich habe Sperrzeit   → lila  (.protected) + Timer
//   5. Normal forderbar     → grün  (.challengeable)
//   6. Nicht forderbar      → keine Klasse (grau)
//      Ausnahme: hat Schonzeit → lila (sichtbar für alle)
// ═══════════════════════════════════════════════════════════════════════════
async function applyAllRules(container, pyramid, rankedList) {

  // ── Schritt 1: Alle Daten PARALLEL laden (Promise.allSettled = kein Fail)
  diagnostic.info("ranking_rules_load_started");

  const [busyRes, restrictRes, myRes] = await Promise.allSettled([
    fetchBusyIds(),
    fetchRestrictions(),
    fetchMyState(),
  ]);

  const busyData = busyRes.status === "fulfilled"
    ? busyRes.value
    : (diagnostic.warn("ranking_busy_data_load_failed", { error: busyRes.reason }),
       { busyIds: new Set(), preMatches: [] });

  const { schonzeitMap, sperrzeitMap } = restrictRes.status === "fulfilled"
    ? restrictRes.value
    : (diagnostic.warn("ranking_restrictions_load_failed", { error: restrictRes.reason }),
       { schonzeitMap: new Map(), sperrzeitMap: new Map() });
  scheduleRestrictionExpiry([...schonzeitMap.values(), ...sperrzeitMap.values()]);

  const myState = myRes.status === "fulfilled"
    ? myRes.value
    : (diagnostic.warn("ranking_identity_state_load_failed", { error: myRes.reason }), null);

  const ruleDataComplete = busyRes.status === "fulfilled"
    && restrictRes.status === "fulfilled"
    && myRes.status === "fulfilled";
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

  diagnostic.info("ranking_rules_loaded", {
    busyCount: busyData.busyIds.size,
    protectionCount: schonzeitMap.size,
    blockingCount: sperrzeitMap.size,
  });

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
  if (ruleDataComplete && myState?.mode === "newcomer") {
    for (const player of rankedList) {
      if (player.playerId) challengeableIds.add(String(player.playerId).trim());
    }
  } else if (ruleDataComplete && myState?.mode === "returning" && myState.returnFromRank) {
    for (const player of rankedList) {
      if (player.rank >= myState.returnFromRank && player.playerId) {
        challengeableIds.add(String(player.playerId).trim());
      }
    }
  } else if (ruleDataComplete && myRow !== -1 && myCol !== -1) {
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
  for (const player of rankedList) {
    if (!player.active) challengeableIds.delete(String(player.playerId || "").trim());
  }

  // ── Schritt 4: Bin ich selbst gesperrt? (Sperrzeit nach Niederlage)
  const iAmBlocked     = myPlayerId ? sperrzeitMap.has(myPlayerId) : false;
  const myBlockedUntil = iAmBlocked ? sperrzeitMap.get(myPlayerId) : null;

  if (iAmBlocked) diagnostic.info("ranking_current_player_blocked");

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
      if (!isOpenRankingMatch(row, {
        result: pmErgebnisIdx,
        p1: pmP1Idx,
        p2: pmP2Idx,
        p3: pmP3Idx,
        p4: pmP4Idx,
      })) return;
      const players = [pmP1Idx, pmP2Idx, pmP3Idx, pmP4Idx]
        .map((idx) => (idx !== -1 ? parseRankingParticipant(row[idx]).id : ""))
        .filter(Boolean);
      if (players.includes(myPlayerId)) {
        players.forEach((p) => { if (p !== myPlayerId) myChallengeOpponents.add(p); });
      }
    });
  }

  // ── Schritt 6: DOM ATOMAR aktualisieren  ← erst HIER werden Klassen geändert
  container.querySelectorAll(".box").forEach((b) => {
    b.classList.remove("selected", "challengeable", "challenged", "protected",
      "schonzeit", "sperrzeit", "challenge-with-me");
    b.style.cursor = "";
    b.title = "";
    b.querySelector(".box-timer")?.remove();
  });

  pyramid.flat().forEach(({ playerId, box, rank }) => {
    const id = String(playerId).trim();
    const playerState = rankingPlayerState(id, myPlayerId, busyData.busyIds, schonzeitMap, sperrzeitMap);

    // Der blaue Rahmen bleibt erhalten; Schutz-/Sperrstatus und Timer bleiben sichtbar.
    if (playerState.selected) box.classList.add("selected");

    // ── 1. Offene Forderung (gilt für alle, nicht nur forderbare)
    if (playerState.status === "busy") {
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

    // ── 2. Schonzeit nach Sieg → rosa (gilt für alle, nicht nur forderbare)
    if (playerState.status === "protection") {
      box.classList.add("schonzeit");
      box.style.cursor = "default";
      box.title = `Schonzeit nach Sieg – läuft ab am ${schonzeitMap.get(id).toLocaleString("de-AT")}`;
      startProtectionTimer(box, schonzeitMap.get(id));
      return;
    }

    // ── 3. Sperrzeit nach Niederlage → sichtbar für alle
    if (playerState.status === "blocked") {
      box.classList.add("sperrzeit");
      box.title = `Sperrzeit nach Niederlage – läuft ab am ${sperrzeitMap.get(id).toLocaleString("de-AT")}`;
      startProtectionTimer(box, sperrzeitMap.get(id));
    }

    if (playerState.selected) return;

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

  diagnostic.info("ranking_rules_applied", {
    challengeableCount: challengeableIds.size,
    busyCount: [...challengeableIds].filter((id) => busyData.busyIds.has(id)).length,
    protectionCount: [...challengeableIds].filter((id) => schonzeitMap.has(id)).length,
    blockingCount: [...challengeableIds].filter((id) => sperrzeitMap.has(id)).length,
  });

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
  const pActiveIdx = pHeader.indexOf("aktiv");

  const playerMap = new Map();
  playerValues.slice(1).forEach((row) => {
    const id = String(row[pIdIdx] || "").trim();
    const firstName = String(row[pFnIdx] || "").trim();
    const lastName = String(row[pLnIdx] || "").trim();
    if (id) playerMap.set(id, {
      firstName,
      lastName,
      active: pActiveIdx < 0 || String(row[pActiveIdx] || "").trim() === "1",
    });
  });

  const rankedList = rankValues.slice(1)
    .filter((row) => {
      const bewerbId = String(row[bewerbIdIdx] || "").trim();
      return (!BEWERB_ID || bewerbId === BEWERB_ID) && isActiveRankingRank(row[rankIdx]);
    })
    .map((row) => {
      const playerId = String(row[personIdIdx] || "").trim();
      const player = playerMap.get(playerId) || { firstName: "Unbekannt", lastName: "", active: false };
      return {
        bewerbId: String(row[bewerbIdIdx] || "").trim(),
        rank: Number(row[rankIdx]),
        playerId,
        firstName: player.firstName,
        lastName: player.lastName,
        active: player.active,
        name: `${player.firstName} ${player.lastName}`.trim(),
      };
    })
    .sort((a, b) => a.rank - b.rank);

  diagnostic.info("ranking_loaded", { playerCount: rankedList.length });
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
  itemsBox.push('<div class="legend-item"><span class="legend-swatch schonzeit"></span><span>Schonzeit</span></div>');
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
    ${authenticated ? '<button type="button" class="ranking-withdrawn-button">Rausgehängte Spieler</button>' : ""}
  `;
  legend.querySelector(".ranking-withdrawn-button")?.addEventListener("click", () => window.openWithdrawnRankingPlayers?.(BEWERB_ID));
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

  const pyramidContent = document.createElement("div");
  pyramidContent.className = "pyramid-content";
  container.appendChild(pyramidContent);
  const pyramid = [];
  let current = 0, level = 1;

  while (current < rankedList.length) {
    const remaining = rankedList.length - current;
    const rowSize   = Math.min(level, remaining);
    const rowEl     = document.createElement("div");
    rowEl.className = "row";

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
    pyramidContent.appendChild(rowEl);
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
      diagnostic.error("ranking_auth_refresh_failed", error);
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
    diagnostic.error("ranking_initialization_failed", error);
    const container = document.getElementById("rankingContainer");
    if (container) {
      const message = document.createElement("p");
      message.textContent = errorMessage(error, "Rangliste konnte nicht geladen werden.");
      container.replaceChildren(message);
    }
    signalMonitorFailed(error.code || "RANKING_LOAD_FAILED");
  }
});
