import { createEndpoint } from "./dataClient.js";
import { callWithRetry, showLoadingOverlay, hideLoadingOverlay, showErrorOverlay } from "./loadingHelper.js";

const setPreMatchResultFn = createEndpoint("setPreMatchResult");
const setMatchDateFn      = createEndpoint("setMatchDate");

function parseSheetDate(raw) {
  if (!raw) return "";
  const rawStr = String(raw).trim();
  const match = rawStr.match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!match) return rawStr;
  const [, yy, mm, dd, hh, mi] = match;
  const yyyy = parseInt(yy, 10) >= 50 ? "19" + yy : "20" + yy;
  return `${dd}.${mm}.${yyyy} - ${hh}:${mi}`;
}

function formatSetResult(raw) {
  if (!raw) return "";
  return String(raw).replace(/\((\d+)\)/g, (_, tiebreak) => {
    const superscripts = {"0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹"};
    return tiebreak.split("").map((d) => superscripts[d] || d).join("");
  });
}

function formatErgebnis(raw) {
  if (!raw) return "";
  return String(raw).split("/").map((s) => formatSetResult(s)).join("/");
}

function parsePlayerId(raw) {
  const s = String(raw || "").trim();
  const wo = /\[w\.?o\.?\]/i.test(s);
  const cleanId = s.replace(/\[w\.?o\.?\]/gi, "").trim();
  return { cleanId, special: wo ? "wo" : null };
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

function badgeHtml(type) {
  if (type === "wo") return ' <span class="badge badge-wo">w.o.</span>';
  if (type === "ret") return ' <span class="badge badge-wo">ret.</span>';
  return "";
}

//-------------------------------------------------------
// Modal: Datum und Platz setzen
//-------------------------------------------------------
function createDateModal() {
  const modal = document.createElement("div");
  modal.id = "dateModal";
  modal.className = "modal hidden";
  modal.innerHTML = `
    <div class="modal-content">
      <span class="close">&times;</span>
      <h2>Datum festlegen</h2>
      <p>Match: <span id="dateMatchInfo" class="name-display"></span></p>
      <form id="dateForm">
        <label for="matchDate">Datum:</label>
        <input type="date" id="matchDate" required>
        <label for="matchTime">Uhrzeit:</label>
        <input type="time" id="matchTime" required>
        <button type="submit" class="btn-login">Speichern</button>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector(".close").addEventListener("click", () => modal.classList.add("hidden"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
  return modal;
}

const dateModal = createDateModal();
let currentDateRow = null;
let currentDateMatch = null;

function formatDateToSheet(dateStr, timeStr) {
  const d = new Date(`${dateStr}T${timeStr || "00:00:00"}`);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yy}${mm}${dd}-${hh}${mi}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

window.openDateModal = (row, match) => {
  currentDateRow = row;
  currentDateMatch = match;
  const team1 = [match.player1, match.player2].filter(Boolean).join(" / ") || "---";
  const team2 = [match.player3, match.player4].filter(Boolean).join(" / ") || "---";
  document.getElementById("dateMatchInfo").textContent = `${team1} vs ${team2}`;
  document.getElementById("matchDate").value = "";
  document.getElementById("matchTime").value = "";
  dateModal.classList.remove("hidden");
};

window.closeDateModal = () => {
  dateModal.classList.add("hidden");
  currentDateRow = null;
  currentDateMatch = null;
};

document.getElementById("dateForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const dateVal = document.getElementById("matchDate").value.trim();
  const timeVal = document.getElementById("matchTime").value.trim();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (!dateVal || !timeVal) { showToast("Bitte Datum und Uhrzeit ausfüllen!", "error"); return; }
  const datum = formatDateToSheet(dateVal, timeVal);
  submitBtn.disabled = true;
  submitBtn.textContent = "Speichern...";
  try {
    const result = await setMatchDateFn({row: currentDateRow, datum});
    if (result.data?.success) {
      submitBtn.textContent = "Gespeichert!";
      setTimeout(() => { window.closeDateModal(); loadPreMatches(); }, 500);
    } else {
      throw new Error(result.data?.error || "Fehler");
    }
  } catch (err) {
    console.error("Fehler beim Setzen des Datums:", err);
    showToast("Fehler: " + err.message, "error");
    submitBtn.disabled = false;
    submitBtn.textContent = "Speichern";
  }
});

//-------------------------------------------------------
// Modal: Ergebnis eintragen
//-------------------------------------------------------
function createResultModal() {
  const modal = document.createElement("div");
  modal.id = "resultModal";
  modal.className = "modal hidden";
  modal.innerHTML = `
    <div class="modal-content">
      <span class="close">&times;</span>
      <h2>Ergebnis eintragen</h2>
      <p>Match: <span id="resultMatchInfo" class="name-display"></span></p>
      <form id="resultForm">
        <div class="satz-input-group">
          <label for="satz1">Satz 1:</label>
          <input type="text" id="satz1" placeholder="z.B. 6:4" required pattern="\\d+:\\d+">
        </div>
        <div class="satz-input-group">
          <label for="satz2">Satz 2:</label>
          <input type="text" id="satz2" placeholder="z.B. 3:6" required pattern="\\d+:\\d+">
        </div>
        <div class="satz-input-group">
          <label for="satz3">Satz 3:</label>
          <input type="text" id="satz3" placeholder="z.B. 7:5" pattern="\\d+:\\d+">
        </div>
        <button type="submit" class="btn-login">Ergebnis senden</button>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector(".close").addEventListener("click", () => modal.classList.add("hidden"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
  return modal;
}

const resultModal = createResultModal();
let currentResultRow = null;

window.openResultModal = (row, matchInfo) => {
  currentResultRow = row;
  document.getElementById("resultMatchInfo").textContent = matchInfo;
  document.getElementById("satz1").value = "";
  document.getElementById("satz2").value = "";
  document.getElementById("satz3").value = "";
  resultModal.classList.remove("hidden");
};

window.closeResultModal = () => {
  resultModal.classList.add("hidden");
  currentResultRow = null;
};

document.getElementById("resultForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentResultRow) return;
  const userId = localStorage.getItem("currentUserId");
  if (!userId) { showToast("Bitte einloggen um das Ergebnis einzutragen.", "error"); return; }
  const satz1 = document.getElementById("satz1").value.trim();
  const satz2 = document.getElementById("satz2").value.trim();
  const satz3 = document.getElementById("satz3").value.trim();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = "Senden...";
  try {
    const result = await setPreMatchResultFn({row: currentResultRow, satz1, satz2, satz3, userId});
    if (result.data?.success) {
      submitBtn.textContent = "Gesendet!";
      setTimeout(() => { window.closeResultModal(); loadPreMatches(); }, 500);
    } else {
      throw new Error(result.data?.error || "Fehler");
    }
  } catch (err) {
    console.error("Fehler:", err);
    showToast("Fehler: " + err.message, "error");
    submitBtn.disabled = false;
    submitBtn.textContent = "Ergebnis senden";
  }
});

let cachedPlayerMap = null;
let cachedBewerbMap = null;
let cachedBewerbsartMap = null;

async function loadMaps() {
  if (cachedPlayerMap) return;

  const readPlayersList = createEndpoint("players");
  const readBewerbe = createEndpoint("bewerbe");
  const readBewerbsart = createEndpoint("bewerbsart");

  const [playersRes, bewerbeRes, bewerbsartRes] = await Promise.all([
    readPlayersList(),
    readBewerbe(),
    readBewerbsart(),
  ]);

  const playerValues = playersRes.data?.values || [];
  const playerHeader = playerValues[0]?.map((h) => h.trim().toLowerCase()) || [];
  const pIdIdx = playerHeader.indexOf("id");
  const pFnIdx = playerHeader.indexOf("vorname");
  const pLnIdx = playerHeader.indexOf("nachname");
  cachedPlayerMap = new Map();
  playerValues.slice(1).forEach((r) => {
    const id = String(r[pIdIdx] || "");
    const name = ((r[pFnIdx] || "") + " " + (r[pLnIdx] || "")).trim();
    if (id) cachedPlayerMap.set(id, name);
  });

  const bewerbValues = bewerbeRes.data?.values || [];
  cachedBewerbMap = new Map();
  if (bewerbValues.length > 1) {
    const bHeader = bewerbValues[0].map((h) => h.trim().toLowerCase());
    const bIdIdx = bHeader.indexOf("id");
    const bBewerbsartIdIdx = bHeader.indexOf("bewerbsartid");
    const bBezIdx = bHeader.indexOf("bezeichnung");
    bewerbValues.slice(1).forEach((r) => {
      const id = String(r[bIdIdx] || "").trim();
      const baId = String(r[bBewerbsartIdIdx] || "").trim();
      const bez = String(r[bBezIdx] || "").trim();
      if (id) cachedBewerbMap.set(id, {bezeichnung: bez, bewerbsartId: baId});
    });
  }

  const bewerbsartValues = bewerbsartRes.data?.values || [];
  cachedBewerbsartMap = new Map();
  if (bewerbsartValues.length > 1) {
    const baHeader = bewerbsartValues[0].map((h) => h.trim().toLowerCase());
    const baIdIdx = baHeader.indexOf("id");
    const baBezIdx = baHeader.indexOf("bezeichnung");
    bewerbsartValues.slice(1).forEach((r) => {
      const id = String(r[baIdIdx] || "").trim();
      const name = String(r[baBezIdx] || "").trim();
      if (id) cachedBewerbsartMap.set(id, name);
    });
  }
}

async function loadPreMatches() {
  const container = document.getElementById("preMatches-container");
  if (!container) return;

  const userId = localStorage.getItem("currentUserId") || null;
  container.innerHTML = "";
  showLoadingOverlay("Lade offene Matches...");

  try {
    const readPreMatches = createEndpoint("preMatches");
    const result = await callWithRetry(readPreMatches);
    if (!result.data?.success) throw new Error(result.data?.error || "Fehler beim Laden");

    const preValues = result.data.values || [];
    if (preValues.length < 2) {
      container.innerHTML = "<p>Keine offenen Matches.</p>";
      return;
    }

    await loadMaps();

    const preHeader = preValues[0].map((h) => h.trim().toLowerCase());
    const i1 = preHeader.indexOf("spieler1id");
    const i2 = preHeader.indexOf("spieler2id");
    const i3 = preHeader.indexOf("spieler3id");
    const i4 = preHeader.indexOf("spieler4id");
    const d = preHeader.indexOf("matchdate");
    const zeitpunktForderungIdx = preHeader.indexOf("forderungdate");
    const bewerbIdIdx = preHeader.indexOf("bewerbid");
    const rasterIdx = preHeader.indexOf("bewerbrunde");
    // status wird nicht mehr als Spalte verwendet
    const er = preHeader.indexOf("ergebnis");

    function dateToTs(raw) {
      if (!raw) return Infinity;
      const m = String(raw).trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
      if (!m) return Infinity;
      const [, yy, mm, dd, hh, mi] = m;
      const yyyy = parseInt(yy, 10) >= 50 ? 1900 + parseInt(yy) : 2000 + parseInt(yy);
      return new Date(yyyy, parseInt(mm) - 1, parseInt(dd), parseInt(hh), parseInt(mi)).getTime();
    }
    const now = Date.now();
    const preValuesData = preValues.slice(1)
      .map((row, idx) => ({ row, origIdx: idx }))
      .filter(({ row }) => !/^BYE$/i.test(String(row[i1])) && !/^BYE$/i.test(String(row[i3])))
      .sort((a, b) => {
        const tsA = dateToTs(a.row[d]);
        const tsB = dateToTs(b.row[d]);
        const aHasDate = tsA !== Infinity;
        const bHasDate = tsB !== Infinity;

        // Matches MIT Datum zuerst, ältestes zuerst
        if (aHasDate && bHasDate) return tsA - tsB;
        if (aHasDate && !bHasDate) return -1;
        if (!aHasDate && bHasDate) return 1;

        // Beide ohne Datum: Ranglistenspiele (bewerbsartId "2") zuerst
        const bIdA = bewerbIdIdx !== -1 ? String(a.row[bewerbIdIdx] || "").trim() : "";
        const bIdB = bewerbIdIdx !== -1 ? String(b.row[bewerbIdIdx] || "").trim() : "";
        const infoA = cachedBewerbMap.get(bIdA) || {};
        const infoB = cachedBewerbMap.get(bIdB) || {};
        const aIsRL = infoA.bewerbsartId === "2";
        const bIsRL = infoB.bewerbsartId === "2";

        if (aIsRL && !bIsRL) return -1;
        if (!aIsRL && bIsRL) return 1;

        // Beide Ranglistenspiele: nach Forderungsdatum (ältestes zuerst)
        if (aIsRL && bIsRL) {
          const fA = dateToTs(a.row[zeitpunktForderungIdx]);
          const fB = dateToTs(b.row[zeitpunktForderungIdx]);
          if (fA !== fB) return fA - fB;
        }

        // Beide keine Ranglistenspiele (oder gleich): alphanumerisch nach Bewerbsname
        const nameA = (infoA.bezeichnung || "").toLowerCase();
        const nameB = (infoB.bezeichnung || "").toLowerCase();
        return nameA.localeCompare(nameB);
      });

    const preMatches = [];
    preValuesData.forEach(({ row, origIdx }) => {
      const rowNum = origIdx + 2;
      const pid1 = parsePlayerId(row[i1]);
      const pid2 = parsePlayerId(row[i2]);
      const pid3 = parsePlayerId(row[i3]);
      const pid4 = parsePlayerId(row[i4]);
      const datum = parseSheetDate(row[d] || "");
      const bewerbId = bewerbIdIdx !== -1 ? (String(row[bewerbIdIdx] || "").trim() || "2") : "2";
      const bewerbInfo = cachedBewerbMap.get(bewerbId) || {};
      const bewerbsartName = cachedBewerbsartMap.get(bewerbInfo.bewerbsartId || "") || "";
      const zeitpunktForderungRaw = zeitpunktForderungIdx !== -1 ? String(row[zeitpunktForderungIdx] || "") : "";
      const status = "offen"; // status-Spalte entfernt, Default "offen"
      const ergebnis = er !== -1 ? formatErgebnis(row[er] || "") : "";
      const runde = rasterIdx !== -1 ? parseRunde(row[rasterIdx]) : "";
      const isForMe = userId ? [pid1.cleanId, pid2.cleanId, pid3.cleanId, pid4.cleanId].includes(userId) : false;

      preMatches.push({
        row: rowNum,
        player1: cachedPlayerMap.get(pid1.cleanId) || pid1.cleanId,
        player2: cachedPlayerMap.get(pid2.cleanId) || pid2.cleanId,
        player3: cachedPlayerMap.get(pid3.cleanId) || pid3.cleanId,
        player4: cachedPlayerMap.get(pid4.cleanId) || pid4.cleanId,
        player1Id: pid1.cleanId,
        player2Id: pid2.cleanId,
        player3Id: pid3.cleanId,
        player4Id: pid4.cleanId,
        player1Special: pid1.special,
        player2Special: pid2.special,
        player3Special: pid3.special,
        player4Special: pid4.special,
        datum,
        bewerbId,
        bewerbsartId: bewerbInfo.bewerbsartId || "",
        bewerbsart: bewerbsartName,
        bewerbBezeichnung: bewerbInfo.bezeichnung || "",
        runde,
        zeitpunktForderung: parseSheetDate(zeitpunktForderungRaw),
        status,
        ergebnis,
        isForMe,
        canEnterResult: !ergebnis && isForMe,
      });
    });

    container.innerHTML = preMatches.map((match) => {
      const team1Name = [match.player1, match.player2].filter(Boolean).join(" / ") || "---";
      const team2Name = [match.player3, match.player4].filter(Boolean).join(" / ") || "---";
      const team1Special = match.player1Special || match.player2Special;
      const team2Special = match.player3Special || match.player4Special;
      const team1 = team1Name + badgeHtml(team1Special);
      const team2 = team2Name + badgeHtml(team2Special);
      const statusBadge = getStatusBadge(match.status, match.ergebnis);
      const actionButton = getActionButton(match, userId);
      const bewerbName = escapeHtml(match.bewerbBezeichnung || match.bewerbsart || "");
      const bewerbDisplay = [bewerbName, match.runde].filter(Boolean).join(" | ");
      const isRangliste = match.bewerbsartId === "2";
      const forderungsHtml = isRangliste && match.zeitpunktForderung
        ? `<div class="match-forderung">Forderungs Datum: ${escapeHtml(match.zeitpunktForderung)}</div>`
        : "";

      return `
        <div class="match-card ${match.status === 'offen' ? 'status-offen' : match.status === 'bestaetigt' ? 'status-bestaetigt' : ''}">
          ${forderungsHtml}
          <div class="match-meta-row">
            <span class="match-date">Spiel Datum: ${match.datum || "Datum nicht festgelegt"}</span>
            <div class="match-meta-right">
              <div class="match-header">
                <span class="badge-bewerb">${bewerbDisplay}</span>
              </div>
              ${statusBadge}
            </div>
          </div>
          <div class="match-content">
            <div class="team">
              <div class="player main">${team1}</div>
            </div>
            <div class="vs">vs.</div>
            <div class="team">
              <div class="player main">${team2}</div>
            </div>
            <div class="action-area">
              ${actionButton}
            </div>
          </div>
        </div>
      `;
    }).join("");

    document.querySelectorAll(".result-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = parseInt(btn.dataset.row);
        const match = preMatches.find((m) => m.row === row);
        const matchInfo = `${match?.player1 || ""} vs ${match?.player3 || ""}`;
        window.openResultModal(row, matchInfo);
      });
    });

    document.querySelectorAll(".date-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = parseInt(btn.dataset.row);
        const match = preMatches.find((m) => m.row === row);
        window.openDateModal(row, match);
      });
    });

    hideLoadingOverlay();
  } catch (err) {
    console.error("Fehler beim Laden:", err);
    showErrorOverlay("Fehler beim Laden der offenen Matches", loadPreMatches);
  }
}

function getStatusBadge(status, ergebnis) {
  if (ergebnis) return '<span class="badge badge-ergebnis">Ergebnis eingetragen</span>';
  switch (status) {
    case "offen": return '<span class="badge badge-offen">Offen</span>';
    case "bestaetigt": return '<span class="badge badge-bestaetigt">Bestätigt</span>';
    case "gespielt": return '<span class="badge badge-gespielt">Gespielt</span>';
    case "abgelaufen": return '<span class="badge badge-abgelaufen">Abgelaufen</span>';
    default: return `<span class="badge">${status}</span>`;
  }
}

function getActionButton(match, userId) {
  if (!userId) return `<span class="loggedout">Anmelden</span>`;
  const userIsInvolved = match.player1Id === userId || match.player2Id === userId || match.player3Id === userId || match.player4Id === userId;
  if (!userIsInvolved) return `<span class="waiting-text">---</span>`;
  if (!match.datum) return `<button class="date-btn btn-action" data-row="${match.row}">Datum setzen</button>`;
  if (match.datum && !match.ergebnis) return `<button class="result-btn btn-action loggedIn" data-row="${match.row}">Ergebnis</button>`;
  return `<span class="waiting-text">---</span>`;
}

document.addEventListener("DOMContentLoaded", () => {
  loadPreMatches();
});
