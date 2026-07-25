import { createEndpoint } from "./dataClient.js";
import { callWithRetry, showLoadingOverlay, hideLoadingOverlay, showErrorOverlay } from "./loadingHelper.js";

window.addEventListener("load", main);

function parsePlayerId(raw) {
  const s = String(raw || "").trim();
  const wo = /\[w\.?o\.?\]/.test(s);
  const cleanId = s.replace(/\[w\.?o\.?\]/gi, "").trim();
  return { cleanId, special: wo ? "wo" : null };
}

function getRetTeam(sets) {
  for (const set of sets) {
    if (!set.includes("[ret]")) continue;
    const parts = set.split("-");
    if (parts[0] && parts[0].includes("[ret]")) return "team1";
    if (parts[1] && parts[1].includes("[ret]")) return "team2";
  }
  return null;
}

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

async function main() {
  const container = document.getElementById("matches-container");
  if (!container) return;
  container.innerHTML = "";
  showLoadingOverlay("Lade Matches...");

  try {
    const readMatchesList = createEndpoint("matches");
    const readPlayersList = createEndpoint("players");
    const readBewerbe = createEndpoint("bewerbe");

    const [matchesRes, playersRes, bewerbeRes] = await Promise.all([
      callWithRetry(readMatchesList),
      callWithRetry(readPlayersList),
      callWithRetry(readBewerbe),
    ]);

    if (!matchesRes.data?.success) throw new Error(matchesRes.data?.error || "Fehler beim Laden der Matches");
    if (!playersRes.data?.success) throw new Error(playersRes.data?.error || "Fehler beim Laden der Spieler");

    const matchesValues = matchesRes.data.values || [];
    const playersValues = playersRes.data.values || [];
    const bewerbeValues = bewerbeRes.data?.values || [];

    if (matchesValues.length < 2) {
      container.innerHTML = "<p>Keine Matches gefunden.</p>";
      return;
    }

    const playerHeader = playersValues[0].map((h) => h.trim().toLowerCase());
    const pIdIdx = playerHeader.indexOf("id");
    const pFnIdx = playerHeader.indexOf("vorname");
    const pLnIdx = playerHeader.indexOf("nachname");
    const playerMap = new Map();
    playersValues.slice(1).forEach((r) => {
      const id = r[pIdIdx];
      const name = `${r[pFnIdx] || ""} ${r[pLnIdx] || ""}`.trim();
      playerMap.set(id, name);
    });

    const bewerbMap = new Map();
    if (bewerbeValues.length > 1) {
      const bHeader = bewerbeValues[0].map((h) => h.trim().toLowerCase());
      const bIdIdx = bHeader.indexOf("id");
      const bBezIdx = bHeader.indexOf("bezeichnung");
      bewerbeValues.slice(1).forEach((r) => {
        const id = String(r[bIdIdx] || "").trim();
        if (id) bewerbMap.set(id, String(r[bBezIdx] || "").trim());
      });
    }

    const header = matchesValues[0].map((h) => h.trim().toLowerCase());
    const idx = (label) => header.findIndex((v) => v.includes(label));
    const i1 = idx("spieler1id");
    const i3 = idx("spieler3id");
    const i2 = idx("spieler2id");
    const i4 = idx("spieler4id");
    const ergebnisIdx = idx("ergebnis");
    const d = idx("matchdate");
    // gewinner wird nicht mehr verwendet (aus Ergebnis berechnet)
    const bewerbIdIdx = idx("bewerbid");
    const rasterIdx = idx("bewerbrunde");

    function dateToTs(raw) {
      if (!raw) return Infinity;
      const m = String(raw).trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
      if (!m) return Infinity;
      const [, yy, mm, dd, hh, mi] = m;
      const yyyy = parseInt(yy, 10) >= 50 ? 1900 + parseInt(yy) : 2000 + parseInt(yy);
      return new Date(yyyy, parseInt(mm) - 1, parseInt(dd), parseInt(hh), parseInt(mi)).getTime();
    }
    const now = Date.now();

    const matches = matchesValues.slice(1)
      .filter((row) => row && row[i1] && !/^BYE$/i.test(String(row[i1])) && !/^BYE$/i.test(String(row[i3])))
      .sort((a, b) => Math.abs(dateToTs(a[d]) - now) - Math.abs(dateToTs(b[d]) - now))
      .map((row) => {
        const pid1 = parsePlayerId(row[i1]);
        const pid2 = parsePlayerId(row[i2]);
        const pid3 = parsePlayerId(row[i3]);
        const pid4 = parsePlayerId(row[i4]);
        const ergebnisRaw = row[ergebnisIdx] || "";
        const sets = ergebnisRaw ? ergebnisRaw.split("/").map((s) => formatSetResult(s)) : [];
        const bewerbId = bewerbIdIdx !== -1 ? String(row[bewerbIdIdx] || "").trim() : "";
        const runde = rasterIdx !== -1 ? parseRunde(row[rasterIdx]) : "";

        return {
          date: parseSheetDate(row[d]),
          players: [
            playerMap.get(pid1.cleanId) || "---",
            playerMap.get(pid2.cleanId) || "---",
            playerMap.get(pid3.cleanId) || "---",
            playerMap.get(pid4.cleanId) || "---",
          ],
          playerIds: [
            pid1.cleanId,
            pid2.cleanId,
            pid3.cleanId,
            pid4.cleanId,
          ],
          playerSpecial: [
            pid1.special,
            pid2.special,
            pid3.special,
            pid4.special,
          ],
          winnerId: (() => {
            // Gewinner aus Ergebnis berechnen
            if (!ergebnisRaw) return "";
            const rawSets = ergebnisRaw.split("/").filter(Boolean);
            let wins1 = 0, wins2 = 0;
            rawSets.forEach((s) => {
              const clean = s.replace(/\(\d+\)/g, "").replace(/\[ret\]/gi, "").trim();
              const parts = clean.split("-").map(Number);
              if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                if (parts[0] > parts[1]) wins1++;
                else if (parts[1] > parts[0]) wins2++;
              }
            });
            if (wins1 > wins2) return pid1.cleanId;
            if (wins2 > wins1) return pid3.cleanId;
            return "";
          })(),
          sets,
          ergebnis: ergebnisRaw.split("/").map((s) => formatSetResult(s)).join("/"),
          bewerbName: bewerbMap.get(bewerbId) || "",
          runde,
        };
      });

    if (matches.length === 0) {
      container.innerHTML = "<p>Keine Matches gefunden.</p>";
      return;
    }

    const badgeHtml = (type) => {
      if (type === "wo") return ' <span class="badge badge-wo">w.o.</span>';
      if (type === "ret") return ' <span class="badge badge-wo">ret.</span>';
      return "";
    };

    container.innerHTML = matches.map((m) => {
      const [p1, p2, p3, p4] = m.players;
      const [id1, id2, id3, id4] = m.playerIds || [];
      const [spec1, spec2, spec3, spec4] = m.playerSpecial || [];
      const sets = [...(m.sets || []), "---", "---", "---"].slice(0, 3);

      const team1Won = m.winnerId && (m.winnerId === id1 || m.winnerId === id2);
      const team2Won = m.winnerId && (m.winnerId === id3 || m.winnerId === id4);

      const retTeam = m.sets ? getRetTeam(m.sets) : null;
      const ret1 = retTeam === "team1" ? "ret" : null;
      const ret2 = retTeam === "team2" ? "ret" : null;

      const metaParts = [m.bewerbName, m.runde].filter(Boolean).join(" | ");
      return `
        <div class="match-card">
          <div class="match-meta-row">
            <span class="match-date">${m.date}</span>
            ${metaParts ? `<div class="match-meta-right"><span class="badge-bewerb">${metaParts}</span></div>` : ""}
          </div>
          <div class="match-content">
            <div class="team${team1Won ? " team-winner" : ""}">
              <div class="player main">${p1}${badgeHtml(spec1 || ret1)}</div>
              <div class="player sub">${p2}${badgeHtml(spec2)}</div>
            </div>
            <div class="vs">vs.</div>
            <div class="team${team2Won ? " team-winner" : ""}">
              <div class="player main">${p3}${badgeHtml(spec3 || ret2)}</div>
              <div class="player sub">${p4}${badgeHtml(spec4)}</div>
            </div>
            <div class="sets">
              ${sets.map((s) => `<div class="set">${s.replace("[ret]", "")}</div>`).join("")}
            </div>
          </div>
        </div>
      `;
    }).join("");

    hideLoadingOverlay();
  } catch (err) {
    console.error("Fehler in main():", err);
    showErrorOverlay("Fehler beim Laden der Matches", main);
  }
}
