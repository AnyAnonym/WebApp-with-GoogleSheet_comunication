import { functions } from "./SDK.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-functions.js";

// 🔹 Cloud Functions
const readRankedPlayers = httpsCallable(functions, "readRankedPlayers");
const readPlayerDetails = httpsCallable(functions, "readPlayerDetails");

/**
 * Lädt die Rangliste aus dem Backend
 */
export async function loadRanking() {
  try {
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
 * Baut die Ranglisten-Pyramide und markiert forderbare Spieler automatisch
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

  // ---------------------------------------------------
  // Pyramide aufbauen
  // ---------------------------------------------------
  const pyramid = [];
  let current = 0;
  let level = 1;

  while (current < rankedList.length) {
    const playersRemaining = rankedList.length - current;
    const rowSize = Math.min(level, playersRemaining);

    const row = document.createElement("div");
    row.className = "row";
    row.style.justifyContent = "flex-start";
    row.style.gap = "20px";

    const rowBoxes = [];

    for (let i = 0; i < rowSize && current < rankedList.length; i++, current++) {
      const player = rankedList[current];
      const box = document.createElement("div");
      box.className = "box";
      box.textContent = `${player.rank} – ${player.name}`;
      row.appendChild(box);

      // Klick auf grüne Challengeable-Box öffnet das Match-Modal
      box.addEventListener("click", () => {
        if (!box.classList.contains("challengeable")) return;

        window.openMatchModal({
          player1: player.name || "",
          player1Id: player.playerId || "",
          player3: localStorage.getItem("currentUserName") || "",
          player3Id: localStorage.getItem("currentUserId") || "",
          datum: "",
          platz: "",
        });
      });

      rowBoxes.push({ rank: player.rank, playerId: player.playerId, name: player.name, box });
    }

    // visuelle Balance
    const expectedFullSize = level;
    if (rowSize < expectedFullSize) {
      for (let i = 0; i < expectedFullSize - rowSize; i++) {
        const placeholder = document.createElement("div");
        placeholder.className = "box";
        placeholder.style.visibility = "hidden";
        row.appendChild(placeholder);
      }
    }

    pyramid.push(rowBoxes);
    container.appendChild(row);
    level++;
  }

  // ---------------------------------------------------
  // Hilfsfunktionen
  // ---------------------------------------------------
  const clearHighlights = async () => {
    // 🔹 Markiert dich (blau) und deine forderbaren Spieler (grün)
    // Regel:
    // - Alle links in derselben Zeile
    // - Alle rechts (und inklusive gleicher Spalte) in der Zeile darüber
    // - Ausnahme: Rang 3 darf zusätzlich Rang 2 und 1 fordern
    const markChallengeables = (myRowIndex, myIndex) => {
      // 1️⃣ alte Hervorhebungen entfernen
      container.querySelectorAll(".box").forEach(b =>
        b.classList.remove("selected", "challengeable")
      );

      // 2️⃣ eigene Box blau
      const me = pyramid[myRowIndex]?.[myIndex];
      if (!me) return;
      me.box.classList.add("selected");
      const myRank = me.rank;

      // 3️⃣ gleiche Zeile – alle links grün
      if (Array.isArray(pyramid[myRowIndex])) {
        for (let i = 0; i < myIndex; i++) {
          const leftBox = pyramid[myRowIndex][i];
          if (leftBox?.box) {
            leftBox.box.classList.add("challengeable");
          }
        }
      }

      // 4️⃣ Reihe darüber – alle rechts über mir (einschließlich gleicher Spalte)
      const rowAbove = pyramid[myRowIndex - 1];
      if (Array.isArray(rowAbove)) {
        for (let j = myIndex; j < rowAbove.length; j++) {
          const rightBox = rowAbove[j];
          if (rightBox?.box) {
            rightBox.box.classList.add("challengeable");
          }
        }
      }

      // 5️⃣ Sonderregel: Rang 3 darf Rang 2 und 1 fordern
      if (myRank === 3) {
        const flat = pyramid.flat();
        const rank2 = flat.find(p => p.rank === 2);
        const rank1 = flat.find(p => p.rank === 1);
        if (rank2?.box) rank2.box.classList.add("challengeable");
        if (rank1?.box) rank1.box.classList.add("challengeable");
      }

      console.log(`✅ Markierungen gesetzt für Rang ${myRank}`);
    };



    // ---------------------------------------------------
    // Aktuellen Benutzer finden
    // ---------------------------------------------------
    try {
      const currentUserEmail =
        localStorage.getItem("currentUserEmail") ||
        localStorage.getItem("loggedInEmail");

      if (!currentUserEmail) {
        console.warn("⚠ Kein Benutzer eingeloggt – keine Markierung.");
        return;
      }

      console.log("🔍 Suche deinen Rang anhand deiner E-Mail:", currentUserEmail);
      const response = await readPlayerDetails();
      const { success, players } = response.data || {};

      if (!success || !Array.isArray(players)) {
        console.error("❌ Spieler-Liste konnte nicht geladen werden.");
        return;
      }

      const mePlayer = players.find(
        p => p.email.trim().toLowerCase() === currentUserEmail.trim().toLowerCase()
      );

      if (!mePlayer) {
        console.warn("⚠ Kein Spieler mit dieser E-Mail gefunden.");
        return;
      }

      const myFullName = mePlayer.fullName.trim().toLowerCase();
      const myEntry = rankedList.find(
        p => p.name.trim().toLowerCase() === myFullName
      );

      if (!myEntry) {
        console.warn(`⚠ Kein Rang gefunden für ${myFullName}`);
        return;
      }

      // Speichere eigene User-ID zur Verwendung im Matchmodal
      if (myEntry.playerId) {
        localStorage.setItem("currentUserId", myEntry.playerId);
      }

      const myRank = myEntry.rank;

      // Finde meine Position (Zeile und Spalte)
      let foundRow = -1;
      let foundIndex = -1;

      for (let r = 0; r < pyramid.length; r++) {
        const idx = pyramid[r].findIndex(p => p.rank === myRank);
        if (idx !== -1) {
          foundRow = r;
          foundIndex = idx;
          break;
        }
      }

      if (foundRow !== -1) {
        console.log(`🙋 Du bist Rang ${myRank}: ${myEntry.name}`);
        markChallengeables(foundRow, foundIndex);
      } else {
        console.warn("⚠ Deine Position in der Pyramide wurde nicht gefunden.");
      }
    } catch (err) {
      console.error("❌ Fehler bei der automatischen Markierung:", err);
    }
  };

  // Call the clearHighlights function
  clearHighlights();
}