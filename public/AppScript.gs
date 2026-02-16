const url = "https://docs.google.com/spreadsheets/d/1E1CYezDcScIBvH9ebjN0hOkvttTdA6PFIgYKDMaeE04/";
const spreadsheet = SpreadsheetApp.openByUrl(url);
const sheet = spreadsheet.getSheetByName("players");


function arrayToJson(arr) {
  const [headers, ...rows] = arr;
  return rows.map(row => {
    const obj = {};
    headers.forEach((header, i) => (obj[header] = row[i]));
    return obj;
  });
}


function getAllPlayers() {
  const data = sheet.getDataRange().getValues(); // Holt alle Daten (2D-Array)
  const players = arrayToJson(data);             // Wandelt in Objekte um
  return players;
}


function getAllPlayerNames() {
  const lastRow = sheet.getLastRow();
  const data = sheet.getRange(2, 2, lastRow - 1, 2).getValues(); // Spalten B & C (Vorname + Nachname)
  
  const names = data
    .filter(row => row[0] && row[1]) // Leere Zeilen ignorieren
    .map(row => `${row[0]} ${row[1]}`);
  
  return names.join(", ");
}


function doGet(e) {
  const players = getAllPlayers();
  return ContentService
    .createTextOutput(JSON.stringify(players))
    .setMimeType(ContentService.MimeType.JSON)
    .setHeader("Access-Control-Allow-Origin", "*");
}


function callAllFunctions() {
  const players = getAllPlayers();
  const names = getAllPlayerNames();

  console.log("Alle Spieler (als Objekte):", players);
  console.log(players[1].id);
  console.log("Spielernamen (String):", names);
}