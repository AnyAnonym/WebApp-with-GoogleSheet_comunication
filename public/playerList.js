// ✅ Google Sheet → JSON via OpenSheet
const SHEET_ID = "1E1CYezDcScIBvH9ebjN0hOkvttTdA6PFIgYKDMaeE04";
const TAB_NAME = "players";
const SHEET_URL = `https://opensheet.elk.sh/${SHEET_ID}/${TAB_NAME}`;

// 🔹 Hauptfunktion
async function main() {
  try {
    // 1️⃣ Daten vom Sheet abrufen
    const response = await fetch(SHEET_URL);
    if (!response.ok) {
      throw new Error(`HTTP Fehler: ${response.status}`);
    }
    const data = await response.json();
    console.log("Empfangenes JSON:", data);

    // 2️⃣ Tabelle befüllen
    const tbody = document.querySelector("#tbl tbody");
    tbody.innerHTML = "";

    data.forEach((p, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
      <td>${p.id || i + 1}</td>
      <td>${p.firstName || ""} ${p.lastName || ""}</td>
    `;
      tbody.appendChild(tr);
    });

  } 
      
  catch (error) {
      console.error("Fehler beim Laden der Daten:", error);
      alert("Fehler beim Laden oder Anzeigen der Spieler.");
  }
}

// Seite erst laden, dann Daten holen
window.addEventListener("load", main);