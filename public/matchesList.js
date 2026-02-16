const SHEET_ID = "1E1CYezDcScIBvH9ebjN0hOkvttTdA6PFIgYKDMaeE04";
const TAB_NAME = "matches";
const SHEET_URL = `https://opensheet.elk.sh/${SHEET_ID}/${TAB_NAME}`;

// 🔹 Hauptfunktion
async function main() {
  try {
    // 1️⃣ Daten vom Sheet abrufen
    const response = await fetch(SHEET_URL);
    if (!response.ok) throw new Error(`HTTP Fehler: ${response.status}`);
    const data = await response.json();
    console.log("Empfangene Matches:", data);

    // 2️⃣ Tabelle befüllen
    const tbody = document.querySelector("#tbl tbody");
    tbody.innerHTML = "";

    data.forEach((match, i) => {
      const tr = document.createElement("tr");

      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${match["Spieler A"] || ""}</td>
        <td>${match["Spieler B"] || ""}</td>
        <td>${match["Satz 1"] || ""}</td>
        <td>${match["Satz 2"] || ""}</td>
        <td>${match["Datum"] || ""}</td>
        <td>${match["Platz"] || ""}</td>
      `;

      tbody.appendChild(tr);
    });

  } catch (error) {
    console.error("Fehler beim Laden der Matches:", error);
    alert("Fehler beim Laden oder Anzeigen der Matches.");
  }
}

// Seite erst laden, dann Daten holen
window.addEventListener("load", main);