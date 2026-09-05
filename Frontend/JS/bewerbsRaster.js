import { createEndpoint, subscribeInvalidations } from "./dataClient.js";
import { getUser, ready, subscribeAuth } from "./authClient.js";
import { callWithRetry, showLoadingOverlay, hideLoadingOverlay, showErrorOverlay } from "./loadingHelper.js";
import { signalMonitorReady, signalMonitorFailed } from "./monitorReady.js";

// preMatches endpoint beibehalten für Kompatibilität, wird aber nicht mehr verwendet
// const readPreMatches   = createEndpoint("preMatches");
const readMatchesList  = createEndpoint("matches");
const readPlayersList  = createEndpoint("players");
const readBewerbe      = createEndpoint("bewerbe");
const readBewerbsart   = createEndpoint("bewerbsart");

const params = new URLSearchParams(window.location.search);
const BEWERB_ID = params.get("id");
const PAIRING_LAYOUT = params.get("paarungslayout") || "0";
let activeView = "bracket";
let refreshRoundRobinView = null;
let roundRobinModule = null;

const ROUND_DISPLAY = {
  R1: "1. Runde", R2: "2. Runde", R3: "3. Runde",
  AF: "Achtelfinale", VF: "Viertelfinale", HF: "Halbfinale", F: "Finale",
};

function parsePlayerId(raw) {
  const s = String(raw || "").trim();
  const wo = s.endsWith("[wo]");
  const ret = s.endsWith("[ret]");
  const gesetzt = /\[gesetzt\]/i.test(s);
  let cleanId = (wo ? s.slice(0, -4) : ret ? s.slice(0, -5) : s).replace(/\[gesetzt\]/gi, "").trim();
  const pre = /^PRE$/i.test(cleanId);
  return { cleanId, special: wo ? "wo" : ret ? "ret" : null, pre, gesetzt };
}

function createBadge(type) {
  const badge = document.createElement("span");
  if (type === "wo") {
    badge.className = "badge badge-wo";
    badge.textContent = "wo";
    return badge;
  }
  if (type === "ret") {
    badge.className = "badge badge-wo";
    badge.textContent = "ret";
    return badge;
  }
  if (type === "gesetzt") {
    badge.className = "badge badge-gesetzt";
    badge.textContent = "gesetzt";
    return badge;
  }
  return null;
}

function appendPlayerName(container, playerId, name, canOpenProfile) {
  const knownPlayer = playerId && name && playerMap.has(playerId);
  if (knownPlayer && canOpenProfile) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bracket-player-name";
    button.dataset.playerId = playerId;
    button.textContent = name;
    button.setAttribute("aria-label", `Profil von ${name} öffnen`);
    button.addEventListener("click", () => window.openProfileModal?.({ playerId }));
    container.appendChild(button);
    return;
  }
  const text = document.createElement("span");
  text.className = "bracket-player-name";
  text.textContent = name || "—";
  container.appendChild(text);
}

function createPlayerNames(slot, canOpenProfile) {
  const names = document.createElement("span");
  names.className = "pname";
  appendPlayerName(names, slot.id, slot.name, canOpenProfile);
  if (slot.partnerName) {
    const separator = document.createElement("span");
    separator.className = "bracket-player-separator";
    separator.setAttribute("aria-hidden", "true");
    separator.textContent = " / ";
    names.appendChild(separator);
    appendPlayerName(names, slot.partnerId, slot.partnerName, canOpenProfile);
  }
  return names;
}

function renderMessage(container, message) {
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  container.replaceChildren(paragraph);
}

function parseRaster(val) {
  if (!val) return null;
  const s = String(val).trim().toUpperCase();
  if (!s) return null;
  if (s === "F") return { roundKey: "F", match: 1 };
  const m = s.match(/^(R[1-9]|AF|VF|HF)-P(\d+)$/);
  if (!m) return null;
  return { roundKey: m[1], match: parseInt(m[2], 10) };
}

function parseResult(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (!s) return null;
  const parts = s.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  const sets = parts.map((p) => {
    if (/\[ret\]/.test(p)) {
      const sc = p.split("-");
      const retOnLeft = sc[0] && sc[0].includes("[ret]");
      return { left: 0, right: 0, special: "ret", retOnLeft };
    }
    const sc = p.split("-");
    if (sc.length !== 2) return null;
    const a = parseInt(sc[0], 10);
    const b = parseInt(sc[1], 10);
    if (isNaN(a) || isNaN(b)) return null;
    return { left: a, right: b };
  });
  if (sets.some((s) => s === null)) return null;
  return sets;
}

function formatMatchDate(raw) {
  if (!raw) return "";
  const value = String(raw).trim();
  const match = value.match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!match) return value;
  const [, year, month, day, hour, minute] = match;
  const fullYear = parseInt(year, 10) >= 50 ? `19${year}` : `20${year}`;
  return `${day}.${month}.${fullYear} - ${hour}:${minute}`;
}

function buildRounds(matchData, matchHeader, playerMap, r1CountConfigPlayers) {
  const slotMap = {};

  const h = matchHeader.map((c) => String(c).trim().toLowerCase());
  const bwIdx = h.indexOf("bewerbid");
  const p1Idx = h.indexOf("spieler1id");
  const p2Idx = h.indexOf("spieler2id");
  const p3Idx = h.indexOf("spieler3id");
  const p4Idx = h.indexOf("spieler4id");
  const rtIdx = h.indexOf("bewerbrunde");
  const ergebnisIdx = h.indexOf("ergebnis");
  const matchDateIdx = h.indexOf("matchdate");

  matchData.forEach((row) => {
    if (bwIdx >= 0 && String(row[bwIdx] || "").trim() !== String(BEWERB_ID).trim()) return;
    const p = parseRaster(rtIdx >= 0 ? String(row[rtIdx] || "").trim() : "");
    if (!p) return;
    const key = p.roundKey + "-" + p.match;

    const pid1 = parsePlayerId(row[p1Idx]);
    const pid2 = p2Idx >= 0 ? parsePlayerId(row[p2Idx]) : { cleanId: "", special: null, pre: false, gesetzt: false };
    const pid3 = parsePlayerId(row[p3Idx]);
    const pid4 = p4Idx >= 0 ? parsePlayerId(row[p4Idx]) : { cleanId: "", special: null, pre: false, gesetzt: false };

    const rawResult = ergebnisIdx >= 0 ? String(row[ergebnisIdx] || "").trim() : "";
    const hasResult = !!rawResult;

    const entry = {
      top: { id: pid1.cleanId, partnerId: pid2.cleanId, name: null, partnerName: null, special: pid1.special || pid2.special, pre: pid1.pre, gesetzt: pid1.gesetzt },
      bottom: { id: pid3.cleanId, partnerId: pid4.cleanId, name: null, partnerName: null, special: pid3.special || pid4.special, pre: pid3.pre, gesetzt: pid3.gesetzt },
      result: null,
      rawResult,
      completionType: pid1.special || pid2.special || pid3.special || pid4.special,
      losingSide: pid1.special || pid2.special ? "top" : pid3.special || pid4.special ? "bottom" : null,
      winner: null,
      matchDate: formatMatchDate(matchDateIdx >= 0 ? row[matchDateIdx] : ""),
    };

    if (hasResult) {
      entry.result = parseResult(rawResult);
      entry.winner = "";
      if (entry.result) {
        let setsTop = 0, setsBot = 0;
        entry.result.forEach((s) => {
          if (s.special === "ret") { if (s.retOnLeft) setsBot++; else setsTop++; }
          else if (s.left > s.right) setsTop++;
          else if (s.right > s.left) setsBot++;
        });
        if (setsTop > setsBot) entry.winner = pid1.cleanId;
        else if (setsBot > setsTop) entry.winner = pid3.cleanId;
      }
    }
    // [wo]/[ret]-Logik: wer wo/ret gibt, verliert (auch ohne Ergebnis)
    if (!entry.winner) {
      if (pid1.special || pid2.special) entry.winner = pid3.cleanId;
      else if (pid3.special || pid4.special) entry.winner = pid1.cleanId;
    }
    // BYE-Logik: Spieler gegen BYE gewinnt automatisch
    if (!entry.winner) {
      if (/^BYE$/i.test(pid1.cleanId) && pid3.cleanId) entry.winner = pid3.cleanId;
      else if (/^BYE$/i.test(pid3.cleanId) && pid1.cleanId) entry.winner = pid1.cleanId;
    }

    // Preserve gesetzt from existing entry if not set in this row
    const existing = slotMap[key];
    if (existing) {
      if (!pid1.gesetzt && existing.top.gesetzt) entry.top.gesetzt = true;
      if (!pid3.gesetzt && existing.bottom.gesetzt) entry.bottom.gesetzt = true;
    }

    const hasSpecial = !!(pid1.special || pid2.special || pid3.special || pid4.special || /^BYE$/i.test(pid1.cleanId) || /^BYE$/i.test(pid3.cleanId));
    if (!existing || hasResult || hasSpecial) {
      slotMap[key] = entry;
    }
  });

  Object.values(slotMap).forEach((e) => {
    const resolve = (id) => /^BYE$/i.test(id) ? "BYE" : /^PRE$/i.test(id) ? null : (playerMap.get(id) || null);
    if (e.top.id) e.top.name = resolve(e.top.id);
    if (e.top.partnerId) e.top.partnerName = resolve(e.top.partnerId);
    if (e.bottom.id) e.bottom.name = resolve(e.bottom.id);
    if (e.bottom.partnerId) e.bottom.partnerName = resolve(e.bottom.partnerId);
  });

  let r1Count = 0;
  for (const key of Object.keys(slotMap)) {
    const m = key.match(/^R1-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > r1Count) r1Count = n;
    }
  }

  if (r1CountConfigPlayers < 2) return [];

  const effCount = Math.floor(r1CountConfigPlayers / 2);

  // Halving sequence: [32,16,8,4,2,1] for 64er, [16,8,4,2,1] for 32er
  const seq = [effCount];
  while (seq[seq.length - 1] > 1) seq.push(Math.ceil(seq[seq.length - 1] / 2));

  const n = seq.length;
  const roundDefs = [];

  // Number of fixed-named rounds at the end: up to 4 (AF, VF, HF, F)
  const fixedCount = Math.min(n, 4);
  const rCount = n - fixedCount; // R rounds before the fixed block

  // R rounds (R1, R2, ...)
  for (let i = 0; i < rCount; i++) {
    const rNum = i + 1;
    roundDefs.push({
      label: ROUND_DISPLAY["R" + rNum] || "R" + rNum + ". Runde",
      count: seq[i],
      keyPfx: "R" + rNum,
    });
  }

  // Fixed rounds: mapped from the end — F, HF, VF, AF
  const FIXED = ["AF", "VF", "HF", "F"];
  const fixedOffset = 4 - fixedCount; // how many fixed names to skip from the left
  for (let i = 0; i < fixedCount; i++) {
    const keyPfx = FIXED[fixedOffset + i];
    roundDefs.push({
      label: ROUND_DISPLAY[keyPfx] || keyPfx,
      count: seq[rCount + i],
      keyPfx,
    });
  }

  const result = roundDefs.map((rd) => {
    const matches = [];
    for (let m = 1; m <= rd.count; m++) {
      const key = rd.keyPfx + "-" + m;
      const sm = slotMap[key];
      matches.push({
        matchNum: m,
        _key: key,
        top: sm ? sm.top : { id: "", name: null },
        bottom: sm ? sm.bottom : { id: "", name: null },
        result: sm ? sm.result : null,
        rawResult: sm ? sm.rawResult : "",
        completionType: sm ? sm.completionType : null,
        losingSide: sm ? sm.losingSide : null,
        winner: sm ? sm.winner : null,
        matchDate: sm ? sm.matchDate : "",
      });
    }
    return { roundName: rd.label, matches };
  });
  return result;
}

function addConnectors(grid, rounds) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "bracket-lines");
  grid.appendChild(svg);

  const matchEls = grid.querySelectorAll(".bracket-match");
  const byCol = {};
  matchEls.forEach((el) => {
    const col = parseInt(el.style.gridColumn, 10);
    if (!byCol[col]) byCol[col] = [];
    byCol[col].push(el);
  });

  for (let col = 1; col < rounds.length; col++) {
    const left = byCol[col];
    const right = byCol[col + 1];
    if (!left || !right) continue;

    left.sort((a, b) => parseInt(a.style.gridRow, 10) - parseInt(b.style.gridRow, 10));
    right.sort((a, b) => parseInt(a.style.gridRow, 10) - parseInt(b.style.gridRow, 10));

    for (let i = 0; i < left.length; i += 2) {
      const topEl = left[i];
      const botEl = left[i + 1];
      const nextEl = right[Math.floor(i / 2)];
      if (!topEl || !botEl || !nextEl) continue;

      const gRect = grid.getBoundingClientRect();
      const tRect = topEl.getBoundingClientRect();
      const bRect = botEl.getBoundingClientRect();
      const nRect = nextEl.getBoundingClientRect();

      const x1 = tRect.right - gRect.left;
      const y1 = tRect.top + tRect.height / 2 - gRect.top;
      const x2 = bRect.right - gRect.left;
      const y2 = bRect.top + bRect.height / 2 - gRect.top;
      const x3 = nRect.left - gRect.left;
      const y3 = nRect.top + nRect.height / 2 - gRect.top;

      const midX = (x1 + x3) / 2;
      const midY = (y1 + y2) / 2;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const d = [
        `M ${x1} ${y1}`,
        `L ${midX} ${y1}`,
        `L ${midX} ${y2}`,
        `L ${x2} ${y2}`,
        `M ${midX} ${midY}`,
        `L ${x3} ${midY}`,
      ].join(" ");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
  }
}

function renderBracket(rounds) {
  const container = document.getElementById("bracketContainer");
  if (!container) return;
  container.replaceChildren();

  if (!rounds || rounds.length === 0) {
    renderMessage(container, "Keine Rasterdaten für diesen Bewerb.");
    return;
  }

  const numRounds = rounds.length;
  const currentUserId = String(getUser()?.id || "");
  const canOpenProfile = Boolean(currentUserId);
  const r1Count = rounds[0].matches.length;
  const gridRows = r1Count * 2;
  const dateToMatchGap = 4;
  const matchToPreviousMatchGap = 12;
  let gridRowHeight = 28;
  const columnGap = 56;

  const bracketDiv = document.createElement("div");
  bracketDiv.className = "bracket";

  const stage = document.createElement("div");
  stage.className = "bracket-stage";

  const columnBands = document.createElement("div");
  columnBands.className = "bracket-column-bands";
  columnBands.style.setProperty("--cols", numRounds);
  rounds.forEach(() => {
    const band = document.createElement("div");
    band.className = "bracket-column-band";
    columnBands.appendChild(band);
  });
  stage.appendChild(columnBands);

  const headerRow = document.createElement("div");
  headerRow.className = "bracket-header-row";
  headerRow.style.setProperty("--cols", numRounds);
  rounds.forEach((r) => {
    const h = document.createElement("div");
    h.className = "bracket-round-header";
    h.textContent = r.roundName;
    headerRow.appendChild(h);
  });
  stage.appendChild(headerRow);

  const grid = document.createElement("div");
  grid.className = "bracket-grid";
  grid.style.setProperty("--cols", numRounds);
  grid.style.setProperty("--rows", gridRows);
  grid.style.setProperty("--row-height", `${gridRowHeight}px`);
  grid.style.height = (gridRows * gridRowHeight) + "px";

  rounds.forEach((round, rIdx) => {
    round.matches.forEach((match, mIdx) => {
      const row = (1 + 2 * mIdx) * Math.pow(2, rIdx);

      const md = document.createElement("div");
      md.className = "bracket-match";
      md.dataset.roundIndex = rIdx;
      md.style.gridColumn = rIdx + 1;
      md.style.gridRow = row;
      match._el = md;

      if (match.result || match.winner) md.classList.add("has-result");

      const date = document.createElement("div");
      date.className = "bracket-match-date";
      date.textContent = match.matchDate || "\u00a0";
      if (!match.matchDate) date.setAttribute("aria-hidden", "true");
      md.appendChild(date);

      const matchBox = document.createElement("div");
      matchBox.className = "bracket-match-box";

      [match.top, match.bottom].forEach((slot, sIdx) => {
        const el = document.createElement("div");
        el.className = "bracket-player";
        slot._el = el;
        slot._side = sIdx === 0 ? "left" : "right";
        if (slot.pre) el.classList.add("blink-green");

        const slotId = slot.id;
        const isWinner = match.winner && slotId && match.winner === slotId;

        if (isWinner) el.classList.add("winner");
        if (currentUserId && (slotId === currentUserId || slot.partnerId === currentUserId)) {
          el.classList.add("current-user");
        }

        if (match.result && slot.name) {
          const hasRet = match.result.some((s) => s.special && (slot._side === "left" ? s.retOnLeft : !s.retOnLeft));
          const name = createPlayerNames(slot, canOpenProfile);
          [hasRet ? "ret" : null, slot.special, slot.gesetzt ? "gesetzt" : null].forEach((type) => {
            const badge = createBadge(type);
            if (badge) name.append(" ", badge);
          });

          const result = document.createElement("span");
          result.className = "player-result";
          match.result.forEach((set, setIdx) => {
            const value = document.createElement("span");
            value.className = "set-result";
            if (String(set.left).length > 1 || String(set.right).length > 1) {
              value.classList.add("two-digit");
            }
            value.textContent = slot._side === "left" ? set.left : set.right;
            result.appendChild(value);
            if (setIdx < match.result.length - 1) {
              const separator = document.createElement("span");
              separator.className = "set-result-separator";
              separator.textContent = "|";
              result.appendChild(separator);
            }
          });
          el.append(name, " ", result);
        } else {
          const name = createPlayerNames(slot, canOpenProfile);
          [slot.special, slot.gesetzt ? "gesetzt" : null].forEach((type) => {
            const badge = createBadge(type);
            if (badge) name.append(" ", badge);
          });
          el.appendChild(name);
          if (!slot.name && !slot.special) el.classList.add("bye");
        }

        matchBox.appendChild(el);
      });

      if (match.completionType && match.losingSide) {
        const losingSlot = match[match.losingSide];
        const losingTeam = [losingSlot.name, losingSlot.partnerName].filter(Boolean).join(" / ");
        if (losingTeam) {
          const completion = document.createElement("div");
          completion.className = "bracket-completion";
          completion.textContent = match.completionType === "wo"
            ? `Walkover durch ${losingTeam}`
            : `Aufgabe durch ${losingTeam}${match.rawResult ? `: ${match.rawResult}` : ""}`;
          matchBox.appendChild(completion);
        }
      }

      md.appendChild(matchBox);
      grid.appendChild(md);
    });
  });

  stage.appendChild(grid);
  bracketDiv.appendChild(stage);
  container.appendChild(bracketDiv);

  // Spaltenbreite dynamisch berechnen basierend auf Inhalt
  requestAnimationFrame(() => {
    const matchBoxes = grid.querySelectorAll(".bracket-match-box");
    let maxMatchHeight = 0;
    let maxDateHeight = 0;

    matchBoxes.forEach((box) => {
      const h = box.getBoundingClientRect().height;
      if (h > maxMatchHeight) maxMatchHeight = h;
    });

    const matchDates = grid.querySelectorAll(".bracket-match-date");
    matchDates.forEach((date) => {
      const h = date.getBoundingClientRect().height;
      if (h > maxDateHeight) maxDateHeight = h;
    });

    if (maxMatchHeight > 0) {
      const additionalDateGap = matchDates.length > 0
        ? maxDateHeight + dateToMatchGap + matchToPreviousMatchGap
        : 0;
      gridRowHeight = Math.max(1, Math.ceil((maxMatchHeight + additionalDateGap) / 2));
      grid.style.setProperty("--row-height", `${gridRowHeight}px`);
      grid.style.height = `${gridRows * gridRowHeight}px`;
    }

    const padding = 28; // 14px padding links + 14px rechts
    const minGap = 12;  // Mindestabstand zwischen Name und Ergebnis

    const columnWidths = rounds.map((_, roundIndex) => {
      let maxNameWidth = 0;
      let maxResultWidth = 0;
      const matches = grid.querySelectorAll(`.bracket-match[data-round-index="${roundIndex}"]`);

      matches.forEach((matchEl) => {
        matchEl.querySelectorAll(".bracket-player").forEach((el) => {
          const nameEl = el.querySelector(".pname");
          const resultEl = el.querySelector(".player-result");
          if (nameEl) maxNameWidth = Math.max(maxNameWidth, nameEl.scrollWidth);
          if (resultEl) maxResultWidth = Math.max(maxResultWidth, resultEl.scrollWidth);
          if (!nameEl && !resultEl) maxNameWidth = Math.max(maxNameWidth, el.scrollWidth);
        });
      });

      const resultGap = maxResultWidth > 0 ? minGap : 0;
      const width = Math.max(200, Math.min(maxNameWidth + maxResultWidth + padding + resultGap, 600));
      matches.forEach((matchEl) => {
        matchEl.style.width = `${width}px`;
      });
      return width;
    });

    const columnTemplate = columnWidths.map((width) => `${width}px`).join(" ");
    headerRow.style.gridTemplateColumns = columnTemplate;
    grid.style.gridTemplateColumns = columnTemplate;

    const bandTemplate = columnWidths.map((width, index) => {
      if (columnWidths.length === 1) return width;
      if (index === 0 || index === columnWidths.length - 1) return width + columnGap / 2;
      return width + columnGap;
    }).map((width) => `${width}px`).join(" ");
    columnBands.style.gridTemplateColumns = bandTemplate;

    // Connectors erst nach Breitenberechnung zeichnen
    requestAnimationFrame(() => {
      const gridRect = grid.getBoundingClientRect();
      let contentBottom = 0;
      grid.querySelectorAll(".bracket-match-box").forEach((box) => {
        contentBottom = Math.max(contentBottom, box.getBoundingClientRect().bottom - gridRect.top);
      });
      grid.style.height = `${Math.max(gridRows * gridRowHeight, Math.ceil(contentBottom) + 8)}px`;
      addConnectors(grid, rounds);
    });
  });
}

let playerMap = new Map();

async function loadBracket() {
  const container = document.getElementById("bracketContainer");

  if (!BEWERB_ID) {
    if (container) renderMessage(container, "Bitte eine Bewerb-ID angeben.");
    return false;
  }

  if (!container) return false;
  container.replaceChildren();
  showLoadingOverlay("Lade Turnierraster...");

  try {
    const [bewerbRes, bewbsRes, matchRes, playerRes] = await Promise.all([
      callWithRetry(readBewerbe),
      callWithRetry(readBewerbsart),
      callWithRetry(readMatchesList),
      callWithRetry(readPlayersList),
    ]);
    if (activeView !== "bracket") return true;

    const bewerbValues = bewerbRes.data?.values || [];
    const bewbsValues = bewbsRes.data?.values || [];
    const matchValues = matchRes.data?.values || [];
    const playerValues = playerRes.data?.values || [];

    let r1CountConfigPlayers = 16;
    let bewerbName = "";
    let isRoundRobin = false;
    if (bewerbValues.length > 1 && bewbsValues.length > 1) {
      const bh = bewerbValues[0].map((h) => String(h).trim().toLowerCase());
      const bIdIdx = bh.indexOf("id");
      const bBewbsIdx = bh.indexOf("bewerbsartid");
      const bBezIdx = bh.indexOf("bezeichnung");
      const bewerbRow = bewerbValues.slice(1).find(
        (r) => String(r[bIdIdx] || "").trim() === String(BEWERB_ID).trim());
      if (bewerbRow && bBewbsIdx !== -1) {
        const bewbsId = String(bewerbRow[bBewbsIdx] || "").trim();
        if (bBezIdx !== -1) bewerbName = String(bewerbRow[bBezIdx] || "").trim();
        const ash = bewbsValues[0].map((h) => String(h).trim().toLowerCase());
        const aIdIdx = ash.indexOf("id");
        const aRastIdx = ash.indexOf("rasterfunktion");
        const aRoundRobinIdx = ash.indexOf("roundrobin");
        if (aIdIdx !== -1 && aRastIdx !== -1) {
          const artRow = bewbsValues.slice(1).find(
            (r) => String(r[aIdIdx] || "").trim() === bewbsId);
          if (artRow && artRow[aRastIdx]) {
            const parsed = parseInt(artRow[aRastIdx], 10);
            if (!isNaN(parsed) && parsed >= 2) r1CountConfigPlayers = parsed;
          }
          if (artRow && aRoundRobinIdx !== -1) {
            isRoundRobin = String(artRow[aRoundRobinIdx] || "0").trim() === "1";
          }
        }
      }
    }

    const heading = document.getElementById("bracketHeading");
    const info = document.getElementById("bracketInfo");

    function setHeading(text) {
      if (heading) heading.textContent = text;
    }
    setHeading("Turnierraster - " + (bewerbName || "Bewerb"));

    playerMap = new Map();
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

    const matchHeader = matchValues[0] || [];
    const matchData = matchValues.slice(1);

    const rounds = buildRounds(matchData, matchHeader, playerMap, r1CountConfigPlayers);

    if (rounds.length === 0) {
      renderMessage(container, "Keine Rasterdaten für diesen Bewerb.");
      hideLoadingOverlay();
      return true;
    }

    renderBracket(rounds);

    if (isRoundRobin && info) {
      info.replaceChildren();
      const btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex;gap:12px;margin-bottom:16px;";

      const btnRaster = document.createElement("button");
      btnRaster.className = "btn-action";
      btnRaster.textContent = "Raster";
      btnRaster.addEventListener("click", async () => {
        activeView = "bracket";
        refreshRoundRobinView = null;
        roundRobinModule?.invalidateRoundRobinRender?.();
        await loadBracket();
      });

      const btnGruppe = document.createElement("button");
      btnGruppe.className = "btn-action";
      btnGruppe.textContent = "Gruppe";
      btnGruppe.addEventListener("click", async () => {
        activeView = "round-robin";
        setHeading("Round Robin - " + (bewerbName || "Bewerb"));
        try {
          const mod = await import("./RoundRobin.js?v=3");
          if (activeView !== "round-robin") return;
          roundRobinModule = mod;
          if (mod.renderRoundRobin) {
            refreshRoundRobinView = async () => {
              container.replaceChildren();
              await mod.renderRoundRobin(BEWERB_ID, container, PAIRING_LAYOUT);
            };
            await refreshRoundRobinView();
          }
        } catch {
          renderMessage(container, "Fehler beim Laden der Gruppen-Ansicht.");
        }
      });

      btnRow.appendChild(btnRaster);
      btnRow.appendChild(btnGruppe);
      info.appendChild(btnRow);
    }

    hideLoadingOverlay();
    return true;
  } catch {
    showErrorOverlay("Fehler beim Laden des Turnierrasters", loadBracket);
    return false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await ready;
    const rendered = await loadBracket();
    if (rendered) signalMonitorReady();
    else signalMonitorFailed();
    subscribeInvalidations(["matches", "players", "bewerbe", "bewerbsart"], () => (
      activeView === "round-robin" && refreshRoundRobinView
        ? refreshRoundRobinView()
        : loadBracket()
    ));
    let observedUserId = String(getUser()?.id || "");
    subscribeAuth((user) => {
      const nextUserId = String(user?.id || "");
      if (nextUserId === observedUserId) return;
      observedUserId = nextUserId;
      void (activeView === "round-robin" && refreshRoundRobinView
        ? refreshRoundRobinView()
        : loadBracket());
    });
  } catch {
    signalMonitorFailed();
    showErrorOverlay("Fehler beim Laden des Turnierrasters");
  }
});
