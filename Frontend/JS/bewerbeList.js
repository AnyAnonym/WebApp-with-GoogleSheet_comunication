import { createEndpoint, subscribeInvalidations } from "./dataClient.js";
import { ready, subscribeAuth } from "./authClient.js";
import { callWithRetry, showLoadingOverlay, hideLoadingOverlay, showErrorOverlay } from "./loadingHelper.js";
import { signalMonitorReady, signalMonitorFailed } from "./monitorReady.js";
import { diagnostic } from "./diagnostics.js";

const readBewerbe = createEndpoint("bewerbe");
const readBewerbsart = createEndpoint("bewerbsart");
const readCompetitionHistory = createEndpoint("competitionHistory");
const ADMIN_RANKING_HISTORY_TYPES = new Set([
  "ranking_challenge_deleted",
  "ranking_challenge_date_changed",
  "ranking_match_date_admin_changed",
]);
let competitionBoundaryTimer = null;
let bewerbeLoadPromise = null;
let bewerbeLoadedOnce = false;
let historyButtonsVisible = false;
let historyAuthIdentity = null;
let historyRequestGeneration = 0;
const historyState = {
  open: false,
  global: false,
  bewerbId: null,
  competitionName: "",
  entries: [],
  nextCursor: null,
  loading: false,
  returnFocus: null,
};

function historyElement(id) {
  return document.getElementById(id);
}

function setHistoryButtonsVisible(visible) {
  historyButtonsVisible = visible;
  document.querySelectorAll(".competition-history-button").forEach((button) => {
    button.hidden = !visible;
  });
}

function clearHistoryState() {
  historyRequestGeneration++;
  historyState.open = false;
  historyState.global = false;
  historyState.bewerbId = null;
  historyState.competitionName = "";
  historyState.entries = [];
  historyState.nextCursor = null;
  historyState.loading = false;
  historyElement("competition-history-list")?.replaceChildren();
  if (historyElement("competition-history-title")) historyElement("competition-history-title").textContent = "Historie";
  if (historyElement("competition-history-competition-name")) historyElement("competition-history-competition-name").textContent = "";
  if (historyElement("competition-history-status")) historyElement("competition-history-status").textContent = "";
  if (historyElement("competition-history-more")) {
    historyElement("competition-history-more").textContent = "Weitere Einträge laden";
    historyElement("competition-history-more").hidden = true;
  }
}

function closeCompetitionHistory({ restoreFocus = true } = {}) {
  const modal = historyElement("competition-history-modal");
  if (!modal || modal.hidden) {
    clearHistoryState();
    return;
  }
  const returnFocus = historyState.returnFocus;
  modal.hidden = true;
  clearHistoryState();
  historyState.returnFocus = null;
  if (!document.querySelector('.modal:not(.hidden), .competition-history-modal:not([hidden])')) {
    document.body.classList.remove("modal-open");
  }
  if (restoreFocus && returnFocus?.isConnected && !returnFocus.hidden) returnFocus.focus();
}

function historyTimestamp(entry) {
  return entry?.occurredAt ?? entry?.timestamp ?? entry?.createdAt ?? entry?.date ?? "";
}

function historyTimeValue(entry) {
  const value = historyTimestamp(entry);
  const numeric = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatHistoryTimestamp(value) {
  if (value === "" || value === null || value === undefined) return "Zeitpunkt unbekannt";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("de-AT", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function historyEntries(data) {
  const values = data?.entries ?? data?.history ?? data?.events ?? data?.items;
  return Array.isArray(values) ? values : [];
}

function appendHistoryText(container, text, className) {
  if (text === "" || text === null || text === undefined) return;
  const line = document.createElement("p");
  line.className = className;
  line.textContent = String(text);
  container.appendChild(line);
}

function renderCompetitionHistory() {
  const list = historyElement("competition-history-list");
  const status = historyElement("competition-history-status");
  const more = historyElement("competition-history-more");
  if (!list || !status || !more) return;

  list.replaceChildren();
  const sortedEntries = [...historyState.entries].sort((left, right) => historyTimeValue(right) - historyTimeValue(left));
  for (const entry of sortedEntries) {
    const item = document.createElement("li");
    item.className = "competition-history-entry";
    const time = document.createElement("time");
    const rawTimestamp = historyTimestamp(entry);
    const parsedTimestamp = new Date(rawTimestamp);
    if (!Number.isNaN(parsedTimestamp.getTime())) time.dateTime = parsedTimestamp.toISOString();
    time.textContent = formatHistoryTimestamp(rawTimestamp);
    item.appendChild(time);

    const roundName = String(entry?.roundName || "").trim();
    if (historyState.global) {
      const competitionName = entry?.competitionName ?? entry?.competition?.name ?? entry?.bewerbName;
      const competition = document.createElement("p");
      competition.className = "competition-history-entry-competition";
      competition.textContent = String(competitionName || "Bewerb unbekannt");
      if (roundName) {
        const round = document.createElement("span");
        round.className = "competition-history-entry-round";
        round.textContent = ` - ${roundName}`;
        competition.appendChild(round);
      }
      item.appendChild(competition);
    } else {
      appendHistoryText(item, roundName, "competition-history-entry-round");
    }
    const title = entry?.summary ?? entry?.label ?? entry?.action ?? entry?.type ?? entry?.event;
    appendHistoryText(item, title || "Änderung", "competition-history-entry-title");
    if (ADMIN_RANKING_HISTORY_TYPES.has(entry?.type)) {
      appendHistoryText(item, entry?.detail, "competition-history-entry-detail");
    }
    appendHistoryText(item, entry?.result ? `Ergebnis: ${entry.result}` : "", "competition-history-entry-result");
    const actor = entry?.actorName ?? entry?.actor;
    appendHistoryText(item, actor ? `Eingetragen durch: ${actor}` : "", "competition-history-entry-meta");
    list.appendChild(item);
  }

  status.textContent = historyState.entries.length ? "" : "Keine Historieneinträge vorhanden.";
  more.textContent = "Weitere Einträge laden";
  more.disabled = historyState.loading;
  more.hidden = !historyState.nextCursor;
}

async function loadCompetitionHistory({ append = false } = {}) {
  if (!historyState.open || historyState.loading || !historyButtonsVisible) return;
  const generation = ++historyRequestGeneration;
  const status = historyElement("competition-history-status");
  const more = historyElement("competition-history-more");
  historyState.loading = true;
  if (status) status.textContent = append ? "Weitere Einträge werden geladen..." : "Historie wird geladen...";
  if (more) more.disabled = true;

  try {
    const params = historyState.global ? {} : { bewerbId: historyState.bewerbId };
    if (append && historyState.nextCursor) params.cursor = historyState.nextCursor;
    const response = await readCompetitionHistory(params);
    if (generation !== historyRequestGeneration || !historyState.open || !historyButtonsVisible) return;
    if (!response.data?.success) throw new Error(response.data?.error?.message || "Historie konnte nicht geladen werden.");
    const entries = historyEntries(response.data);
    const authoritativeName = String(response.data.competition?.name || "").trim();
    if (!historyState.global && authoritativeName) {
      historyState.competitionName = authoritativeName;
      historyElement("competition-history-competition-name").textContent = authoritativeName;
    }
    historyState.entries = append ? [...historyState.entries, ...entries] : entries;
    historyState.nextCursor = response.data.nextCursor || null;
    renderCompetitionHistory();
  } catch (error) {
    if (generation !== historyRequestGeneration) return;
    diagnostic.error("competition_history_load_failed", error);
    if (status) status.textContent = "Historie konnte nicht geladen werden. Bitte erneut versuchen.";
    if (more) {
      more.hidden = false;
      more.textContent = append ? "Weitere Einträge erneut laden" : "Erneut versuchen";
    }
  } finally {
    if (generation === historyRequestGeneration) {
      historyState.loading = false;
      if (more) more.disabled = false;
    }
  }
}

function openCompetitionHistory(competition, button) {
  if (!historyButtonsVisible) return;
  clearHistoryState();
  historyState.open = true;
  historyState.global = !competition;
  historyState.bewerbId = competition ? String(competition.id) : null;
  historyState.competitionName = competition ? String(competition.bezeichnung || "Bewerb") : "Alle Bewerbe";
  historyState.returnFocus = button;
  historyElement("competition-history-title").textContent = "Historie";
  historyElement("competition-history-competition-name").textContent = historyState.competitionName;
  const modal = historyElement("competition-history-modal");
  modal.hidden = false;
  document.body.classList.add("modal-open");
  historyElement("competition-history-close")?.focus();
  loadCompetitionHistory().catch(() => {});
}

function initializeCompetitionHistory() {
  const modal = historyElement("competition-history-modal");
  const globalButton = historyElement("all-competition-history-button");
  globalButton?.appendChild(createHistoryIcon());
  globalButton?.addEventListener("click", () => openCompetitionHistory(null, globalButton));
  historyElement("competition-history-close")?.addEventListener("click", () => closeCompetitionHistory());
  historyElement("competition-history-more")?.addEventListener("click", () => loadCompetitionHistory({
    append: Boolean(historyState.entries.length && historyState.nextCursor),
  }));
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) closeCompetitionHistory();
  });
  document.addEventListener("keydown", (event) => {
    if (!modal || modal.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeCompetitionHistory();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...modal.querySelectorAll("button:not([hidden]):not(:disabled)")];
    if (!focusable.length) return;
    const index = focusable.indexOf(document.activeElement);
    const nextIndex = event.shiftKey
      ? (index <= 0 ? focusable.length - 1 : index - 1)
      : (index < 0 || index === focusable.length - 1 ? 0 : index + 1);
    event.preventDefault();
    focusable[nextIndex].focus();
  });

  subscribeAuth((user, state) => {
    const identity = state.status === "authenticated" && user ? String(user.id || user.login || "authenticated") : null;
    if (historyAuthIdentity !== null && historyAuthIdentity !== identity) closeCompetitionHistory({ restoreFocus: false });
    historyAuthIdentity = identity;
    setHistoryButtonsVisible(Boolean(identity));
  });
  ready.catch(() => setHistoryButtonsVisible(false));
}

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

function createHistoryIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.dataset.icon = "megaphone";
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const pathData of [
    "M3 10v4a2 2 0 0 0 2 2h2L20 20V4L7 8H5a2 2 0 0 0-2 2Z",
    "m7 16 2 5h4l-2.4-3.8",
  ]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    svg.appendChild(path);
  }
  return svg;
}

// ── Bewerb Cards ────────────────────────────────────────────────────────

function createCard(b) {
  const card = document.createElement("div");
  const bewerbsartId = String(b.bewerbsartId).trim();
  const isRangliste = bewerbsartId === "2";
  const isRoundRobin = b.roundRobin === "1";

  card.className = "bewerb-card";

  let target = isRangliste ? `rangliste.html?id=${encodeURIComponent(String(b.id))}` : null;

  const start = formatSheetDate(b.bewerbsbeginn);
  const end = b.bewerbsende ? formatSheetDate(b.bewerbsende) : "Offen";
  const entryStart = formatSheetDate(b.entrystart);
  const entryDeadline = formatSheetDate(b.entrydeadline);
  const hasEntryList = b.entryListAvailable === "1";

  const headingRow = document.createElement("div");
  headingRow.className = "bewerb-heading";
  const heading = document.createElement("h3");
  heading.textContent = String(b.bezeichnung || "");
  const historyButton = document.createElement("button");
  historyButton.type = "button";
  historyButton.className = "competition-history-button";
  historyButton.setAttribute("aria-label", `Historie von ${String(b.bezeichnung || "Bewerb")} öffnen`);
  historyButton.title = "Bewerbshistorie öffnen";
  historyButton.appendChild(createHistoryIcon());
  historyButton.hidden = !historyButtonsVisible;
  historyButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openCompetitionHistory(b, historyButton);
  });
  headingRow.append(heading, historyButton);
  card.appendChild(headingRow);

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

  }

  if (target) {
    card.classList.add("clickable");
    const link = document.createElement("a");
    link.className = "bewerb-card-link";
    link.href = target;
    link.setAttribute("aria-label", `${String(b.bezeichnung || "Bewerb")} öffnen`);
    card.appendChild(link);
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
  const preserveContent = bewerbeLoadedOnce;
  if (bewerbeLoadPromise) return bewerbeLoadPromise;

  bewerbeLoadPromise = (async () => {
  const container = document.getElementById("bewerbe-container");
  if (!container) {
    const error = new Error("Bewerbe-Container fehlt.");
    error.code = "COMPETITIONS_CONTAINER_MISSING";
    throw error;
  }

  if (!preserveContent) {
    container.replaceChildren();
    showLoadingOverlay("Lade Bewerbe...");
  }

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
      if (preserveContent) return true;
      const message = document.createElement("p");
      message.textContent = "Keine Bewerbe gefunden.";
      container.appendChild(message);
      hideLoadingOverlay();
      bewerbeLoadedOnce = true;
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
    bewerbeLoadedOnce = true;
    if (!preserveContent) hideLoadingOverlay();
  } catch (err) {
    diagnostic.error("competitions_load_failed", err);
    if (!preserveContent) {
      showErrorOverlay("Fehler beim Laden der Bewerbe", () => {
        loadBewerbe().catch(() => {});
      });
    }
    throw err;
  } finally {
    bewerbeLoadPromise = null;
  }
  })();

  return bewerbeLoadPromise;
}

document.addEventListener("DOMContentLoaded", async () => {
  initializeCompetitionHistory();
  try {
    await loadBewerbe();
    subscribeInvalidations(["bewerbe", "bewerbsart"], () => loadBewerbe());
    signalMonitorReady();
  } catch (error) {
    signalMonitorFailed(error.code || "COMPETITIONS_LOAD_FAILED");
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadBewerbe().catch(() => {});
});
