// 🔹 index.js  (ES Module Syntax)
// Beachte: funktioniert nur, weil in package.json =>  "type": "module"
import {onCall} from "firebase-functions/v2/https";
import {google} from "googleapis";
const SHEET_ID = "1E1CYezDcScIBvH9ebjN0hOkvttTdA6PFIgYKDMaeE04";

// Lazy init (erst beim ersten Funktionsaufruf)
let sheets;

export const sayHello = onCall(() => {
  return "Hello World!";
});

export const readPlayersList = onCall(async () => {
  try {
    if (!sheets) {
      console.log("🔄 Initializing Google Sheets client...");
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
      });
      sheets = google.sheets({version: "v4", auth});
    }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "players",
    });

    return {
      success: true,
      values: res.data.values || [],
    };
  } catch (err) {
    console.error("❌ Error reading Google Sheet:", err);
    return {success: false, error: err.message};
  }
});

export const readMatchesList = onCall(async () => {
  try {
    if (!sheets) {
      console.log("🔄 Initializing Google Sheets client...");
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
      });
      sheets = google.sheets({version: "v4", auth});
    }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "matches",
    });

    return {
      success: true,
      values: res.data.values || [],
    };
  } catch (err) {
    console.error("❌ Error reading Google Sheet:", err);
    return {success: false, error: err.message};
  }
});

// ✅ Cloud Function schreibt neue Matches
export const addMatch = onCall(async (request) => {
  try {
    const {spielerA, spielerB, satz1, satz2, datum, platz} = request.data;

    // 🔹 Auth-Setup (Service-Account)
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({version: "v4", auth});

    // 🔹 Zeile anhängen
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
