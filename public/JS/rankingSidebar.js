import { functions } from "./SDK.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-functions.js";

// 🔹 Die gleiche Cloud Function wie in rangliste.js
const readRankedPlayers = httpsCallable(functions, "readRankedPlayers");

/**
 * Lädt die Rangliste vom Backend
 */
async function loadRanking() {
  try {
    console.log("⏳ Rangliste (Sidebar) wird geladen...");
    const response = await readRankedPlayers();
    const { data } = response || {};

    if (!data?.success || !Array.isArray(data.rankedList)) {
      console.error("❌ Ungültige Daten erhalten:", data);
      return [];
    }

    console.log(`🏆 ${data.rankedList.length} Spieler empfangen (Sidebar)`);
    return data.rankedList;
  } catch (err) {
    console.error("❌ Fehler beim Laden der Sidebar-Rangliste:", err);
    return [];
  }
}

/**
 * Rendert genau 10 Plätze in der Sidebar.
 * Nicht belegte Plätze werden mit "-" gefüllt.
 */
async function renderTopRanking() {
  const listElement = document.getElementById("ranking-list");
  if (!listElement) {
    console.error("⚠️ Kein Element mit ID 'ranking-list' gefunden!");
    return;
  }

  const rankedList = await loadRanking();

  // Falls leer: trotzdem 10 Dummy-Zeilen anzeigen
  const filledList = Array.isArray(rankedList) ? [...rankedList] : [];

  // Sicherstellen, dass immer mindestens 10 Einträge existieren
  for (let r = filledList.length + 1; r <= 10; r++) {
    filledList.push({ rank: r, name: "-" });
  }

  // Nach Rang sortieren und nur die ersten 10 behalten
  filledList.sort((a, b) => a.rank - b.rank);
  const top10 = filledList.slice(0, 10);

  // HTML befüllen
  listElement.innerHTML = top10
    .map(
      (player) =>
        `<li><span class="player-name">${player.name}</span></li>`
    )
    .join("");

  console.log("✅ Sidebar-Top10 erfolgreich aktualisiert.");
}

// Automatisch beim Seitenlade‑Event ausführen
window.addEventListener("load", renderTopRanking);