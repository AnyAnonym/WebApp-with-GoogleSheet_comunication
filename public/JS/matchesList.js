import { functions } from "./SDK.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-functions.js";


// ----------------------------------------------------------------------------
// 🔹 Funktion: Matches aus Google Sheet (Cloud Function readMatchesList) abrufen
// ----------------------------------------------------------------------------
async function main() {
  try {
    console.log("⏳ Lade Matches‑Daten über Cloud Function ...");

    const readMatchesFn = httpsCallable(functions, "readMatchesList");
    const result = await readMatchesFn();

    if (!result.data?.values) {
      throw new Error("Backend lieferte keine gültigen Daten!");
    }

    const data = result.data.values;
    console.log("✅ Empfangene Matches vom Backend:", data);

    // Tabelle füllen
    const tbody = document.querySelector("#tbl tbody");
    tbody.innerHTML = "";

    // Falls erste Zeile Header enthält („Spieler A“, …)
    const startIndex =
      data[0][0]?.toLowerCase().includes("spieler") ||
      data[0][1]?.toLowerCase().includes("spieler")
        ? 1
        : 0;

    for (let i = startIndex; i < data.length; i++) {
      const [spielerA, spielerB, satz1, satz2, datum, platz] = data[i];

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${spielerA || ""}</td>
        <td>${spielerB || ""}</td>
        <td>${satz1 || ""}</td>
        <td>${satz2 || ""}</td>
        <td>${datum || ""}</td>
        <td>${platz || ""}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    console.error("❌ Fehler beim Laden der Matches‑Liste:", err);
    alert("Fehler beim Laden oder Anzeigen der Matches. Details siehe Konsole.");
  }
}


// Seite erst laden, dann Daten holen
window.addEventListener("load", main);


// ----------------------------------------------------------------------------
// 🔹 Funktion: Neues Match hinzufügen (Cloud Function addMatch)
// ----------------------------------------------------------------------------
const addMatchFn = httpsCallable(functions, "addMatch");

// Formular‑EventListener für das Hinzufügen neuer Matches
const addForm = document.querySelector("#addForm");
if (addForm) {
  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;

    const newMatch = {
      spielerA: form.spielerA.value.trim(),
      spielerB: form.spielerB.value.trim(),
      satz1: form.satz1.value.trim(),
      satz2: form.satz2.value.trim(),
      datum: form.datum.value.trim(),
      platz: form.platz.value.trim()
    };

    if (!newMatch.spielerA || !newMatch.spielerB) {
      alert("Bitte mindestens Spieler A und B eintragen.");
      return;
    }

    try {
      console.log("📤 Sende neues Match an Cloud Function ...", newMatch);
      const result = await addMatchFn(newMatch);
      console.log("✅ Erfolgreich hinzugefügt:", result.data);
      alert("Neues Match erfolgreich in Google Sheet gespeichert!");

      form.reset();   // Eingabefelder leeren
      await main();   // Tabelle neu laden
    } catch (err) {
      console.error("❌ Fehler beim Schreiben ins Sheet:", err);
      alert("Fehler beim Schreiben ins Google Sheet. Details siehe Konsole.");
    }
  });
} else {
  console.warn("⚠️ Kein Formular #addForm gefunden – Add‑Funktion deaktiviert.");
}