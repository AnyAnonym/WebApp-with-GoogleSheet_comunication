import { createEndpoint, subscribeInvalidations } from "./dataClient.js";
import { getUser, ready, subscribeAuth } from "./authClient.js";
import { callWithRetry, showLoadingOverlay, hideLoadingOverlay, showErrorOverlay } from "./loadingHelper.js";
import { signalMonitorReady, signalMonitorFailed } from "./monitorReady.js";

// preMatches endpoint beibehalten für Kompatibilität, wird aber nicht mehr verwendet
// const readPreMatches  = createEndpoint("preMatches");
const readMatchesList = createEndpoint("matches");
const readPlayersList = createEndpoint("players");
const readBewerbe     = createEndpoint("bewerbe");
const readBewerbsart  = createEndpoint("bewerbsart");
let renderGeneration = 0;
const profileLinkContainers = new WeakSet();
let layoutResizeObserver = null;

export function invalidateRoundRobinRender() {
  renderGeneration++;
}

// ── Hilfsfunktionen ──

function parseGroup(val) {
  if (!val) return null;
  const s = String(val).trim().toUpperCase();
  const m = s.match(/^G(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function parsePlayerId(raw) {
  const value = String(raw || "").trim();
  if (value.endsWith("[wo]")) return value.slice(0, -4).trim();
  if (value.endsWith("[ret]")) return value.slice(0, -5).trim();
  return value;
}

function playerMarker(raw) {
  const value = String(raw || "").trim();
  return value.endsWith("[wo]") ? "wo" : value.endsWith("[ret]") ? "ret" : null;
}

// ── Aufstiegs-/Abstiegslogik (austauschbar) ──
// Kodierung: "<Rang><Farbe>(<Anzahl>)" getrennt durch "/"
// Rang: Ziffer (1,2,3...) = Tabellenrang in der Gruppe
// Farbe: G = Grün (Aufsteiger), R = Rot (Absteiger) [R noch nicht implementiert]
// Anzahl: A = Alle dieses Rangs, oder Zahl = nur die besten X dieses Rangs
// Bsp: "1G(A)/2G(A)/3G(1)" = Alle Ersten+Zweiten grün, bester Dritter grün
// Vergleich "Beste": 1. Siege, 2. Satzdifferenz, 3. Gamedifferenz

function parsePromotion(raw) {
  if (!raw) return [];
  const rules = [];
  const parts = String(raw).trim().split("/").filter(Boolean);
  parts.forEach((part) => {
    const m = part.match(/^(\d+)([GR])\((\w+)\)$/i);
    if (!m) return;
    const rang = parseInt(m[1], 10);
    const color = m[2].toUpperCase();
    const countRaw = m[3].toUpperCase();
    const count = countRaw === "A" ? Infinity : parseInt(countRaw, 10);
    if (!isNaN(rang) && !isNaN(count)) {
      rules.push({ rang, color, count });
    }
  });
  return rules;
}

function determinePromotedPlayers(sortedGroupRows, promotionRules) {
  // sortedGroupRows: Array von { gNum, rows: [{ id, siege, saetzeW, saetzeL, gamesW, gamesL, ... }] }
  // Returns: Set von player-IDs die promoted (grün) sind
  const promoted = new Set();

  promotionRules.forEach((rule) => {
    if (rule.color !== "G") return; // Nur Grün vorerst

    // Alle Spieler mit diesem Rang aus allen Gruppen sammeln
    const candidates = [];
    sortedGroupRows.forEach(({ rows }) => {
      const rang = rule.rang;
      if (rang <= rows.length) {
        const player = rows[rang - 1];
        candidates.push(player);
      }
    });

    if (rule.count === Infinity || rule.count >= candidates.length) {
      // Alle dieses Rangs aufsteigen
      candidates.forEach((p) => promoted.add(p.id));
    } else {
      // Nur die besten X: sortieren nach Siege → Satzdiff → Gamediff
      candidates.sort((a, b) => {
        if (b.siege !== a.siege) return b.siege - a.siege;
        const satzdiffA = a.saetzeW - a.saetzeL;
        const satzdiffB = b.saetzeW - b.saetzeL;
        if (satzdiffB !== satzdiffA) return satzdiffB - satzdiffA;
        return (b.gamesW - b.gamesL) - (a.gamesW - a.gamesL);
      });
      for (let i = 0; i < rule.count && i < candidates.length; i++) {
        promoted.add(candidates[i].id);
      }
    }
  });

  return promoted;
}
// ── Ende Aufstiegs-/Abstiegslogik ──

function parseResult(val) {
  if (!val) return null;
  const parts = String(val).trim().split("/").filter(Boolean);
  if (parts.length === 0) return null;
  const sets = [];
  for (const p of parts) {
    if (p.includes("[ret]")) continue;
    const sc = p.replace(/\(\d+\)/g, "").split("-");
    if (sc.length !== 2) continue;
    const a = parseInt(sc[0], 10);
    const b = parseInt(sc[1], 10);
    if (isNaN(a) || isNaN(b)) continue;
    sets.push({ left: a, right: b });
  }
  return sets.length > 0 ? sets : null;
}

function formatPlayerName(id, playerMap) {
  return playerMap.get(id) || "—";
}

function escapeHtml(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, (char) => entities[char]);
}

function formatPlayerHtml(playerId, playerMap) {
  const name = escapeHtml(formatPlayerName(playerId, playerMap));
  if (!playerId) return `<span class="rr-player-name">${name}</span>`;
  return `<button type="button" class="rr-player" data-player-id="${escapeHtml(playerId)}">${name}</button>`;
}

function formatTeamHtml(pid1, pid2, playerMap) {
  const player1 = formatPlayerHtml(pid1, playerMap);
  if (!pid2) return player1;
  const player2 = formatPlayerHtml(pid2, playerMap);
  return `${player1}<span class="rr-team-sep"> / </span>${player2}`;
}

function bindProfileLinks(container) {
  if (profileLinkContainers.has(container)) return;
  profileLinkContainers.add(container);
  container.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const player = event.target.closest(".rr-player[data-player-id]");
    if (!player || !container.contains(player)) return;
    window.openProfileModal?.({ playerId: player.dataset.playerId });
  });
}

function parseSheetDate(raw) {
  if (!raw) return "";
  const m = String(raw).trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return String(raw).trim();
  const [, , mm, dd, hh, mi] = m;
  return `${dd}.${mm}. - ${hh}:${mi}`;
}

function dateToTs(raw) {
  if (!raw) return Infinity;
  const m = String(raw).trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return Infinity;
  const [, yy, mm, dd, hh, mi] = m;
  const yyyy = parseInt(yy, 10) >= 50 ? 1900 + parseInt(yy) : 2000 + parseInt(yy);
  return new Date(yyyy, parseInt(mm) - 1, parseInt(dd), parseInt(hh), parseInt(mi)).getTime();
}

// Paarungslayout:
// 0 = Datum + Uhrzeit (alle)
// 1 = nur Uhrzeit (alle)
// 2 = ohne Datum/Uhrzeit (alle)
// 3 = gespielte: Datum + Uhrzeit, offene: immer Datum + Uhrzeit
// 4 = gespielte: nur Uhrzeit, offene: immer Datum + Uhrzeit
// 5 = gespielte: ohne Datum/Uhrzeit, offene: immer Datum + Uhrzeit
function formatPairingDate(datumRaw, played, paarungslayout) {
  const pl = parseInt(paarungslayout) || 0;

  if (!datumRaw) return "";
  const m = String(datumRaw).trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return "";
  const [, , mm, dd, hh, mi] = m;
  const fullDate = `${dd}.${mm}. - ${hh}:${mi}`;
  const timeOnly = `${hh}:${mi}`;

  // Offene Spiele: bei 3/4/5 immer Datum + Uhrzeit
  if (!played && pl >= 3 && pl <= 5) return fullDate;

  if (pl === 2 || pl === 5) return "";
  if (pl === 1 || pl === 4) return timeOnly;
  return fullDate;
}

// ── Spieler aus preMatches und matches sammeln (inkl. Doppel) ──

function collectPlayers(data, header, bewerbId) {
  const h = header.map((c) => String(c).trim().toLowerCase());
  const bwIdx = h.indexOf("bewerbid");
  const rtIdx = h.indexOf("bewerbrunde");
  const p1Idx = h.indexOf("spieler1id");
  const p2Idx = h.indexOf("spieler2id");
  const p3Idx = h.indexOf("spieler3id");
  const p4Idx = h.indexOf("spieler4id");

  const entries = [];
  data.forEach((row) => {
    if (bwIdx >= 0 && String(row[bwIdx] || "").trim() !== String(bewerbId).trim()) return;
    const g = parseGroup(rtIdx >= 0 ? String(row[rtIdx] || "").trim() : "");
    if (g === null) return;

    const id1 = parsePlayerId(row[p1Idx]);
    const id2 = p2Idx >= 0 ? parsePlayerId(row[p2Idx]) : "";
    const id3 = p3Idx >= 0 ? parsePlayerId(row[p3Idx]) : "";
    const id4 = p4Idx >= 0 ? parsePlayerId(row[p4Idx]) : "";

    // Team-Key: für Doppel "id1+id2", für Einzel nur "id1"
    if (id1) entries.push({ group: g, id: id1, partnerId: id2 });
    if (id3) entries.push({ group: g, id: id3, partnerId: id4 });
  });
  return entries;
}

// ── Statistik aus gespielten Matches ──

export function buildStats(matchData, matchHeader, bewerbId) {
  const h = matchHeader.map((c) => String(c).trim().toLowerCase());
  const bwIdx = h.indexOf("bewerbid");
  const p1Idx = h.indexOf("spieler1id");
  const p2Idx = h.indexOf("spieler2id");
  const p3Idx = h.indexOf("spieler3id");
  const p4Idx = h.indexOf("spieler4id");
  // gewinner wird nicht mehr verwendet (aus Ergebnis berechnet)
  const ergebnisIdx = h.indexOf("ergebnis");

  const stats = {};
  const playerMatches = {};

  matchData.forEach((row) => {
    if (bwIdx >= 0 && String(row[bwIdx] || "").trim() !== String(bewerbId).trim()) return;

    const id1 = parsePlayerId(row[p1Idx]);
    const id2 = p2Idx >= 0 ? parsePlayerId(row[p2Idx]) : "";
    const id3 = p3Idx >= 0 ? parsePlayerId(row[p3Idx]) : "";
    const id4 = p4Idx >= 0 ? parsePlayerId(row[p4Idx]) : "";
    const rawResult = ergebnisIdx !== -1 ? String(row[ergebnisIdx] || "").trim() : "";
    const recordedSets = parseResult(rawResult);
    const firstTeamMarkers = [p1Idx, p2Idx].filter((index) => index >= 0).map((index) => playerMarker(row[index]));
    const secondTeamMarkers = [p3Idx, p4Idx].filter((index) => index >= 0).map((index) => playerMarker(row[index]));
    const firstTeamWalkover = firstTeamMarkers.includes("wo");
    const secondTeamWalkover = secondTeamMarkers.includes("wo");
    const firstTeamRetired = firstTeamMarkers.includes("ret");
    const secondTeamRetired = secondTeamMarkers.includes("ret");
    const hasWalkover = firstTeamWalkover || secondTeamWalkover;
    const hasRetirement = firstTeamRetired || secondTeamRetired;
    const sets = firstTeamWalkover
      ? [{ left: 0, right: 6 }, { left: 0, right: 6 }]
      : secondTeamWalkover
        ? [{ left: 6, right: 0 }, { left: 6, right: 0 }]
        : recordedSets;
    const isPlayed = Boolean(rawResult || hasWalkover || hasRetirement);

    // Gewinner aus Ergebnis berechnen
    let winner = firstTeamWalkover || firstTeamRetired ? id3 : secondTeamWalkover || secondTeamRetired ? id1 : "";
    if (!winner && sets) {
      let setsLeft = 0, setsRight = 0;
      sets.forEach((s) => { if (s.left > s.right) setsLeft++; else if (s.right > s.left) setsRight++; });
      if (setsLeft > setsRight) winner = id1;
      else if (setsRight > setsLeft) winner = id3;
    }

    // Für Einzel: key = id1/id3; für Doppel: key = id1 (Hauptspieler)
    const teams = [
      { key: id1, partner: id2, oppKey: id3, oppPartner: id4, side: 0 },
      { key: id3, partner: id4, oppKey: id1, oppPartner: id2, side: 1 },
    ];

    teams.forEach(({ key, oppKey, oppPartner, side }) => {
      if (!key) return;
      if (!isPlayed) return;
      if (!stats[key]) stats[key] = { siege: 0, saetzeW: 0, saetzeL: 0, gamesW: 0, gamesL: 0 };
      if (winner === key) stats[key].siege++;
      if (sets) {
        sets.forEach((s) => {
          const mine = side === 0 ? s.left : s.right;
          const opp = side === 0 ? s.right : s.left;
          stats[key].gamesW += mine;
          stats[key].gamesL += opp;
          if (mine > opp) stats[key].saetzeW++;
          else if (opp > mine) stats[key].saetzeL++;
        });
      }
      if (oppKey) {
        if (!playerMatches[key]) playerMatches[key] = [];
        const markerResult = hasWalkover ? "wo" : hasRetirement ? "ret" : "—";
        playerMatches[key].push({ opponent: oppKey, oppPartner, result: rawResult || markerResult });
      }
    });
  });

  return { stats, playerMatches };
}

// ── Paarungen sammeln (offen + gespielt) ──

function collectPairings(data, header, bewerbId, playerMap) {
  const pairings = [];

  const h = header.map((c) => String(c).trim().toLowerCase());
  const bwIdx = h.indexOf("bewerbid");
  const rtIdx = h.indexOf("bewerbrunde");
  const p1Idx = h.indexOf("spieler1id");
  const p2Idx = h.indexOf("spieler2id");
  const p3Idx = h.indexOf("spieler3id");
  const p4Idx = h.indexOf("spieler4id");
  const erIdx = h.indexOf("ergebnis");
  const idIdx = h.indexOf("id");
  const dIdx = h.indexOf("matchdate");

  data.forEach((row) => {
    if (bwIdx >= 0 && String(row[bwIdx] || "").trim() !== String(bewerbId).trim()) return;
    const g = parseGroup(rtIdx >= 0 ? String(row[rtIdx] || "").trim() : "");
    if (g === null) return;

    const id1 = parsePlayerId(row[p1Idx]);
    const id2 = p2Idx >= 0 ? parsePlayerId(row[p2Idx]) : "";
    const id3 = p3Idx >= 0 ? parsePlayerId(row[p3Idx]) : "";
    const id4 = p4Idx >= 0 ? parsePlayerId(row[p4Idx]) : "";
    const ergebnis = erIdx >= 0 ? String(row[erIdx] || "").trim() : "";
    const datum = dIdx >= 0 ? String(row[dIdx] || "").trim() : "";
    const matchId = idIdx >= 0 ? String(row[idIdx] || "").trim() : "";

    const firstTeamRetired = [p1Idx, p2Idx].filter((index) => index >= 0).some((index) => playerMarker(row[index]));
    const secondTeamRetired = [p3Idx, p4Idx].filter((index) => index >= 0).some((index) => playerMarker(row[index]));

    // Gewinner aus Ergebnis oder Abschlussmarker berechnen
    let winnerId = firstTeamRetired ? id3 : secondTeamRetired ? id1 : "";
    if (!winnerId && ergebnis) {
      const resultSets = parseResult(ergebnis);
      if (resultSets) {
        let sL = 0, sR = 0;
        resultSets.forEach((s) => { if (s.left > s.right) sL++; else if (s.right > s.left) sR++; });
        if (sL > sR) winnerId = id1;
        else if (sR > sL) winnerId = id3;
      }
    }

    const team1Html = formatTeamHtml(id1, id2, playerMap);
    const team2Html = formatTeamHtml(id3, id4, playerMap);

    const isPlayed = Boolean(ergebnis || firstTeamRetired || secondTeamRetired);

    // winner: 1 = Team1 gewinnt, 2 = Team2 gewinnt, 0 = kein Gewinner
    let winner = 0;
    if (winnerId === id1) winner = 1;
    else if (winnerId === id3) winner = 2;

    pairings.push({
      group: g,
      team1Html,
      team2Html,
      matchId,
      ergebnis: ergebnis || "",
      played: isPlayed,
      datumRaw: datum,
      datum: parseSheetDate(datum),
      datumTs: dateToTs(datum),
      winner,
    });
  });

  return pairings;
}

// ── Render ──

function renderMessage(container, message) {
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  container.replaceChildren(paragraph);
}

function setLargestFittingFont(container, property, minimum, maximum, fits) {
  let lower = minimum;
  let upper = maximum;
  for (let i = 0; i < 7; i++) {
    const size = (lower + upper) / 2;
    container.style.setProperty(property, `${size}px`);
    if (fits()) lower = size;
    else upper = size;
  }
  container.style.setProperty(property, `${lower}px`);
}

function updateRoundRobinLayouts(container) {
  const pairings = [...container.querySelectorAll(".rr-pairing")];
  container.style.removeProperty("--rr-pairing-name-size");
  pairings.forEach((pairing) => pairing.classList.remove("rr-pairing-stacked"));
  const pairingNames = [...container.querySelectorAll(".rr-pairing-team")];
  if (pairingNames.length > 0) {
    const minimumPairingNameSize = parseFloat(getComputedStyle(pairingNames[0]).fontSize);
    container.style.setProperty("--rr-pairing-name-size", `${minimumPairingNameSize}px`);
    const pairingFits = () => pairings.every((pairing) => {
      const children = [...pairing.children];
      const gap = parseFloat(getComputedStyle(pairing).columnGap) || 0;
      const requiredWidth = children.reduce((width, child) => width + child.scrollWidth, 0)
        + Math.max(0, children.length - 1) * gap;
      return requiredWidth <= pairing.clientWidth + 0.5;
    });
    const requiresStackedLayout = !pairingFits();
    pairings.forEach((pairing) => pairing.classList.toggle("rr-pairing-stacked", requiresStackedLayout));
    if (!requiresStackedLayout) {
      setLargestFittingFont(
        container,
        "--rr-pairing-name-size",
        minimumPairingNameSize,
        minimumPairingNameSize * 1.375,
        pairingFits,
      );
    }
  }

  const nameCells = [...container.querySelectorAll(".rr-table .rr-name-cell")];
  const tables = [...container.querySelectorAll(".rr-table")];
  container.style.removeProperty("--rr-table-name-size");
  container.style.removeProperty("--rr-table-size");
  container.classList.remove("rr-table-names-stacked");
  if (nameCells.length > 0 && tables.length > 0) {
    nameCells.forEach((cell) => cell.classList.add("rr-table-team-measuring"));
    const minimumTableSize = parseFloat(getComputedStyle(tables[0]).fontSize);
    container.style.setProperty("--rr-table-size", `${minimumTableSize}px`);
    const tableNamesFit = () => nameCells.every((cell) => cell.scrollWidth <= cell.clientWidth + 0.5);
    const namesNeedStacking = !tableNamesFit();
    container.classList.toggle("rr-table-names-stacked", namesNeedStacking);
    if (!namesNeedStacking) {
      const tableFits = () => tables.every((table) => [...table.querySelectorAll("th, td")]
        .every((cell) => cell.scrollWidth <= cell.clientWidth + 0.5));
      setLargestFittingFont(
        container,
        "--rr-table-size",
        minimumTableSize,
        minimumTableSize * 1.375,
        tableFits,
      );
    }
    nameCells.forEach((cell) => cell.classList.remove("rr-table-team-measuring"));
  }
}

function observeRoundRobinLayouts(container) {
  layoutResizeObserver?.disconnect();
  updateRoundRobinLayouts(container);
  if (typeof ResizeObserver === "undefined") return;
  layoutResizeObserver = new ResizeObserver(() => updateRoundRobinLayouts(container));
  layoutResizeObserver.observe(container);
}

export async function renderRoundRobin(bewerbId, container, paarungslayout) {
  const generation = ++renderGeneration;
  bindProfileLinks(container);
  layoutResizeObserver?.disconnect();
  container.replaceChildren();
  showLoadingOverlay("Lade Gruppen...");

  try {
    await ready;
    const currentUserId = String(getUser()?.id || "");
    const [matchRes, playerRes, bewerbRes, bewerbsartRes] = await Promise.all([
      callWithRetry(readMatchesList),
      callWithRetry(readPlayersList),
      callWithRetry(readBewerbe),
      callWithRetry(readBewerbsart),
    ]);
    if (generation !== renderGeneration) return null;

    const matchValues = matchRes.data?.values || [];
    const playerValues = playerRes.data?.values || [];
    const bewerbValues = bewerbRes.data?.values || [];
    const bewerbsartValues = bewerbsartRes.data?.values || [];

    // Spieler-Map
    const playerMap = new Map();
    if (playerValues.length > 1) {
      const ph = playerValues[0].map((h) => String(h).trim().toLowerCase());
      const pidIdx = ph.indexOf("id");
      const pfnIdx = ph.indexOf("vorname");
      const plnIdx = ph.indexOf("nachname");
      playerValues.slice(1).forEach((r) => {
        const id = String(r[pidIdx] || "").trim();
        const name = [r[pfnIdx], r[plnIdx]].filter(Boolean).map((s) => String(s).trim()).join(" ");
        if (id) playerMap.set(id, name);
      });
    }

    // Spezifikum aus Bewerbsart ermitteln (Aufstiegs-/Abstiegsregeln)
    let promotionRules = [];
    if (bewerbValues.length > 1 && bewerbsartValues.length > 1) {
      const bh = bewerbValues[0].map((h) => h.trim().toLowerCase());
      const bIdIdx = bh.indexOf("id");
      const bBaIdx = bh.indexOf("bewerbsartid");
      const bewerbRow = bewerbValues.slice(1).find((r) => String(r[bIdIdx] || "").trim() === String(bewerbId).trim());
      if (bewerbRow) {
        const baId = String(bewerbRow[bBaIdx] || "").trim();
        const ash = bewerbsartValues[0].map((h) => h.trim().toLowerCase());
        const aIdIdx = ash.indexOf("id");
        const aSpezIdx = ash.indexOf("spezifikum");
        if (aSpezIdx >= 0) {
          const baRow = bewerbsartValues.slice(1).find((r) => String(r[aIdIdx] || "").trim() === baId);
          if (baRow) promotionRules = parsePromotion(baRow[aSpezIdx]);
        }
      }
    }

    const matchHeader = matchValues[0] || [];

    // Spieler sammeln (inkl. Doppelpartner) — nur noch ein Array
    const all = collectPlayers(matchValues.slice(1), matchHeader, bewerbId);

    // Deduplizieren — key = Hauptspieler-ID pro Gruppe
    const seen = new Set();
    const unique = [];
    all.forEach((e) => {
      const key = e.group + ":" + e.id;
      if (!seen.has(key)) { seen.add(key); unique.push(e); }
    });

    // Partner-Map: Hauptspieler → Partner
    const partnerMap = new Map();
    all.forEach((e) => {
      if (e.partnerId) partnerMap.set(e.id, e.partnerId);
    });

    // Gruppen
    const groups = new Map();
    unique.forEach((e) => {
      if (!groups.has(e.group)) groups.set(e.group, []);
      groups.get(e.group).push(e.id);
    });

    const sortedGroups = [...groups.entries()].sort((a, b) => a[0] - b[0]);

    if (sortedGroups.length === 0) {
      if (generation !== renderGeneration) return null;
      renderMessage(container, "Keine Gruppen für diesen Bewerb gefunden.");
      hideLoadingOverlay();
      return true;
    }

    // Statistik
    const { stats, playerMatches } = buildStats(matchValues.slice(1), matchHeader, bewerbId);

    // Paarungen — nur noch ein Array (Matches1)
    const pairings = collectPairings(
      matchValues.slice(1), matchHeader,
      bewerbId, playerMap,
    );

    // ── Gruppen-Rows aufbauen und sortieren ──
    const allGroupRows = [];
    sortedGroups.forEach(([gNum, ids]) => {
      const rows = ids.map((id) => {
        const s = stats[id] || { siege: 0, saetzeW: 0, saetzeL: 0, gamesW: 0, gamesL: 0 };
        const matches = playerMatches[id] || [];
        const partner = partnerMap.get(id) || "";
        return { id, partner, ...s, matches };
      });

      rows.sort((a, b) => {
        if (b.siege !== a.siege) return b.siege - a.siege;
        const diffA = a.saetzeW - a.saetzeL;
        const diffB = b.saetzeW - b.saetzeL;
        if (diffB !== diffA) return diffB - diffA;
        return (b.gamesW - b.gamesL) - (a.gamesW - a.gamesL);
      });

      allGroupRows.push({ gNum, rows });
    });

    // ── Aufsteiger ermitteln (Aufstiegs-/Abstiegslogik) ──
    const promotedPlayers = determinePromotedPlayers(allGroupRows, promotionRules);

    // ── HTML: Gruppentabellen ──
    // Raster berechnen: max 2 Spalten bei <= 4 Gruppen, max 3 bei > 4
    const groupCount = allGroupRows.length;
    let cols = 2;
    if (groupCount === 1) cols = 1;
    else if (groupCount <= 4) cols = 2;
    else if (groupCount <= 9) cols = 3;
    else cols = 4;

    let html = `<div class="rr-groups" style="--rr-cols: ${cols}">`;

    allGroupRows.forEach(({ gNum, rows }) => {

      html += `<div class="rr-group-card">`;
      html += `<div class="rr-group-title">Gruppe ${escapeHtml(gNum)}</div>`;
      html += `<table class="rr-table">`;
      html += `<thead><tr>`;
      html += `<th>Rang</th><th class="rr-name-col">Name</th><th>Spiele</th><th>Siege</th>`;
      html += `<th>Sätze</th><th>Games</th>`;
      html += `</tr></thead><tbody>`;

      rows.forEach((r, idx) => {
        const rang = idx + 1;
        const isPromoted = promotedPlayers.has(r.id);
        const isCurrentUser = currentUserId && (r.id === currentUserId || r.partner === currentUserId);
        const classes = [isPromoted ? "rr-highlight" : "", isCurrentUser ? "rr-current-user" : ""].filter(Boolean);
        const cls = classes.length ? ` class="${classes.join(" ")}"` : "";
        const teamHtml = formatTeamHtml(r.id, r.partner, playerMap);
        html += `<tr${cls}>`;
        html += `<td class="rr-center">${escapeHtml(rang)}</td>`;
        html += `<td class="rr-name-cell">${teamHtml}</td>`;
        html += `<td class="rr-center">${escapeHtml(r.matches.length)}</td>`;
        html += `<td class="rr-center">${escapeHtml(r.siege)}</td>`;
        html += `<td class="rr-center">${escapeHtml(r.saetzeW)}-${escapeHtml(r.saetzeL)}</td>`;
        html += `<td class="rr-center">${escapeHtml(r.gamesW)}-${escapeHtml(r.gamesL)}</td>`;
        html += `</tr>`;
      });

      html += `</tbody></table>`;

      // Paarungen dieser Gruppe, sortiert nach Datum (nächstes zuerst)
      const groupPairings = pairings
        .filter((p) => p.group === gNum)
        .sort((a, b) => a.datumTs - b.datumTs);
      if (groupPairings.length > 0) {
        html += `<div class="rr-pairings-title">Paarungen</div>`;
        html += `<div class="rr-pairings">`;
        groupPairings.forEach((p) => {
          const cls = p.played ? "rr-pairing played" : "rr-pairing open";
          const t1cls = p.winner === 1 ? "rr-pairing-winner" : p.winner === 2 ? "rr-pairing-loser" : "";
          const t2cls = p.winner === 2 ? "rr-pairing-winner" : p.winner === 1 ? "rr-pairing-loser" : "";
          const datumDisplay = formatPairingDate(p.datumRaw, p.played, paarungslayout);
          html += `<div class="${cls}">`;
          if (datumDisplay) html += `<span class="rr-pairing-date">${escapeHtml(datumDisplay)}</span>`;
          html += `<span class="rr-pairing-team rr-pairing-team-1 ${t1cls}">${p.team1Html}</span>`;
          html += `<span class="rr-pairing-sep">-</span>`;
          html += `<span class="rr-pairing-team rr-pairing-team-2 ${t2cls}">${p.team2Html}</span>`;
          if (p.ergebnis) html += `<span class="rr-pairing-result">${escapeHtml(p.ergebnis)}</span>`;
          html += `</div>`;
        });
        html += `</div>`;
      }

      html += `</div>`;
    });

    html += "</div>";
    if (generation !== renderGeneration) return null;
    // Backend-derived text is escaped before it is added to this markup string.
    container.innerHTML = html;
    observeRoundRobinLayouts(container);
    hideLoadingOverlay();
    return true;
  } catch {
    if (generation !== renderGeneration) return null;
    showErrorOverlay("Fehler beim Laden der Gruppen", () => renderRoundRobin(bewerbId, container, paarungslayout));
    return false;
  }
}

// ── Seiten-Init ──

async function loadBewerbName(bewerbId) {
  const heading = document.getElementById("roundRobinHeading");
  if (!heading || !bewerbId) return;
  try {
    const res = await readBewerbe();
    const values = res.data?.values || [];
    if (values.length < 2) return;
    const bHeader = values[0].map((h) => h.trim().toLowerCase());
    const bIdIdx = bHeader.indexOf("id");
    const bBezIdx = bHeader.indexOf("bezeichnung");
    const row = values.slice(1).find((r) => String(r[bIdIdx] || "").trim() === String(bewerbId).trim());
    if (row && row[bBezIdx]) {
      heading.textContent = row[bBezIdx];
    }
  } catch {
    // silent
  }
}

const params = new URLSearchParams(window.location.search);
const BEWERB_ID = params.get("id");
const PAARUNGSLAYOUT = params.get("paarungslayout") || "0";

async function initRoundRobinPage() {
  const container = document.getElementById("roundRobinContainer");
  if (!container) return;

  if (!BEWERB_ID) {
    renderMessage(container, "Keine Bewerb-ID angegeben.");
    signalMonitorFailed();
    return;
  }

  try {
    await ready;
    let initializationPending = true;
    let observedUserId = String(getUser()?.id || "");
    subscribeAuth((user) => {
      const nextUserId = String(user?.id || "");
      if (nextUserId === observedUserId) return;
      observedUserId = nextUserId;
      void renderRoundRobin(BEWERB_ID, container, PAARUNGSLAYOUT).then((rendered) => {
        if (!initializationPending || rendered === null) return;
        initializationPending = false;
        if (rendered) signalMonitorReady();
        else signalMonitorFailed();
      });
    });
    const [, rendered] = await Promise.all([
      loadBewerbName(BEWERB_ID),
      renderRoundRobin(BEWERB_ID, container, PAARUNGSLAYOUT),
    ]);
    subscribeInvalidations(["matches", "players", "bewerbe", "bewerbsart"], async () => {
      await Promise.all([
        loadBewerbName(BEWERB_ID),
        renderRoundRobin(BEWERB_ID, container, PAARUNGSLAYOUT),
      ]);
    });
    if (initializationPending && rendered !== null) {
      initializationPending = false;
      if (rendered) signalMonitorReady();
      else signalMonitorFailed();
    }
  } catch {
    signalMonitorFailed();
    showErrorOverlay("Fehler beim Laden der Gruppen");
  }
}

void initRoundRobinPage();
