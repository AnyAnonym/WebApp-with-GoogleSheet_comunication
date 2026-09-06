import { createEndpoint, subscribeInvalidations } from "./dataClient.js";
import { callWithRetry, showLoadingOverlay, hideLoadingOverlay, showErrorOverlay } from "./loadingHelper.js";
import { signalMonitorReady, signalMonitorFailed } from "./monitorReady.js";

const readMatches1 = createEndpoint("matches1");
const readPlayers = createEndpoint("players");
const readBewerbe = createEndpoint("bewerbe");

let allMatches = [];
let playerMap = new Map();
let playerFilterList = []; // {id, display: "Nachname Vorname"} für Filter-Dropdown
let bewerbMap = new Map();
const requestedCategory = new URLSearchParams(window.location.search).get("category");
let currentCategory = ["played", "open"].includes(requestedCategory) ? requestedCategory : "played";

// ── Hilfsfunktionen ──

function parseSheetDate(raw) {
  if (!raw) return "";
  const m = String(raw).trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return String(raw).trim();
  const [, yy, mm, dd, hh, mi] = m;
  const yyyy = parseInt(yy, 10) >= 50 ? "19" + yy : "20" + yy;
  return `${dd}.${mm}.${yyyy} - ${hh}:${mi}`;
}

function dateToTs(raw) {
  if (!raw) return 0;
  const m = String(raw).trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return 0;
  const [, yy, mm, dd, hh, mi] = m;
  const yyyy = parseInt(yy, 10) >= 50 ? 1900 + parseInt(yy) : 2000 + parseInt(yy);
  return new Date(yyyy, parseInt(mm) - 1, parseInt(dd), parseInt(hh), parseInt(mi)).getTime();
}

function parseCompactTimestamp(raw) {
  const match = String(raw || "").trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, yy, month, day, hour, minute] = match;
  const year = Number(yy) >= 50 ? 1900 + Number(yy) : 2000 + Number(yy);
  const timestamp = Date.UTC(year, Number(month) - 1, Number(day), Number(hour), Number(minute));
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
    || date.getUTCHours() !== Number(hour)
    || date.getUTCMinutes() !== Number(minute)) return null;
  return { timestamp, time: `${hour}:${minute}` };
}

function formatMatchTiming(startRaw, endRaw) {
  const start = parseCompactTimestamp(startRaw);
  const end = parseCompactTimestamp(endRaw);
  if (!start || !end || end.timestamp < start.timestamp) return "";
  const totalMinutes = Math.floor((end.timestamp - start.timestamp) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const duration = [
    hours ? `${hours} ${hours === 1 ? "Stunde" : "Stunden"}` : "",
    minutes || !hours ? `${minutes} ${minutes === 1 ? "Minute" : "Minuten"}` : "",
  ].filter(Boolean).join(" ");
  return `(${start.time} - ${end.time} Uhr = ${duration})`;
}

function parsePlayerId(raw) {
  const s = String(raw || "").trim();
  const wo = s.endsWith("[wo]");
  const ret = s.endsWith("[ret]");
  const cleanId = wo ? s.slice(0, -4).trim() : ret ? s.slice(0, -5).trim() : s;
  const special = wo ? "wo" : ret ? "ret" : null;
  return {cleanId, special};
}

function determineWinner(ergebnis) {
  if (!ergebnis) return 0;
  const sets = String(ergebnis).split("/").filter(Boolean);
  let w1 = 0, w2 = 0;
  sets.forEach((s) => {
    const clean = s.replace(/\(\d+\)/g, "").replace(/\[ret\]/g, "").trim();
    const parts = clean.split("-").map(Number);
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      if (parts[0] > parts[1]) w1++;
      else if (parts[1] > parts[0]) w2++;
    }
  });
  if (w1 > w2) return 1;
  if (w2 > w1) return 2;
  return 0;
}

// Gewinner inkl. [wo]/[ret]-Logik: wer wo/ret gibt, verliert
function determineWinnerWithWo(ergebnis, firstTeamSpecials, secondTeamSpecials) {
  if (firstTeamSpecials.some(Boolean)) return 2;
  if (secondTeamSpecials.some(Boolean)) return 1;
  return determineWinner(ergebnis);
}

function parseRunde(raw) {
  if (!raw) return "";
  const s = String(raw).trim().toUpperCase();
  const m = s.match(/^(R\d+|AF|VF|HF|F|G\d+)/);
  if (!m) return "";
  const code = m[1];
  if (/^R(\d+)$/.test(code)) return code.replace(/^R/, "") + ".Runde";
  if (code === "AF") return "Achtelfinale";
  if (code === "VF") return "Viertelfinale";
  if (code === "HF") return "Halbfinale";
  if (code === "F") return "Finale";
  if (/^G(\d+)$/.test(code)) return code.replace(/^G/, "") + ".Gruppe";
  return code;
}

function createBadge(type) {
  const badge = document.createElement("span");
  if (type === "wo") {
    badge.className = "badge-wo";
    badge.textContent = "wo";
    return badge;
  }
  if (type === "ret") {
    badge.className = "badge-ret";
    badge.textContent = "ret";
    return badge;
  }
  return null;
}

function formatSetResult(raw) {
  if (!raw) return "";
  return String(raw).replace(/\((\d+)\)/g, (_, tb) => {
    const sup = {"0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹"};
    return tb.split("").map((d) => sup[d] || d).join("");
  });
}

// ── Daten laden ──

async function loadData() {
  showLoadingOverlay("Lade Matches...");
  try {
    const [matchRes, playerRes, bewerbRes] = await Promise.all([
      callWithRetry(readMatches1),
      callWithRetry(readPlayers),
      callWithRetry(readBewerbe),
    ]);

    const matchValues = matchRes.data?.values || [];
    const playerValues = playerRes.data?.values || [];
    const bewerbValues = bewerbRes.data?.values || [];

    // Player Map
    playerMap = new Map();
    playerFilterList = [];
    if (playerValues.length > 1) {
      const ph = playerValues[0].map((h) => String(h).trim().toLowerCase());
      const pidIdx = ph.indexOf("id");
      const pfn = ph.indexOf("vorname");
      const pln = ph.indexOf("nachname");
      const pAktiv = ph.indexOf("aktiv");
      playerValues.slice(1).forEach((r) => {
        const id = String(r[pidIdx] || "").trim();
        const vorname = String(r[pfn] || "").trim();
        const nachname = String(r[pln] || "").trim();
        const name = [vorname, nachname].filter(Boolean).join(" ");
        const aktiv = pAktiv >= 0 ? String(r[pAktiv] || "").trim() : "1";
        if (id) {
          playerMap.set(id, name);
          if (aktiv === "1") {
            playerFilterList.push({id, nachname, display: [nachname, vorname].filter(Boolean).join(" ")});
          }
        }
      });
      playerFilterList.sort((a, b) => a.nachname.localeCompare(b.nachname));
    }

    // Bewerb Map
    bewerbMap = new Map();
    if (bewerbValues.length > 1) {
      const bh = bewerbValues[0].map((h) => String(h).trim().toLowerCase());
      const bidIdx = bh.indexOf("id");
      const bbez = bh.indexOf("bezeichnung");
      bewerbValues.slice(1).forEach((r) => {
        const id = String(r[bidIdx] || "").trim();
        if (id) bewerbMap.set(id, String(r[bbez] || "").trim());
      });
    }

    // Matches parsen
    allMatches = [];
    if (matchValues.length > 1) {
      const h = matchValues[0].map((c) => String(c).trim().toLowerCase());
      const iId = h.indexOf("id");
      const iDate = h.indexOf("matchdate");
      const iStart = h.indexOf("matchstart");
      const iEnd = h.indexOf("matchende");
      const iFord = h.indexOf("forderungdate");
      const iBewerb = h.indexOf("bewerbid");
      const iRunde = h.indexOf("bewerbrunde");
      const iP1 = h.indexOf("spieler1id");
      const iP2 = h.indexOf("spieler2id");
      const iP3 = h.indexOf("spieler3id");
      const iP4 = h.indexOf("spieler4id");
      const iErg = h.indexOf("ergebnis");

      matchValues.slice(1).forEach((row, idx) => {
        const pid1 = parsePlayerId(row[iP1]);
        const pid2 = iP2 >= 0 ? parsePlayerId(row[iP2]) : {cleanId: "", special: null};
        const pid3 = iP3 >= 0 ? parsePlayerId(row[iP3]) : {cleanId: "", special: null};
        const pid4 = iP4 >= 0 ? parsePlayerId(row[iP4]) : {cleanId: "", special: null};
        const ergebnis = iErg >= 0 ? String(row[iErg] || "").trim() : "";
        const matchDateRaw = iDate >= 0 ? String(row[iDate] || "").trim() : "";
        const fordDateRaw = iFord >= 0 ? String(row[iFord] || "").trim() : "";
        const bewerbId = iBewerb >= 0 ? String(row[iBewerb] || "").trim() : "";
        const rundeRaw = iRunde >= 0 ? String(row[iRunde] || "").trim() : "";

        allMatches.push({
          row: idx + 2,
          id: iId >= 0 ? String(row[iId] || "").trim() : "",
          matchDateRaw,
          matchDate: parseSheetDate(matchDateRaw),
          matchTs: dateToTs(matchDateRaw),
          matchTiming: formatMatchTiming(iStart >= 0 ? row[iStart] : "", iEnd >= 0 ? row[iEnd] : ""),
          fordDateRaw,
          fordDate: parseSheetDate(fordDateRaw),
          bewerbId,
          bewerbName: bewerbMap.get(bewerbId) || "",
          runde: parseRunde(rundeRaw),
          p1: {name: playerMap.get(pid1.cleanId) || pid1.cleanId, id: pid1.cleanId, special: pid1.special},
          p2: {name: pid2.cleanId ? (playerMap.get(pid2.cleanId) || pid2.cleanId) : "", id: pid2.cleanId, special: pid2.special},
          p3: {name: pid3.cleanId ? (playerMap.get(pid3.cleanId) || pid3.cleanId) : "", id: pid3.cleanId, special: pid3.special},
          p4: {name: pid4.cleanId ? (playerMap.get(pid4.cleanId) || pid4.cleanId) : "", id: pid4.cleanId, special: pid4.special},
          ergebnis,
          ergebnisFormatted: ergebnis.split("/").map((s) => formatSetResult(s)).join("/"),
          winner: determineWinnerWithWo(ergebnis, [pid1.special, pid2.special], [pid3.special, pid4.special]),
          hasWo: !!(pid1.special === "wo" || pid2.special === "wo" || pid3.special === "wo" || pid4.special === "wo"),
          isPlayed: !!ergebnis || !!pid1.special || !!pid2.special || !!pid3.special || !!pid4.special,
          isBye: /^BYE$/i.test(pid1.cleanId) || /^BYE$/i.test(pid3.cleanId || ""),
        });
      });
    }

    populateFilterDropdowns();
    renderMatches();
    hideLoadingOverlay();
    return true;
  } catch {
    showErrorOverlay("Fehler beim Laden der Matches", loadData);
    return false;
  }
}

// ── Filter-Dropdowns befüllen ──

function populateFilterDropdowns() {
  const bewerbSelect = document.getElementById("filterBewerbSelect");
  const spielerSelect = document.getElementById("filterSpielerSelect");

  const allBewerbeOption = document.createElement("option");
  allBewerbeOption.value = "";
  allBewerbeOption.textContent = "Alle";
  bewerbSelect.replaceChildren(allBewerbeOption);
  const bewerbe = [...bewerbMap.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  bewerbe.forEach(([id, name]) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = name;
    bewerbSelect.appendChild(option);
  });

  const allPlayersOption = document.createElement("option");
  allPlayersOption.value = "";
  allPlayersOption.textContent = "Alle";
  spielerSelect.replaceChildren(allPlayersOption);
  playerFilterList.forEach(({id, display}) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = display;
    spielerSelect.appendChild(option);
  });
}

// ── Filtern + Sortieren ──

function getFilteredMatches() {
  let matches = [...allMatches].filter((m) => !m.isBye);

  // Grundkategorie
  if (currentCategory === "played") matches = matches.filter((m) => m.isPlayed);
  else if (currentCategory === "open") matches = matches.filter((m) => !m.isPlayed);

  // Optionale Filter
  if (document.getElementById("filterCompleteWithoutDate")?.checked) {
    matches = matches.filter((m) => {
      const hasCompletePrimaryPlayers = !!m.p1.id && !!m.p3.id;
      const hasCompletePartners = (!!m.p2.id) === (!!m.p4.id);
      return !m.matchDateRaw && hasCompletePrimaryPlayers && hasCompletePartners;
    });
  }
  if (document.getElementById("filterBewerb")?.checked) {
    const val = document.getElementById("filterBewerbSelect")?.value;
    if (val) matches = matches.filter((m) => m.bewerbId === val);
  }
  if (document.getElementById("filterSpieler")?.checked) {
    const val = document.getElementById("filterSpielerSelect")?.value;
    if (val) matches = matches.filter((m) => [m.p1.id, m.p2.id, m.p3.id, m.p4.id].includes(val));
  }
  if (document.getElementById("filterDatum")?.checked) {
    matches = matches.filter((m) => m.matchTs > 0);
    const von = document.getElementById("datumVon")?.value;
    const bis = document.getElementById("datumBis")?.value;
    if (von) {
      const vonTs = new Date(von).getTime();
      matches = matches.filter((m) => m.matchTs >= vonTs);
    }
    if (bis) {
      const bisTs = new Date(bis).getTime() + 86400000;
      matches = matches.filter((m) => m.matchTs <= bisTs);
    }
  }
  if (document.getElementById("filterMissing")?.checked) {
    matches = matches.filter((m) => !m.p1.id || !m.p3.id);
  }

  // Sortierung
  if (currentCategory === "played") {
    matches.sort((a, b) => (b.matchTs || 0) - (a.matchTs || 0));
  } else if (currentCategory === "open") {
    matches.sort((a, b) => {
      if (a.matchTs && b.matchTs) return a.matchTs - b.matchTs;
      if (a.matchTs && !b.matchTs) return -1;
      if (!a.matchTs && b.matchTs) return 1;
      return a.bewerbName.localeCompare(b.bewerbName);
    });
  } else {
    // Alle: gespielt zuerst (neuestes oben), dann offen
    const played = matches.filter((m) => m.isPlayed).sort((a, b) => (b.matchTs || 0) - (a.matchTs || 0));
    const open = matches.filter((m) => !m.isPlayed).sort((a, b) => {
      if (a.matchTs && b.matchTs) return a.matchTs - b.matchTs;
      if (a.matchTs && !b.matchTs) return -1;
      if (!a.matchTs && b.matchTs) return 1;
      return a.bewerbName.localeCompare(b.bewerbName);
    });
    matches = [...played, ...open];
  }

  return matches;
}

// ── Rendern ──

function renderMatches() {
  const container = document.getElementById("matches1-container");
  const countEl = document.getElementById("matches1-count");
  const matches = getFilteredMatches();

  countEl.textContent = `${matches.length} Match${matches.length !== 1 ? "es" : ""}`;

  if (matches.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.style.textAlign = "center";
    emptyMessage.style.color = "var(--muted)";
    emptyMessage.textContent = "Keine Matches gefunden.";
    container.replaceChildren(emptyMessage);
    return;
  }

  const cards = document.createDocumentFragment();
  matches.forEach((m) => {
    const team1Name = m.p2.name ? `${m.p1.name} / ${m.p2.name}` : (m.p1.name || "—");
    const team2Name = m.p4.name ? `${m.p3.name} / ${m.p4.name}` : (m.p3.name || "—");
    const bewerbDisplay = [m.bewerbName, m.runde].filter(Boolean).join(" | ");

    const card = document.createElement("div");
    card.className = "m1-card";

    const meta = document.createElement("div");
    meta.className = "m1-meta";

    const date = document.createElement("span");
    date.className = "m1-date";
    date.textContent = m.matchDate || "Datum offen";
    if (m.isPlayed && m.matchTiming) {
      const timing = document.createElement("span");
      timing.className = "m1-timing";
      timing.textContent = m.matchTiming;
      date.append(" ", timing);
    }
    meta.appendChild(date);

    if (m.fordDate) {
      const forderung = document.createElement("span");
      forderung.className = "m1-forderung";
      forderung.textContent = `Forderung: ${m.fordDate}`;
      meta.appendChild(forderung);
    }

    if (bewerbDisplay) {
      const bewerb = document.createElement("span");
      bewerb.className = "m1-bewerb";
      bewerb.textContent = bewerbDisplay;
      meta.appendChild(bewerb);
    }

    const content = document.createElement("div");
    content.className = "m1-content";

    const players = document.createElement("div");
    players.className = "m1-players";

    const team1 = document.createElement("div");
    team1.className = "m1-team";
    if (m.winner === 1) team1.classList.add("winner");
    const player1 = document.createElement("span");
    player1.className = "m1-player";
    player1.textContent = team1Name;
    const badge1 = createBadge(m.p1.special || m.p2.special);
    if (badge1) player1.append(" ", badge1);
    team1.appendChild(player1);

    const versus = document.createElement("span");
    versus.className = "m1-vs";
    versus.textContent = "vs.";

    const team2 = document.createElement("div");
    team2.className = "m1-team";
    if (m.winner === 2) team2.classList.add("winner");
    const player2 = document.createElement("span");
    player2.className = "m1-player";
    player2.textContent = team2Name;
    const badge2 = createBadge(m.p3.special || m.p4.special);
    if (badge2) player2.append(" ", badge2);
    team2.appendChild(player2);

    players.append(team1, versus, team2);

    const result = document.createElement("div");
    result.className = "m1-result";
    result.textContent = m.ergebnisFormatted || "";

    content.append(players, result);
    card.append(meta, content);
    cards.appendChild(card);
  });
  container.replaceChildren(cards);
}

// ── Event-Listener ──

function initControls() {
  // Kategorie-Buttons
  document.querySelectorAll(".m1-cat-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.cat === currentCategory);
    btn.addEventListener("click", () => {
      document.querySelectorAll(".m1-cat-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentCategory = btn.dataset.cat;
      renderMatches();
    });
  });

  // Filter-Toggle
  document.getElementById("filterToggle")?.addEventListener("click", () => {
    document.getElementById("filterPanel")?.classList.toggle("hidden");
  });

  // Filter-Checkboxen
  ["filterCompleteWithoutDate", "filterBewerb", "filterSpieler", "filterDatum", "filterMissing"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", (e) => {
      // Enable/Disable zugehörige Inputs
      if (id === "filterBewerb") document.getElementById("filterBewerbSelect").disabled = !e.target.checked;
      if (id === "filterSpieler") document.getElementById("filterSpielerSelect").disabled = !e.target.checked;
      if (id === "filterDatum") document.getElementById("datumRow")?.classList.toggle("hidden", !e.target.checked);
      renderMatches();
    });
  });

  // Dropdowns + Datum
  ["filterBewerbSelect", "filterSpielerSelect", "datumVon", "datumBis"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", renderMatches);
  });

  // Datum-Presets
  document.querySelectorAll(".m1-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const months = parseInt(btn.dataset.months);
      const now = new Date();
      const target = new Date(now);
      target.setMonth(target.getMonth() + months);

      const von = document.getElementById("datumVon");
      const bis = document.getElementById("datumBis");
      if (months < 0) {
        von.value = target.toISOString().slice(0, 10);
        bis.value = now.toISOString().slice(0, 10);
      } else {
        von.value = now.toISOString().slice(0, 10);
        bis.value = target.toISOString().slice(0, 10);
      }

      document.getElementById("filterDatum").checked = true;
      document.getElementById("datumRow")?.classList.remove("hidden");
      renderMatches();
    });
  });
}

// ── Init ──
document.addEventListener("DOMContentLoaded", async () => {
  try {
    initControls();
    const rendered = await loadData();
    if (rendered) signalMonitorReady();
    else signalMonitorFailed();
    subscribeInvalidations(["matches", "players", "bewerbe"], loadData);
  } catch {
    signalMonitorFailed();
    showErrorOverlay("Fehler beim Laden der Matches");
  }
});
