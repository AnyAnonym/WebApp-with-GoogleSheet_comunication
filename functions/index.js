/* eslint-disable max-len */
// 🔹 index.js (ES Module Syntax)
// Hinweis: funktioniert nur, weil in package.json =>  "type": "module"
import {onCall} from "firebase-functions/v2/https";
import {google} from "googleapis";

const SHEET_ID = "1E1CYezDcScIBvH9ebjN0hOkvttTdA6PFIgYKDMaeE04";

// 🔹 Testfunktion
export const sayHello = onCall(() => {
  return "Hello World!";
});

/**
 * Liest die komplette "players"-Tabelle aus Google Sheets.
 */
export const readPlayersList = onCall(async () => {
  try {
    console.log("🔄 Initializing Google Sheets client...");
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({version: "v4", auth});

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "players",
    });

    return {success: true, values: res.data.values || []};
  } catch (err) {
    console.error("❌ Error reading Google Sheet:", err);
    return {success: false, error: err.message};
  }
});

/**
 * Liest die "matches"-Tabelle aus Google Sheets.
 */
export const readMatchesList = onCall(async () => {
  try {
    console.log("🔄 Initializing Google Sheets client...");
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({version: "v4", auth});

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "matches",
    });

    return {success: true, values: res.data.values || []};
  } catch (err) {
    console.error("❌ Error reading Google Sheet:", err);
    return {success: false, error: err.message};
  }
});

/**
 * Fügt ein Match in die "matches"-Tabelle ein.
 */
export const addMatch = onCall(async (request) => {
  try {
    const {spielerA, spielerB, satz1, satz2, datum, platz} = request.data;

    // Sheets-Client mit Schreibrechten
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({version: "v4", auth});

    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "matches!A:F",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[spielerA, spielerB, satz1, satz2, datum, platz]],
      },
    });

    console.log("✅ Match gespeichert:", res.data.updates);
    return {success: true, updates: res.data.updates};
  } catch (err) {
    console.error("❌ Google Sheets Schreibfehler:", err);
    throw new Error(`Sheets API Fehler: ${err.message}`);
  }
});

/**
 * Baut die Rangliste aus den Tabs "rankedPlayers" und "players" zusammen.
 * - "rankedPlayers" enthält Spalten: Rang | PlayerID
 * - "players" enthält Spalten: id | firstName | lastName
 */

export const readRankedPlayers = onCall(async () => {
  console.log("✅ readRankedPlayers gestartet...");

  try {
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({version: "v4", auth});

    // --- Tabellen abrufen ---
    const rankedRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "rankedPlayers",
    });
    const playersRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "players",
    });

    const rankedValues = rankedRes.data.values || [];
    const playersValues = playersRes.data.values || [];

    if (rankedValues.length < 2 || playersValues.length < 2) {
      console.warn("⚠️ Tabellen leer oder unvollständig");
      return {success: false, error: "Leere Tabellen"};
    }

    // --- Headerzeilen analysieren ---
    const rankedHeader = rankedValues[0].map((h) => h.trim().toLowerCase());
    const playersHeader = playersValues[0].map((h) => h.trim().toLowerCase());

    const rankIndex = rankedHeader.indexOf("rang");
    const playerIdIndex = rankedHeader.indexOf("playerid");
    const idIndex = playersHeader.indexOf("id");
    const firstNameIndex = playersHeader.indexOf("firstname");
    const lastNameIndex = playersHeader.indexOf("lastname");

    if (
      rankIndex === -1 ||
      playerIdIndex === -1 ||
      idIndex === -1 ||
      firstNameIndex === -1 ||
      lastNameIndex === -1
    ) {
      throw new Error("❌ Spalten nicht gefunden – bitte Header überprüfen");
    }

    // --- PlayerID → Vollname‑Map ---
    const playerMap = new Map();
    for (let i = 1; i < playersValues.length; i++) {
      const row = playersValues[i];
      const id = row[idIndex];
      const first = row[firstNameIndex] || "";
      const last = row[lastNameIndex] || "";
      const fullName = `${first.trim()} ${last.trim()}`.trim();
      playerMap.set(id, fullName);
    }

    // --- Rangliste kombinieren ---
    const rankedList = rankedValues.slice(1).map((row) => {
      const rank = Number(row[rankIndex]);
      const playerId = row[playerIdIndex];
      const name = playerMap.get(playerId) || "Unbekannt";
      return {rank, name};
    });

    // optional: nach Rang sortieren
    rankedList.sort((a, b) => a.rank - b.rank);

    console.log("🏁 Fertige Liste:", rankedList);

    return {success: true, rankedList};
  } catch (err) {
    console.error("❌ Fehler in readRankedPlayers:", err);
    return {success: false, error: err.message};
  }
});

