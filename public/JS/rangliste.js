import { functions } from "./SDK.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-functions.js";

// 🔹 Deine Cloud Function aus index.js aufrufen
const readRankedPlayers = httpsCallable(functions, "readRankedPlayers");

/**
 * Lädt die Rangliste aus dem Backend
 */
export async function loadRanking() {
  try {
    console.log("⏳ Rangliste wird geladen...");
    const response = await readRankedPlayers();
    const { data } = response || {};

    if (!data?.success || !Array.isArray(data.rankedList)) {
      console.error("❌ Keine gültigen Daten:", data);
      return [];
    }

    console.log(`🏆 ${data.rankedList.length} Spieler geladen`);
    return data.rankedList;
  } catch (err) {
    console.error("❌ Fehler beim Laden der Rangliste:", err);
    return [];
  }
}

/**
 * Baut eine dynamische Pyramide anhand des Rangs:
 * - Rang 1 oben in der Mitte
 * - Rang 2–3 darunter
 * - Rang 4–6 darunter usw.
 */
export async function renderRanking() {
  const container = document.getElementById("rankingContainer");
  if (!container) return;

  const rankedList = await loadRanking();
  container.innerHTML = "";

  if (!rankedList.length) {
    container.innerHTML = "<p>Keine Spieler gefunden.</p>";
    return;
  }

  rankedList.sort((a, b) => a.rank - b.rank);

  const total = rankedList.length;
  let current = 0;
  let level = 1;

  while (current < total) {
    const playersRemaining = total - current;
    const rowSize = level <= playersRemaining ? level : playersRemaining;

    const row = document.createElement("div");
    row.className = "row";
    // 🔹 Immer linksbündig, nicht center:
    row.style.justifyContent = "flex-start";
    row.style.gap = "20px";

    for (let i = 0; i < rowSize && current < total; i++, current++) {
      const player = rankedList[current];
      const box = document.createElement("div");
      box.className = "box";
      box.textContent = `${player.rank} – ${player.name}`;
      row.appendChild(box);
    }

    // 🔹 Falls das die letzte unvollständige Reihe ist: 
    //    füge "leeren Platz" rechts hinzu, damit sie visuell pyramidenförmig bleibt
    const expectedFullSize = level;
    if (rowSize < expectedFullSize) {
      const missing = expectedFullSize - rowSize;
      for (let i = 0; i < missing; i++) {
        const empty = document.createElement("div");
        empty.className = "box";
        empty.style.visibility = "hidden"; // Platzhalter – unsichtbar
        row.appendChild(empty);
      }
    }

    container.appendChild(row);
    level++;
  }
}



