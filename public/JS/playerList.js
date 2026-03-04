import { functions } from "./SDK.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-functions.js";

// Hauptfunktion: holt die Daten über das Backend
async function main() {
  try {
    console.log("⏳ Spieler werden geladen...");

    // 1️⃣ Aufruf der Cloud Function
    const getPlayers = httpsCallable(functions, "readPlayersList");
    const result = await getPlayers();

    if (!result.data?.values) {
      throw new Error("Backend lieferte keine gültigen Daten!");
    }

    const data = result.data.values; // das Array aus deiner Function
    console.log("✅ Empfangenes JSON vom Backend:", data);

    // 2️⃣ Tabelle befüllen
    const tbody = document.querySelector("#tbl tbody");
    tbody.innerHTML = "";

    // optional: erste Zeile als Headertitel überspringen, falls vorhanden
    const startIndex = data[0][0] === "ID" || data[0][0] === "id" ? 1 : 0;

    for (let i = startIndex; i < data.length; i++) {
      const [id, firstName, lastName] = data[i];
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${id || i}</td>
        <td>${firstName || ""} ${lastName || ""}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    console.error("❌ Fehler beim Laden der Daten:", err);
    alert("Fehler beim Laden der Spielerliste. Details in der Konsole.");
  }
}

// Seite erst laden, dann Daten holen
window.addEventListener("load", main);

