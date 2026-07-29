import { createEndpoint, getOperationId, releaseOperationId, subscribeInvalidations } from "./dataClient.js";
import { ready, getUser, subscribeAuth } from "./authClient.js";
import { callWithRetry, errorMessage, showLoadingOverlay, hideLoadingOverlay, showErrorOverlay } from "./loadingHelper.js";
import { signalMonitorReady, signalMonitorFailed } from "./monitorReady.js";

const readEntryList     = createEndpoint("entryList");
const readPlayersList   = createEndpoint("players");
const readBewerbe       = createEndpoint("bewerbe");
const readRlPlatzierung = createEndpoint("rlPlatzierung");
const addEntryList      = createEndpoint("addEntryList");
const removeEntryList   = createEndpoint("removeEntryList");

const params = new URLSearchParams(window.location.search);
const BEWERB_ID = params.get("id");
let currentEntries = [];
let entryStartDate = null;
let entryDeadlineDate = null;
let entryStartRaw = "";
let entryDeadlineRaw = "";
let entriesLoaded = false;
let entryBoundaryTimer = null;

function errorMessage(value, fallback) {
  if (value instanceof Error && value.message) return value.message;
  if (value?.error?.message) return value.error.message;
  if (typeof value?.error === "string") return value.error;
  if (value?.message) return value.message;
  return fallback;
}

// Parst Datumsformat: "YYMMDD", "YYMMDD-HHMM", "YYYYMMDD", "YYYYMMDD-HHMM"
// Bei nur Datum: Start → 00:00, Deadline → 23:59
function parseSheetDate(raw, isDeadline = false) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Format YYMMDD-HHMM
  const mTime6 = s.match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (mTime6) {
    const y = +mTime6[1] >= 50 ? 1900 + +mTime6[1] : 2000 + +mTime6[1];
    return new Date(y, +mTime6[2] - 1, +mTime6[3], +mTime6[4], +mTime6[5]);
  }

  // Format YYYYMMDD-HHMM
  const mTime8 = s.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (mTime8) {
    return new Date(+mTime8[1], +mTime8[2] - 1, +mTime8[3], +mTime8[4], +mTime8[5]);
  }

  // Format YYMMDD (nur Datum)
  const m6 = s.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (m6) {
    const y = +m6[1] >= 50 ? 1900 + +m6[1] : 2000 + +m6[1];
    if (isDeadline) return new Date(y, +m6[2] - 1, +m6[3], 23, 59, 59);
    return new Date(y, +m6[2] - 1, +m6[3], 0, 0, 0);
  }

  // Format YYYYMMDD (nur Datum)
  const m8 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m8) {
    if (isDeadline) return new Date(+m8[1], +m8[2] - 1, +m8[3], 23, 59, 59);
    return new Date(+m8[1], +m8[2] - 1, +m8[3], 0, 0, 0);
  }

  return null;
}

// Formatiert Roh-Datum für Anzeige
function formatEntryDate(raw) {
  if (!raw) return "";
  const s = String(raw).trim();

  // Format YYMMDD-HHMM
  const mTime6 = s.match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (mTime6) {
    const [, yy, mm, dd, hh, mi] = mTime6;
    const yyyy = +yy >= 50 ? `19${yy}` : `20${yy}`;
    return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
  }

  // Format YYYYMMDD-HHMM
  const mTime8 = s.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (mTime8) {
    const [, yyyy, mm, dd, hh, mi] = mTime8;
    return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
  }

  // Format YYMMDD
  const m6 = s.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (m6) {
    const [, yy, mm, dd] = m6;
    const yyyy = +yy >= 50 ? `19${yy}` : `20${yy}`;
    return `${dd}.${mm}.${yyyy}`;
  }

  // Format YYYYMMDD
  const m8 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m8) {
    const [, yyyy, mm, dd] = m8;
    return `${dd}.${mm}.${yyyy}`;
  }

  return s;
}

function isEntryPeriodActive() {
  const now = new Date();
  if (entryStartDate && now < entryStartDate) return false;
  if (entryDeadlineDate && now > entryDeadlineDate) return false;
  return true;
}

function scheduleEntryBoundary() {
  if (entryBoundaryTimer) clearTimeout(entryBoundaryTimer);
  entryBoundaryTimer = null;
  const now = Date.now();
  const next = [entryStartDate, entryDeadlineDate]
    .map((value) => value?.getTime())
    .filter((value) => Number.isFinite(value) && value > now)
    .sort((left, right) => left - right)[0];
  if (!next) return;
  entryBoundaryTimer = setTimeout(() => {
    entryBoundaryTimer = null;
    initToolbar();
    scheduleEntryBoundary();
  }, Math.min(2147483647, Math.max(1, next - now + 50)));
}

function formatStoredDate(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return "–";
  }

  const input = String(raw).trim();
  const normalized = input.replace(/–/g, "-").replace(/\s+/g, "");

  const shortMatch = normalized.match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (shortMatch) {
    const [, yy, mm, dd, hh, mi] = shortMatch;
    const yyyy = parseInt(yy, 10) >= 50 ? `19${yy}` : `20${yy}`;
    return `${dd}.${mm}.${yyyy} - ${hh}:${mi}`;
  }

  const longMatch = normalized.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (longMatch) {
    const [, yyyy, mm, dd, hh, mi] = longMatch;
    return `${dd}.${mm}.${yyyy} - ${hh}:${mi}`;
  }

  const prettyMatch = input.match(/^(\d{2})\.(\d{2})\.(\d{4})\s*[-–]\s*(\d{2}):(\d{2})$/);
  if (prettyMatch) {
    const [, dd, mm, yyyy, hh, mi] = prettyMatch;
    return `${dd}.${mm}.${yyyy} - ${hh}:${mi}`;
  }

  return input;
}

async function loadEntries() {
  const container = document.getElementById("entryListContainer");
  if (!container) {
    const error = new Error("Entrylist-Container fehlt.");
    error.code = "ENTRY_LIST_CONTAINER_MISSING";
    throw error;
  }

  container.replaceChildren();
  showLoadingOverlay("Lade Einträge...");

  if (!BEWERB_ID) {
    hideLoadingOverlay();
    const message = document.createElement("p");
    message.textContent = "Keine Bewerb-ID übergeben.";
    container.appendChild(message);
    const error = new Error("Keine Bewerb-ID übergeben.");
    error.code = "COMPETITION_ID_MISSING";
    throw error;
  }

  try {
    const [entryRes, playerRes, rlRes, bewerbeRes] = await Promise.all([
      callWithRetry(readEntryList, { bewerbId: BEWERB_ID }),
      callWithRetry(readPlayersList),
      callWithRetry(readRlPlatzierung),
      callWithRetry(readBewerbe),
    ]);

    const failedResponse = [entryRes, playerRes, rlRes, bewerbeRes]
      .find((response) => !response.data?.success);
    if (failedResponse) {
      throw new Error(errorMessage(failedResponse.data, "Fehler beim Laden der Entrylist."));
    }

    const entryValues = entryRes.data.values || [];
    const playerValues = playerRes.data?.values || [];
    const rlValues = rlRes.data?.values || [];
    const bewerbeValues = bewerbeRes.data?.values || [];

    // Geschlecht des aktuellen Bewerbs ermitteln
    let bewerbGeschlecht = "";
    let rlBewerbId = "";
    if (bewerbeValues.length > 1) {
      const bHeader = bewerbeValues[0].map((h) => String(h || "").trim().toLowerCase());
      const bIdIdx = bHeader.indexOf("id");
      const bBaIdx = bHeader.indexOf("bewerbsartid");
      const bGeschIdx = bHeader.indexOf("geschlecht");

      // Geschlecht des aktuellen Bewerbs
      const currentBewerb = bewerbeValues.slice(1).find((r) => String(r[bIdIdx] || "").trim() === String(BEWERB_ID).trim());
      if (currentBewerb && bGeschIdx >= 0) {
        bewerbGeschlecht = String(currentBewerb[bGeschIdx] || "").trim();
      }

      // Passenden Ranglisten-Bewerb finden (bewerbsartId=2, gleiches Geschlecht)
      if (bewerbGeschlecht) {
        const rlBewerb = bewerbeValues.slice(1).find((r) => {
          const baId = String(r[bBaIdx] || "").trim();
          const gesch = String(r[bGeschIdx] || "").trim();
          return baId === "2" && gesch === bewerbGeschlecht;
        });
        if (rlBewerb) rlBewerbId = String(rlBewerb[bIdIdx] || "").trim();
      }
    }

    // Ranglisten-Map: personId → Rang (gefiltert nach passendem RL-Bewerb)
    const rlMap = new Map();
    if (rlValues.length > 1 && rlBewerbId) {
      const rlHeader = rlValues[0].map((h) => String(h || "").trim().toLowerCase());
      const rlPersonIdx = rlHeader.indexOf("personid");
      const rlRangIdx = rlHeader.indexOf("rang");
      const rlBewerbIdx = rlHeader.indexOf("bewerbid");
      if (rlPersonIdx >= 0 && rlRangIdx >= 0) {
        rlValues.slice(1).forEach((r) => {
          const bId = rlBewerbIdx >= 0 ? String(r[rlBewerbIdx] || "").trim() : "";
          if (bId !== rlBewerbId) return;
          const pid = String(r[rlPersonIdx] || "").trim();
          const rang = parseInt(String(r[rlRangIdx] || ""), 10);
          if (pid && !isNaN(rang)) rlMap.set(pid, rang);
        });
      }
    }

    const playerMap = new Map();
    if (playerValues.length > 1) {
      const pHeader = playerValues[0].map((h) => String(h || "").trim().toLowerCase());
      const pIdIdx = pHeader.indexOf("id");
      const pFnIdx = pHeader.indexOf("vorname");
      const pLnIdx = pHeader.indexOf("nachname");
      playerValues.slice(1).forEach((r) => {
        const id = String(r[pIdIdx] || "").trim();
        const vorname = String(r[pFnIdx] || "").trim();
        const nachname = String(r[pLnIdx] || "").trim();
        const display = `${nachname} ${vorname}`.trim();
        if (id) playerMap.set(id, { display, nachname });
      });
    }

    let entries = [];
    if (entryValues.length > 1) {
      const eHeader = entryValues[0].map((h) => String(h || "").trim().toLowerCase());
      const eIdIdx = eHeader.indexOf("id");
      const eBewerbIdIdx = eHeader.findIndex((h) =>
        ["bewerbid", "bewerb id", "bewerb-id", "bewerb", "bewerbsid", "bewerbs id"].includes(h));
      const ePersonenIdIdx = eHeader.findIndex((h) =>
        ["personenid", "personen id", "personen-id", "personid", "person id", "playerid", "player id", "spielerid", "spieler id"].includes(h));
      const eDatumIdx = eHeader.findIndex((h) =>
        ["datum", "date", "eingetragen", "timestamp", "zeitpunkt", "entrydate", "entry date"].includes(h));
      const eGebuehrIdx = eHeader.findIndex((h) =>
        ["gebuehrbezahlt", "gebuehr bezahlt", "gebühr bezahlt", "gebuehr", "gebühr"].includes(h));

      entries = entryValues.slice(1)
        .filter((r) => {
          const ebId = eBewerbIdIdx !== -1 ? String(r[eBewerbIdIdx] || "").trim() : "";
          return ebId === BEWERB_ID;
        })
        .map((r) => {
          const personenId = ePersonenIdIdx !== -1 ? String(r[ePersonenIdIdx] || "").trim() : "";
          const playerInfo = playerMap.get(personenId) || { display: "Unbekannt", nachname: "" };
          const gebuehrBezahlt = eGebuehrIdx !== -1 ? String(r[eGebuehrIdx] || "").trim() : "";
          return {
            id: eIdIdx !== -1 ? String(r[eIdIdx] || "").trim() : "",
            personenId,
            name: playerInfo.display,
            nachname: playerInfo.nachname,
            rlRang: rlMap.get(personenId) || "",
            datum: eDatumIdx !== -1 ? String(r[eDatumIdx] || "").trim() : "",
            gebuehrBezahlt: gebuehrBezahlt !== "",
          };
        })
        .sort((a, b) => a.nachname.localeCompare(b.nachname));
    }

    currentEntries = entries;
    initToolbar();

    if (entries.length === 0) {
      const message = document.createElement("p");
      message.textContent = "Noch keine Einträge für diesen Bewerb.";
      container.appendChild(message);
      hideLoadingOverlay();
      return;
    }

    const table = document.createElement("table");
    table.className = "players-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    ["#", "ID", "RL", "Name", "Eingetragen am"].forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    entries.forEach((entry, idx) => {
      const tr = document.createElement("tr");
      if (entry.gebuehrBezahlt) tr.classList.add("entry-paid");
      [
        idx + 1,
        entry.personenId,
        entry.rlRang || "—",
        entry.name || "Unbekannt",
        formatStoredDate(entry.datum),
      ].forEach((value) => {
        const td = document.createElement("td");
        td.textContent = String(value);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    container.replaceChildren();
    container.appendChild(table);
    hideLoadingOverlay();
  } catch (err) {
    console.error("Fehler beim Laden der Einträge:", err);
    showErrorOverlay(errorMessage(err, "Fehler beim Laden der Einträge"), () => {
      loadEntries().catch(() => {});
    });
    throw err;
  }
}

async function handleEntrySubmit(btn) {
  const personenId = String(getUser()?.id || "").trim();
  if (!personenId) {
    showToast("Bitte vorher einloggen!", "error");
    return;
  }

  if (currentEntries.some((entry) => entry.personenId === personenId)) {
    showToast("Du bist für diesen Bewerb bereits eingetragen.", "error");
    return;
  }

  if (!isEntryPeriodActive()) {
    showToast("Die Eintragungsfrist ist nicht aktiv.", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Sende...";
  const operationKey = `entry:add:${BEWERB_ID}:${personenId}`;

  try {
    const res = await addEntryList({
      operationId: getOperationId(operationKey),
      bewerbId: BEWERB_ID,
    });

    if (res.data?.success) {
      releaseOperationId(operationKey);
      showToast("Erfolgreich eingetragen!", "success");
      await loadEntries();
    } else {
      throw new Error(errorMessage(res.data, "Fehler beim Eintragen"));
    }
  } catch (err) {
    releaseOperationId(operationKey, err);
    console.error("Fehler beim Eintragen:", err);
    showToast("Fehler: " + (err.message || err), "error");
  }

  btn.disabled = false;
  btn.textContent = "Eintragen";
}

async function loadBewerbsName() {
  const heading = document.getElementById("entryListHeading");
  if (!BEWERB_ID) return;

  if (heading) heading.textContent = "Entrylist für";

  const res = await callWithRetry(readBewerbe);
  if (!res.data?.success) {
    throw new Error(errorMessage(res.data, "Bewerb konnte nicht geladen werden."));
  }
  const bewerbeValues = res.data.values || [];
  if (bewerbeValues.length < 2) return;

  const bHeader = bewerbeValues[0].map((h) => String(h || "").trim().toLowerCase());
  const bIdIdx = bHeader.indexOf("id");
  const bBezIdx = bHeader.indexOf("bezeichnung");
  const bEntryStartIdx = bHeader.indexOf("entrystart");
  const bEntryDeadlineIdx = bHeader.indexOf("entrydeadline");
  const bewerbRow = bewerbeValues.slice(1).find((r) => String(r[bIdIdx] || "").trim() === String(BEWERB_ID).trim());
  entryStartRaw = "";
  entryDeadlineRaw = "";
  entryStartDate = null;
  entryDeadlineDate = null;
  if (bewerbRow) {
    if (heading && bewerbRow[bBezIdx]) {
      heading.textContent = `Entrylist für ${bewerbRow[bBezIdx]}`;
    }
    entryStartRaw = bEntryStartIdx !== -1 ? String(bewerbRow[bEntryStartIdx] || "").trim() : "";
    entryDeadlineRaw = bEntryDeadlineIdx !== -1 ? String(bewerbRow[bEntryDeadlineIdx] || "").trim() : "";
    entryStartDate = parseSheetDate(entryStartRaw, false);
    entryDeadlineDate = parseSheetDate(entryDeadlineRaw, true);
  }
  scheduleEntryBoundary();
}

async function handleEntryRemove(btn) {
  const personenId = String(getUser()?.id || "").trim();
  if (!personenId) {
    showToast("Bitte vorher einloggen!", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Entferne...";
  const operationKey = `entry:remove:${BEWERB_ID}:${personenId}`;

  try {
    const res = await removeEntryList({
      operationId: getOperationId(operationKey),
      bewerbId: BEWERB_ID,
    });

    if (res.data?.success) {
      releaseOperationId(operationKey);
      showToast("Erfolgreich ausgetragen!", "success");
      await loadEntries();
    } else {
      throw new Error(errorMessage(res.data, "Fehler beim Austragen"));
    }
  } catch (err) {
    releaseOperationId(operationKey, err);
    console.error("Fehler beim Austragen:", err);
    showToast("Fehler: " + (err.message || err), "error");
  }

  btn.disabled = false;
  btn.textContent = "Austragen";
}

function initToolbar() {
  const toolbar = document.getElementById("entryListToolbar");
  if (!toolbar) return;

  toolbar.replaceChildren();
  if (!BEWERB_ID) return;

  const active = isEntryPeriodActive();
  let statusMsg = "";
  if (!active) {
    const von = formatEntryDate(entryStartRaw);
    const bis = formatEntryDate(entryDeadlineRaw);
    let zeitraum = "";
    if (von && bis) zeitraum = ` (${von} bis ${bis})`;
    else if (von) zeitraum = ` (ab ${von})`;
    else if (bis) zeitraum = ` (bis ${bis})`;
    statusMsg = `Die Entrylist ist aktuell nicht geöffnet${zeitraum}.`;
  }

  if (statusMsg) {
    const msg = document.createElement("p");
    msg.className = "bewerb-date-info";
    msg.textContent = statusMsg;
    toolbar.appendChild(msg);
  }

  const personenId = String(getUser()?.id || "").trim();
  if (!personenId) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-login";
    btn.textContent = "Zum Eintragen anmelden";
    btn.addEventListener("click", () => window.openLoginModal?.());
    toolbar.appendChild(btn);
    return;
  }

  const isRegistered = currentEntries.some((entry) => entry.personenId === personenId);

  if (isRegistered) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-login";
    btn.textContent = "Austragen";
    btn.addEventListener("click", () => handleEntryRemove(btn));
    toolbar.appendChild(btn);
  } else if (active) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-login";
    btn.textContent = "Eintragen";
    btn.addEventListener("click", () => handleEntrySubmit(btn));
    toolbar.appendChild(btn);
  }
}

subscribeAuth(() => {
  if (entriesLoaded) initToolbar();
});

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await ready;
    await loadBewerbsName();
    await loadEntries();
    entriesLoaded = true;
    subscribeInvalidations(["entryList", "players", "bewerbe", "ranking"], async () => {
      await loadBewerbsName();
      await loadEntries();
    });
    signalMonitorReady();
  } catch (error) {
    console.error("Entrylist konnte nicht initialisiert werden:", error);
    signalMonitorFailed(error.code || "ENTRY_LIST_LOAD_FAILED");
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && entriesLoaded) initToolbar();
});
