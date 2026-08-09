import { createEndpoint, subscribeInvalidations } from "./dataClient.js";
import { callWithRetry, showLoadingOverlay, hideLoadingOverlay, showErrorOverlay } from "./loadingHelper.js";
import { signalMonitorReady, signalMonitorFailed } from "./monitorReady.js";
import { diagnostic } from "./diagnostics.js";

const readBewerbe = createEndpoint("bewerbe");
const readBewerbsart = createEndpoint("bewerbsart");
let competitionBoundaryTimer = null;

function scheduleCompetitionBoundary(competitions) {
  if (competitionBoundaryTimer) clearTimeout(competitionBoundaryTimer);
  competitionBoundaryTimer = null;
  const now = Date.now();
  const candidates = [];
  for (const competition of competitions) {
    for (const [field, endOfDay] of [["entrystart", false], ["entrydeadline", true], ["bewerbsbeginn", false], ["bewerbsende", true]]) {
      const value = parseSheetDate(competition[field], endOfDay)?.getTime();
      if (Number.isFinite(value) && value > now) candidates.push(value);
    }
  }
  const next = candidates.sort((left, right) => left - right)[0];
  if (!next) return;
  competitionBoundaryTimer = setTimeout(() => {
    competitionBoundaryTimer = null;
    loadBewerbe().catch(() => {});
  }, Math.min(2147483647, Math.max(1, next - now + 50)));
}

function parseSheetDate(raw, endOfDay = false) {
  if (!raw) return null;
  const rawStr = String(raw).trim();
  if (!rawStr) return null;

  // YYYYMMDD-HHMM
  const match8t = rawStr.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (match8t) {
    const [, yyyy, mm, dd, hh, mi] = match8t;
    return new Date(+yyyy, +mm - 1, +dd, +hh, +mi);
  }

  // YYYYMMDD
  const match8 = rawStr.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match8) {
    const [, yyyy, mm, dd] = match8;
    return new Date(+yyyy, +mm - 1, +dd, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  }

  // YYMMDD-HHMM
  const match6t = rawStr.match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (match6t) {
    const [, yy, mm, dd, hh, mi] = match6t;
    const yyyy = parseInt(yy, 10) >= 50 ? 1900 + +yy : 2000 + +yy;
    return new Date(yyyy, +mm - 1, +dd, +hh, +mi);
  }

  // YYMMDD
  const match6 = rawStr.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (match6) {
    const [, yy, mm, dd] = match6;
    const yyyy = parseInt(yy, 10) >= 50 ? 1900 + +yy : 2000 + +yy;
    return new Date(yyyy, +mm - 1, +dd, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  }

  return null;
}

function formatSheetDate(raw) {
  if (!raw) return "";
  const date = parseSheetDate(raw);
  if (!date) return String(raw).trim();

  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

// ── Bewerb Cards ────────────────────────────────────────────────────────

function createCard(b) {
  const card = document.createElement("div");
  const bewerbsartId = String(b.bewerbsartId).trim();
  const isRangliste = bewerbsartId === "2";
  const isRoundRobin = b.roundRobin === "1";

  card.className = "bewerb-card";

  if (isRangliste) {
    card.classList.add("clickable");
    card.addEventListener("click", () => {
      window.location.href = `rangliste.html?id=${encodeURIComponent(String(b.id))}`;
    });
  }

  const start = formatSheetDate(b.bewerbsbeginn);
  const end = b.bewerbsende ? formatSheetDate(b.bewerbsende) : "Offen";
  const entryStart = formatSheetDate(b.entrystart);
  const entryDeadline = formatSheetDate(b.entrydeadline);
  const hasEntryList = b.entryListAvailable === "1";

  const heading = document.createElement("h3");
  heading.textContent = String(b.bezeichnung || "");
  card.appendChild(heading);

  const dates = document.createElement("div");
  dates.className = `bewerb-dates${hasEntryList ? " with-entrylist" : ""}`;

  const appendDate = (label, value) => {
    const row = document.createElement("span");
    row.textContent = `${label}: ${value}`;
    dates.appendChild(row);
  };

  appendDate("Bewerbs Beginn", start || "---");
  if (hasEntryList) appendDate("Eintragungsliste Beginn", entryStart || "---");
  appendDate("Bewerbs Ende", end || "Offen");
  if (hasEntryList) appendDate("Eintragungsliste Ende", entryDeadline || "Offen");
  card.appendChild(dates);

  // Alle Bewerbe außer Rangliste: Klick-Logik
  if (!isRangliste) {
    const now = new Date();
    const deadline = parseSheetDate(b.entrydeadline, true);
    const isPastDeadline = deadline ? deadline < now : false;
    const entryStartDate = parseSheetDate(b.entrystart);
    const isBeforeEntryStart = entryStartDate ? entryStartDate > now : false;
    const bewerbStart = parseSheetDate(b.bewerbsbeginn);
    const hasStarted = bewerbStart ? bewerbStart <= now : false;

    // Zielseite bestimmen + Klickbarkeit
    let target = null;
    const isEntryOpen = !isBeforeEntryStart && !isPastDeadline && hasEntryList;

    if (hasStarted) {
      // Bewerb läuft oder beendet → zur Bewerbsseite (Ergebnisse ansehen)
      if (isRoundRobin) {
        target = `RoundRobin.html?id=${encodeURIComponent(String(b.id))}`;
      } else {
        target = `bewerbsRaster.html?id=${encodeURIComponent(String(b.id))}`;
      }
    } else if (isEntryOpen) {
      // Bewerb hat noch nicht begonnen, aber EntryList ist offen
      target = `entryList.html?id=${encodeURIComponent(String(b.id))}`;
    }

    if (target) {
      card.classList.add("clickable");
      card.addEventListener("click", () => {
        window.location.href = target;
      });
    }
  }

  return card;
}

function createGrid(id) {
  const grid = document.createElement("div");
  grid.className = "bewerb-grid";
  grid.id = id;
  return grid;
}

function createSection(title, gridId) {
  const section = document.createElement("div");
  section.className = "bewerb-section";

  const heading = document.createElement("h3");
  heading.className = "bewerb-section-title";
  heading.textContent = title;

  const grid = createGrid(gridId);

  section.appendChild(heading);
  section.appendChild(grid);

  return section;
}

function classifyBewerb(b, today) {
  const startRaw = String(b.bewerbsbeginn || "").trim();
  const endRaw = String(b.bewerbsende || "").trim();

  const startDate = parseSheetDate(startRaw);
  const endDate = parseSheetDate(endRaw, true);

  const started = startDate ? startDate <= today : false;
  const ended = endDate ? endDate < today : false;

  if (!startDate && !endDate) return "active";
  if (ended) return "finished";
  if (started && !ended) return "active";
  if (!started && !ended) return "upcoming";

  return "upcoming";
}

async function loadBewerbe() {
  const container = document.getElementById("bewerbe-container");
  if (!container) {
    const error = new Error("Bewerbe-Container fehlt.");
    error.code = "COMPETITIONS_CONTAINER_MISSING";
    throw error;
  }

  container.replaceChildren();
  showLoadingOverlay("Lade Bewerbe...");

  try {
    const [bewerbRes, bewerbsartRes] = await Promise.all([
      callWithRetry(readBewerbe),
      callWithRetry(readBewerbsart),
    ]);

    if (!bewerbRes.data?.success || !bewerbsartRes.data?.success) {
      const failedData = !bewerbRes.data?.success ? bewerbRes.data : bewerbsartRes.data;
      throw new Error(failedData?.error?.message || "Bewerbe konnten nicht geladen werden.");
    }

    const bewerbValues = bewerbRes.data?.values || [];
    const bewerbsartValues = bewerbsartRes.data?.values || [];

    if (bewerbValues.length < 2) {
      const message = document.createElement("p");
      message.textContent = "Keine Bewerbe gefunden.";
      container.appendChild(message);
      hideLoadingOverlay();
      return;
    }

    const baMap = new Map();
    if (bewerbsartValues.length > 1) {
      const baHeader = bewerbsartValues[0].map((h) => String(h || "").trim().toLowerCase());
      const baIdIdx = baHeader.indexOf("id");
      const baEntryIdx = baHeader.indexOf("entrylistavailable");
      const baBezIdx = baHeader.indexOf("bezeichnung");
      const baRRIdx = baHeader.indexOf("roundrobin");
      bewerbsartValues.slice(1).forEach((r) => {
        const id = String(r[baIdIdx] || "").trim();
        if (id) {
          baMap.set(id, {
            bezeichnung: String(r[baBezIdx] || "").trim(),
            entryListAvailable: baEntryIdx !== -1 ? String(r[baEntryIdx] || "0").trim() : "0",
            roundRobin: baRRIdx !== -1 ? String(r[baRRIdx] || "0").trim() : "0",
          });
        }
      });
    }

    const bHeader = bewerbValues[0].map((h) => String(h || "").trim().toLowerCase());
    const bIdIdx = bHeader.indexOf("id");
    const bBewerbsartIdx = bHeader.indexOf("bewerbsartid");
    const bBezIdx = bHeader.indexOf("bezeichnung");
    const bEntryStartIdx = bHeader.indexOf("entrystart");
    const bEntryDeadlineIdx = bHeader.indexOf("entrydeadline");
    const bStartIdx = bHeader.indexOf("bewerbsbeginn");
    const bEndIdx = bHeader.indexOf("bewerbsende");
    const bSortIdx = bHeader.indexOf("sortorder");

    const bewerbe = bewerbValues.slice(1).map((row) => {
      const bewerbsartId = String(row[bBewerbsartIdx] || "").trim();
      const baInfo = baMap.get(bewerbsartId) || {};
      const sortOrderRaw = bSortIdx >= 0 ? String(row[bSortIdx] || "").trim() : "";
      const sortOrder = sortOrderRaw !== "" ? parseInt(sortOrderRaw, 10) : Infinity;
      return {
        id: row[bIdIdx] || "",
        bewerbsartId,
        bezeichnung: row[bBezIdx] || "",
        entrystart: bEntryStartIdx !== -1 ? row[bEntryStartIdx] || "" : "",
        entrydeadline: bEntryDeadlineIdx !== -1 ? row[bEntryDeadlineIdx] || "" : "",
        bewerbsbeginn: row[bStartIdx] || "",
        bewerbsende: row[bEndIdx] || "",
        entryListAvailable: baInfo.entryListAvailable || "0",
        roundRobin: baInfo.roundRobin || "0",
        sortOrder,
      };
    });

    const filtered = bewerbe.filter((b) => String(b.id).trim() !== "1");
    scheduleCompetitionBoundary(filtered);

    const today = new Date();

    const active = [];
    const upcoming = [];
    const finished = [];

    filtered.forEach((b) => {
      const cat = classifyBewerb(b, today);
      if (cat === "active") active.push(b);
      else if (cat === "upcoming") upcoming.push(b);
      else if (cat === "finished") finished.push(b);
    });

    // Sortierung pro Kategorie
    function sortByOrder(a, b, datumField) {
      // 1. SortOrder: kleinste zuerst, Infinity (kein Wert) nach unten
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      // 2. Bei gleichem SortOrder (oder beide ohne): nach Datum
      const da = parseSheetDate(a[datumField]);
      const db = parseSheetDate(b[datumField]);
      const ta = da ? da.getTime() : Infinity;
      const tb = db ? db.getTime() : Infinity;
      return ta - tb;
    }

    active.sort((a, b) => sortByOrder(a, b, "bewerbsende"));
    upcoming.sort((a, b) => sortByOrder(a, b, "bewerbsbeginn"));
    finished.sort((a, b) => sortByOrder(a, b, "bewerbsende"));

    container.replaceChildren();

    if (active.length > 0) {
      const section = createSection("Aktive Bewerbe", "grid-active");
      container.appendChild(section);
      const grid = section.querySelector(".bewerb-grid");
      active.forEach((b) => {
        grid.appendChild(createCard(b));
      });
    }

    if (upcoming.length > 0) {
      const section = createSection("Bevorstehende Bewerbe", "grid-upcoming");
      container.appendChild(section);
      const grid = section.querySelector(".bewerb-grid");
      upcoming.forEach((b) => {
        grid.appendChild(createCard(b));
      });
    }

    if (finished.length > 0) {
      const section = createSection("Beendete Bewerbe", "grid-finished");
      container.appendChild(section);
      const grid = section.querySelector(".bewerb-grid");
      finished.forEach((b) => {
        grid.appendChild(createCard(b));
      });
    }

    if (active.length === 0 && upcoming.length === 0 && finished.length === 0) {
      const message = document.createElement("p");
      message.textContent = "Keine Bewerbe gefunden.";
      container.appendChild(message);
    }
    hideLoadingOverlay();
  } catch (err) {
    diagnostic.error("competitions_load_failed", err);
    showErrorOverlay("Fehler beim Laden der Bewerbe", () => {
      loadBewerbe().catch(() => {});
    });
    throw err;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadBewerbe();
    subscribeInvalidations(["bewerbe", "bewerbsart"], loadBewerbe);
    signalMonitorReady();
  } catch (error) {
    signalMonitorFailed(error.code || "COMPETITIONS_LOAD_FAILED");
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadBewerbe().catch(() => {});
});
