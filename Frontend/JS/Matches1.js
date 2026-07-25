import { createEndpoint } from "./dataClient.js";
import { callWithRetry, showLoadingOverlay, hideLoadingOverlay, showErrorOverlay } from "./loadingHelper.js";

const readMatches1 = createEndpoint("matches1");
const readPlayers = createEndpoint("players");
const readBewerbe = createEndpoint("bewerbe");

let allMatches = [];
let playerMap = new Map();
let playerFilterList = []; // {id, display: "Nachname Vorname"} für Filter-Dropdown
let bewerbMap = new Map();
let currentCategory = "played";

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

function parsePlayerId(raw) {
  const s = String(raw || "").trim();
  const wo = /\[w\.?o\.?\]/i.test(s);
  const ret = /\[ret\]/i.test(s);
  const cleanId = s.replace(/\[w\.?o\.?\]/gi, "").replace(/\[ret\]/gi, "").trim();
  const special = wo ? "wo" : ret ? "ret" : null;
  return {cleanId, special};
}

function determineWinner(ergebnis) {
  if (!ergebnis) return 0;
  const sets = String(ergebnis).split("/").filter(Boolean);
  let w1 = 0, w2 = 0;
  sets.forEach((s) => {
    const clean = s.replace(/\(\d+\)/g, "").replace(/\[ret\]/gi, "").trim();
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
function determineWinnerWithWo(ergebnis, p1special, p3special) {
  if (p1special === "wo" || p1special === "ret") return 2;
  if (p3special === "wo" || p3special === "ret") return 1;
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

function badgeHtml(type) {
  if (type === "wo") return '<span class="badge-wo">w.o.</span>';
  if (type === "ret") return '<span class="badge-ret">ret.</span>';
  return "";
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
          winner: determineWinnerWithWo(ergebnis, pid1.special, pid3.special),
          hasWo: !!(pid1.special === "wo" || pid2.special === "wo" || pid3.special === "wo" || pid4.special === "wo"),
          isPlayed: !!ergebnis || pid1.special === "wo" || pid3.special === "wo" || pid1.special === "ret" || pid3.special === "ret",
          isBye: /^BYE$/i.test(pid1.cleanId) || /^BYE$/i.test(pid3.cleanId || ""),
        });
      });
    }

    populateFilterDropdowns();
    renderMatches();
    hideLoadingOverlay();
  } catch (err) {
    console.error("Fehler:", err);
    showErrorOverlay("Fehler beim Laden der Matches", loadData);
  }
}

// ── Filter-Dropdowns befüllen ──

function populateFilterDropdowns() {
  const bewerbSelect = document.getElementById("filterBewerbSelect");
  const spielerSelect = document.getElementById("filterSpielerSelect");

  bewerbSelect.innerHTML = '<option value="">Alle</option>';
  const bewerbe = [...bewerbMap.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  bewerbe.forEach(([id, name]) => {
    bewerbSelect.innerHTML += `<option value="${id}">${name}</option>`;
  });

  spielerSelect.innerHTML = '<option value="">Alle</option>';
  playerFilterList.forEach(({id, display}) => {
    spielerSelect.innerHTML += `<option value="${id}">${display}</option>`;
  });
}

// ── Filtern + Sortieren ──

function getFilteredMatches() {
  let matches = [...allMatches].filter((m) => !m.isBye);

  // Grundkategorie
  if (currentCategory === "played") matches = matches.filter((m) => m.isPlayed);
  else if (currentCategory === "open") matches = matches.filter((m) => !m.isPlayed);

  // Optionale Filter
  if (document.getElementById("filterForderung")?.checked) {
    matches = matches.filter((m) => m.fordDateRaw && !m.matchDateRaw);
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
    container.innerHTML = "<p style='text-align:center;color:var(--muted);'>Keine Matches gefunden.</p>";
    return;
  }

  container.innerHTML = matches.map((m) => {
    const team1Name = m.p2.name ? `${m.p1.name} / ${m.p2.name}` : (m.p1.name || "—");
    const team2Name = m.p4.name ? `${m.p3.name} / ${m.p4.name}` : (m.p3.name || "—");
    const t1cls = m.winner === 1 ? " winner" : "";
    const t2cls = m.winner === 2 ? " winner" : "";
    const bewerbDisplay = [m.bewerbName, m.runde].filter(Boolean).join(" | ");
    const fordHtml = m.fordDate ? `<span class="m1-forderung">Forderung: ${m.fordDate}</span>` : "";

    return `<div class="m1-card">
      <div class="m1-meta">
        <span class="m1-date">${m.matchDate || "Datum offen"}</span>
        ${fordHtml}
        ${bewerbDisplay ? `<span class="m1-bewerb">${bewerbDisplay}</span>` : ""}
      </div>
      <div class="m1-content">
        <div class="m1-players">
          <div class="m1-team${t1cls}">
            <span class="m1-player">${team1Name} ${badgeHtml(m.p1.special)}</span>
          </div>
          <span class="m1-vs">vs.</span>
          <div class="m1-team${t2cls}">
            <span class="m1-player">${team2Name} ${badgeHtml(m.p3.special)}</span>
          </div>
        </div>
        <div class="m1-result">${m.ergebnisFormatted || ""}</div>
      </div>
    </div>`;
  }).join("");
}

// ── Event-Listener ──

function initControls() {
  // Kategorie-Buttons
  document.querySelectorAll(".m1-cat-btn").forEach((btn) => {
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
  ["filterForderung", "filterBewerb", "filterSpieler", "filterDatum", "filterMissing"].forEach((id) => {
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
document.addEventListener("DOMContentLoaded", () => {
  initControls();
  loadData();
});
