import { createEndpoint, setOnScoreChange, isConnected, request } from "./dataClient.js";

const readMatches1        = createEndpoint("matches1");
const readPlayersList     = createEndpoint("players");
const readBewerbe         = createEndpoint("bewerbe");
const getScoreboardCourts = createEndpoint("getScoreboardCourts");

const MATCHES_POLL = 5000;
const SCOREBOARD_POLL = 1000;

let playerMap = new Map();
let bewerbMap = new Map();
let matchRasterMap = new Map();

async function loadPlayers() {
  try {
    const res = await readPlayersList();
    const { success, values } = res.data;
    if (!success || !Array.isArray(values) || values.length < 2) return;
    const header = values[0].map((h) => h.trim().toLowerCase());
    const idIdx = header.indexOf("id");
    const fnIdx = header.indexOf("vorname");
    const lnIdx = header.indexOf("nachname");
    if (idIdx === -1) return;
    const map = new Map();
    values.slice(1).forEach((r) => {
      const id = String(r[idIdx] || "").trim();
      const name = `${r[fnIdx] || ""} ${r[lnIdx] || ""}`.trim();
      if (id) map.set(id, name || id);
    });
    playerMap = map;
  } catch (err) {
    // silent
  }
}

async function loadBewerbe() {
  try {
    const res = await readBewerbe();
    const { success, values } = res.data;
    if (!success || !Array.isArray(values) || values.length < 2) return;
    const header = values[0].map((h) => h.trim().toLowerCase());
    const idIdx = header.indexOf("id");
    const bezIdx = header.indexOf("bezeichnung");
    if (idIdx === -1 || bezIdx === -1) return;
    const map = new Map();
    values.slice(1).forEach((r) => {
      const id = String(r[idIdx] || "").trim();
      if (id) map.set(id, String(r[bezIdx] || "").trim());
    });
    bewerbMap = map;
  } catch (err) {
    // silent
  }
}

function parseSheetDate(raw) {
  if (!raw) return "";
  const m = String(raw).trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return raw;
  const [, yy, mm, dd, hh, mi] = m;
  return `${dd}.${mm}. - ${hh}:${mi}`;
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

function badgeHtml(type) {
  if (type === "wo") return '<span class="badge badge-wo">w.o.</span>';
  if (type === "ret") return '<span class="badge badge-wo">ret.</span>';
  return "";
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

function buildPlayersHtml(p1, p2, p3, p4, p1badge, p2badge, p3badge, p4badge, winner) {
  const cls1 = winner === 1 ? "ae-winner" : winner === 2 ? "ae-loser" : "";
  const cls2 = winner === 2 ? "ae-winner" : winner === 1 ? "ae-loser" : "";
  const isDouble = p2 || p4;
  if (isDouble) {
    const team1 = p2 ? `${p1} ${p1badge} / ${p2} ${p2badge}` : `${p1} ${p1badge}`;
    const team2 = p4 ? `${p3} ${p3badge} / ${p4} ${p4badge}` : `${p3} ${p3badge}`;
    return `<div class="ae-players">
      <div class="ae-team ${cls1}">${team1}</div>
      <div class="ae-separator">-</div>
      <div class="ae-team ${cls2}">${team2}</div>
    </div>`;
  }
  return `<div class="ae-players">
    <span><span class="${cls1}">${p1} ${p1badge}</span> - <span class="${cls2}">${p3} ${p3badge}</span></span>
  </div>`;
}

function renderMatches(values) {
  const el = document.getElementById('letzte');
  if (!el) return;

  const header = values[0].map((h) => h.trim().toLowerCase());
  const idx = (label) => header.indexOf(label);
  const i1 = idx("spieler1id");
  const i3 = idx("spieler3id");
  const i2 = idx("spieler2id");
  const i4 = idx("spieler4id");
  const ergebnisIdx = idx("ergebnis");
  const d = idx("matchdate");
  const bewerbIdIdx = idx("bewerbid");
  const rasterIdx = idx("bewerbrunde");

  const all = values.slice(1)
    .filter((row) => {
      if (!row || !row[i1]) return false;
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

  const titleHtml = '<div class="archived-title">Letzte Spiele</div>';
  if (all.length === 0) {
    el.innerHTML = titleHtml + '<div class="archived-empty">–</div>';
    return;
  }

  const lines = all.map((row) => {
    const pid1 = parsePlayerId(row[i1]);
    const pid3 = parsePlayerId(row[i3]);
    const pid2 = parsePlayerId(row[i2]);
    const pid4 = parsePlayerId(row[i4]);
    const p1 = playerMap.get(pid1.cleanId) || pid1.cleanId;
    const p3 = playerMap.get(pid3.cleanId) || pid3.cleanId;
    const p2 = pid2.cleanId ? (playerMap.get(pid2.cleanId) || pid2.cleanId) : "";
    const p4 = pid4.cleanId ? (playerMap.get(pid4.cleanId) || pid4.cleanId) : "";

    const datum = parseSheetDate(row[d]);
    const bewerbId = bewerbIdIdx !== -1 ? String(row[bewerbIdIdx] || "").trim() : "";
    const bewerbName = bewerbMap.get(bewerbId) || "";
    const runde = rasterIdx !== -1 ? parseRunde(row[rasterIdx]) : "";
    const headerParts = [datum, bewerbName, runde].filter(Boolean);
    const hdr = headerParts.join(" | ");

    const ergebnis = String(row[ergebnisIdx] || "").replace(/\((\d+)\)/g, '').trim();
    let winner = determineWinner(row[ergebnisIdx]);
    // [wo]-Logik: wer wo gibt, verliert
    if (!winner) {
      if (pid1.special === "wo") winner = 2;
      else if (pid3.special === "wo") winner = 1;
    }
    const playersHtml = buildPlayersHtml(p1, p2, p3, p4, badgeHtml(pid1.special), badgeHtml(pid2.special), badgeHtml(pid3.special), badgeHtml(pid4.special), winner);

    return `<div class="archived-entry">
      <div class="ae-header">${hdr}</div>
      <div class="ae-content">
        ${playersHtml}
        <div class="ae-result">${ergebnis || "—"}</div>
      </div>
    </div>`;
  });

  el.innerHTML = titleHtml + lines.join("");
}

function renderPreMatches(values) {
  const el = document.getElementById('nächste');
  if (!el) return;

  const header = values[0].map((h) => h.trim().toLowerCase());
  const idx = (label) => header.indexOf(label);
  const i1 = idx("spieler1id");
  const i3 = idx("spieler3id");
  const i2 = idx("spieler2id");
  const i4 = idx("spieler4id");
  const ergebnisIdx = idx("ergebnis");
  const d = idx("matchdate");
  const bewerbIdIdx = idx("bewerbid");
  const rasterIdx = idx("bewerbrunde");

  const all = values.slice(1)
    .filter((row) => {
      if (!row || !row[i1]) return false;
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

  const titleHtml = '<div class="archived-title">Nächste Spiele</div>';
  if (all.length === 0) {
    el.innerHTML = titleHtml + '<div class="archived-empty">–</div>';
    return;
  }

  const lines = all.map(({ row }) => {
    const pid1 = parsePlayerId(row[i1]);
    const pid3 = parsePlayerId(row[i3]);
    const pid2 = parsePlayerId(row[i2]);
    const pid4 = parsePlayerId(row[i4]);
    const p1 = playerMap.get(pid1.cleanId) || pid1.cleanId;
    const p3 = playerMap.get(pid3.cleanId) || pid3.cleanId;
    const p2 = pid2.cleanId ? (playerMap.get(pid2.cleanId) || pid2.cleanId) : "";
    const p4 = pid4.cleanId ? (playerMap.get(pid4.cleanId) || pid4.cleanId) : "";

    const datum = parseSheetDate(row[d]);
    const bewerbId = bewerbIdIdx !== -1 ? String(row[bewerbIdIdx] || "").trim() : "";
    const bewerbName = bewerbMap.get(bewerbId) || "";
    const runde = rasterIdx !== -1 ? parseRunde(row[rasterIdx]) : "";
    const headerParts = [datum, bewerbName, runde].filter(Boolean);
    const hdr = headerParts.join(" | ");

    const playersHtml = buildPlayersHtml(p1, p2, p3, p4, badgeHtml(pid1.special), badgeHtml(pid2.special), badgeHtml(pid3.special), badgeHtml(pid4.special), 0);

    return `<div class="pre-entry">
      <div class="ae-header">${hdr}</div>
      <div class="ae-content">
        ${playersHtml}
      </div>
    </div>`;
  });

  el.innerHTML = titleHtml + lines.join("");
}

async function pollAllMatches() {
  try {
    const res = await readMatches1();
    const { success, values } = res.data;
    if (success && Array.isArray(values) && values.length >= 2) {
      buildRasterMap(values, matchRasterMap, "id", "bewerbrunde");
      renderMatches(values);
      renderPreMatches(values);
    }
  } catch (err) {
    // silent
  }
  setTimeout(pollAllMatches, MATCHES_POLL);
}

function buildRasterMap(values, targetMap, idCol, rasterCol) {
  const header = values[0].map((h) => h.trim().toLowerCase());
  const idIdx = header.indexOf(idCol);
  const rIdx = header.indexOf(rasterCol);
  if (idIdx === -1 || rIdx === -1) return;
  targetMap.clear();
  values.slice(1).forEach((row) => {
    const id = String(row[idIdx] || "").trim();
    const raster = String(row[rIdx] || "").trim();
    if (id && raster) targetMap.set(id, raster);
  });
}

// ── Hilfsfunktionen DOM ──

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val || '-';
}

function setPlayerName(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  const name = val || '-';
  if (name.includes(" / ")) {
    const parts = name.split(" / ");
    el.classList.add("platz-cell-double");
    el.innerHTML = parts.map((p) => `<div>${p.trim()}</div>`).join("");
  } else {
    el.classList.remove("platz-cell-double");
    el.textContent = name;
  }
}

// ── Court data (Live-Scores via dataClient WebSocket) ──

let courtActive = { "1": false, "2": false };

function updateCourt(court) {
  const p = court.platz;
  if (p !== '1' && p !== '2') return;
  if (!courtActive[p]) return;
  const prefix = 'p' + p;
  setText(prefix + '-h-s1', court.satz1home);
  setText(prefix + '-h-s2', court.satz2home);
  setText(prefix + '-h-s3', court.satz3home);
  setText(prefix + '-h-p',  court.punktehome);
  setText(prefix + '-g-s1', court.satz1gast);
  setText(prefix + '-g-s2', court.satz2gast);
  setText(prefix + '-g-s3', court.satz3gast);
  setText(prefix + '-g-p',  court.punktegast);
}

function handleCourtData(data) {
  if (data && Array.isArray(data.courts)) {
    data.courts.forEach(updateCourt);
  }
}

// Score-Push über dataClient empfangen
setOnScoreChange(handleCourtData);

// ── Scoreboard-State (Spielernamen + Bewerb + Aktiv-Status aus stateStore) ──
// Wird IMMER gepollt, unabhängig vom aktiv-Status

function updateScoreboardCourt(courtKey, courtData) {
  if (courtKey !== '1' && courtKey !== '2') return;
  const prefix = 'p' + courtKey;
  setPlayerName(prefix + '-name-h', courtData.homePlayer);
  setPlayerName(prefix + '-name-g', courtData.guestPlayer);
  setText(prefix + '-datetime', courtData.dateTime);

  // Bewerb + Runde zusammensetzen
  // Runde aus stateStore oder per matchId aus den Match-Daten nachschlagen
  let runde = courtData.runde || "";
  if (!runde && courtData.matchId) {
    const rasterRaw = matchRasterMap.get(courtData.matchId) || "";
    runde = parseRunde(rasterRaw);
  }
  const bewerbParts = [courtData.bewerb, runde].filter(Boolean);
  setText(prefix + '-bewerb', bewerbParts.join(" | "));

  // Aktiv-Status setzen und Header einfärben
  const isActive = courtData.aktiv === 1;
  courtActive[courtKey] = isActive;

  const headerEl = document.querySelector(`#platz${courtKey} .platz-header`);
  if (headerEl) {
    headerEl.classList.remove("court-active", "court-inactive");
    headerEl.classList.add(isActive ? "court-active" : "court-inactive");
  }
}

async function pollScoreboard() {
  try {
    const res = await getScoreboardCourts();
    const { success, courts } = res.data;
    if (success && courts) {
      Object.keys(courts).forEach((key) => {
        updateScoreboardCourt(key, courts[key]);
      });
    }
  } catch (err) {
    // silent
  }
  setTimeout(pollScoreboard, SCOREBOARD_POLL);
}

// ── Init ──

await loadPlayers();
await loadBewerbe();

// Erster Durchlauf: Scoreboard laden (setzt aktiv-Status + startet WebSocket),
// dann Matches und PreMatches parallel
await pollScoreboard();
await pollAllMatches();

// Initiale Scores aktiv vom Service laden (nicht auf Push warten)
try {
  const scoresRes = await request("courtScores");
  if (scoresRes?.success && scoresRes.data) {
    handleCourtData(scoresRes.data);
  }
} catch (err) {
  // silent — Scores kommen dann beim nächsten Push
}

const loader = document.getElementById("scoreboard-loader");
const content = document.getElementById("scoreboard-content");
if (content) content.classList.add("loaded");
if (loader) loader.classList.add("hidden");
setTimeout(() => { if (loader) loader.remove(); }, 500);
