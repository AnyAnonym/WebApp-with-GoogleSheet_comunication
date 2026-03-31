import { functions } from "./SDK.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-functions.js";

window.addEventListener("load", main);

async function main() {
  const container = document.getElementById("matches-container");
  container.innerHTML = "<p>Lade Matches...</p>";

  try {
    const readFullMatches = httpsCallable(functions, "readFullMatches");
    const result = await readFullMatches();

    if (!result.data?.success) {
      throw new Error(result.data?.error || "Unbekannter Fehler");
    }

    const matches = result.data.matches || [];
    console.log("✅ Dynamische Matches:", matches);

    if (matches.length === 0) {
      container.innerHTML = "<p>Keine Matches gefunden.</p>";
      return;
    }

    // HTML-Struktur rendern
    container.innerHTML = matches
      .map((m) => {
        const [p1, p2, p3, p4] = m.players;
        const sets = [...(m.sets || []), "---", "---", "---"].slice(0, 3);

        return `
          <div class="match-card">
            <div class="match-date">${m.date}</div>
            <div class="match-content">
              <div class="team">
                <div class="player main">${p1}</div>
                <div class="player sub">${p2}</div>
              </div>
              <div class="vs">vs.</div>
              <div class="team">
                <div class="player main">${p3}</div>
                <div class="player sub">${p4}</div>
              </div>
              <div class="sets">
                ${sets.map((s) => `<div class="set">${s}</div>`).join("")}
              </div>
            </div>
          </div>
        `;
      })
      .join("");

  } catch (err) {
    console.error("❌ Fehler in main():", err);
    container.innerHTML = `<p style="color:red">Fehler beim Laden der Matches: ${err.message}</p>`;
  }
}
