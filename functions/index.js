// 🔹 index.js  (ES Module Syntax)
// Beachte: funktioniert nur, weil in package.json =>  "type": "module"

import {onCall} from "firebase-functions/v2/https";
import {google} from "googleapis";

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
      spreadsheetId: "1E1CYezDcScIBvH9ebjN0hOkvttTdA6PFIgYKDMaeE04",
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
      spreadsheetId: "1E1CYezDcScIBvH9ebjN0hOkvttTdA6PFIgYKDMaeE04",
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
