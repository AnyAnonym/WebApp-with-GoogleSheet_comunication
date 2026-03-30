/* eslint-disable max-len */
// 🔹 index.js (ES Module Syntax)
// Hinweis: funktioniert nur, weil in package.json =>  "type": "module"
import {onCall} from "firebase-functions/v2/https";
import {google} from "googleapis";
// import fs from "fs";

// const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

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
 * Fügt einen neuen Spieler in die "players"-Tabelle ein,
 * verhindert doppelte Registrierung anhand der E-Mail.
 * Erwartet in req.data:
 * {
 *   firstName: "Kilian",
 *   lastName: "Pimminger",
 *   email: "kilian@example.com",
 *   hash: "abc123..."
 * }
 */
export const upsertData = onCall(async (req) => {
  try {
    const {firstName, lastName, email, hash} = req.data;

    if (!firstName || !lastName || !email || !hash) {
      throw new Error("❌ firstName, lastName, email oder hash fehlen in req.data");
    }

    console.log("🧩 upsertData gestartet:", {firstName, lastName, email});

    // 🔹 Google Sheets Auth (Compute Service‑Account)
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const authClient = await auth.getClient();
    const sheets = google.sheets({version: "v4", auth: authClient});

    // 1️⃣ Alle Spieler holen (für E-Mail‑Prüfung)
    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "players!A:E",
    });

    const rows = getRes.data.values || [];
    if (rows.length < 2) {
      console.warn("⚠️ Tabelle enthält keine Daten außer Header.");
    }

    // Header finden
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const emailIndex = header.indexOf("email");
    const idIndex = header.indexOf("id");

    if (emailIndex === -1 || idIndex === -1) {
      throw new Error("❌ Spalten 'id' oder 'email' fehlen im Sheet‑Header");
    }

    // 2️⃣ Prüfen, ob E‑Mail schon existiert
    const emailExists = rows.some(
        (row, i) =>
          i > 0 &&
        row[emailIndex] &&
        row[emailIndex].trim().toLowerCase() === email.trim().toLowerCase(),
    );

    if (emailExists) {
      console.warn(`⚠️ E‑Mail ${email} ist bereits registriert.`);
      return {
        success: false,
        error: "Diese E‑Mail ist bereits registriert.",
      };
    }

    // 3️⃣ Neue ID bestimmen (nur numerische IDs)
    const numericIds = rows
        .slice(1)
        .map((r) => parseInt(r[idIndex], 10))
        .filter((n) => !isNaN(n) && n > 0);

    const lastId = numericIds.length > 0 ? Math.max(...numericIds) : 0;
    const newId = lastId + 1;

    // 4️⃣ Neue Zeile erstellen
    const newRow = [newId, firstName, lastName, email, hash];

    // 5️⃣ Anhängen
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "players!A1:E",
      valueInputOption: "USER_ENTERED",
      requestBody: {values: [newRow]},
    });

    console.log(`✅ Spieler gespeichert: ID ${newId} (${email})`);
    return {success: true, inserted: newRow};
  } catch (err) {
    console.error("❌ Fehler in upsertData:", err);
    return {success: false, error: err.message};
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

/**
 * Vergleicht einen Passwort-Hash aus dem Frontend mit dem gespeicherten Hash im Google Sheet
 * Suchkriterium: E-Mail
 * Tabelle: "users" mit Spalten [email, passwordHash]
 */
export const verifyUserLogin = onCall(async (request) => {
  try {
    const {email, passwordHash} = request.data;
    if (!email || !passwordHash) {
      throw new Error("E-Mail oder Passwort-Hash fehlt.");
    }

    console.log("🔍 Login-Überprüfung gestartet für:", email);

    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({version: "v4", auth});

    // Daten aus TAB "users" oder alternativ "players"
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "players", // ⚠️ ändere ggf. auf "players", wenn du dort E-Mail & Hash speicherst
    });

    const rows = res.data.values || [];
    if (rows.length < 2) {
      throw new Error("❌ Tabelle enthält keine Benutzerdaten.");
    }

    // Header analysieren
    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const emailIndex = headers.indexOf("email");
    const hashIndex = headers.indexOf("passwdhash"); // ← angepasst

    if (emailIndex === -1 || hashIndex === -1) {
      return res.status(500).json({
        success: false,
        message: "Spalten 'email' oder 'passwdHash' fehlen.",
      });
    }

    // Benutzerzeile suchen
    const userRow = rows.find(
        (row, i) =>
          i > 0 &&
        row[emailIndex] &&
        row[emailIndex].trim().toLowerCase() === email.trim().toLowerCase(),
    );

    if (!userRow) {
      console.warn("⚠️ Keine E-Mail gefunden:", email);
      return {success: false, message: "E-Mail nicht gefunden."};
    }

    const storedHash =
      userRow && userRow[hashIndex] ? userRow[hashIndex].trim() : "";
    const match = storedHash === passwordHash;

    console.log(match ? "✅ Hash passt!" : "❌ Hash stimmt nicht überein.");
    return {success: true, valid: match};
  } catch (err) {
    console.error("❌ Fehler in verifyUserLogin:", err);
    return {success: false, error: err.message};
  }
});

/**
 * Liest aus der "players"-Tabelle: Voller Name, E-Mail, Geburtsdatum
 */
export const readPlayerDetails = onCall(async () => {
  try {
    console.log("🔄 Lade Spieler-Details...");

    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({version: "v4", auth});

    // Google Sheet abrufen
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "players",
    });

    const values = res.data.values || [];
    if (values.length < 2) {
      throw new Error("❌ Keine Spielerdaten gefunden.");
    }

    // --- Header verarbeiten ---
    const header = values[0].map((h) => h.trim().toLowerCase());
    const firstNameIndex = header.indexOf("firstname");
    const lastNameIndex = header.indexOf("lastname");
    const emailIndex = header.indexOf("email");
    const birthIndex = header.indexOf("geburtsdatum");

    if (
      firstNameIndex === -1 ||
      lastNameIndex === -1 ||
      emailIndex === -1 ||
      birthIndex === -1
    ) {
      throw new Error(
          "❌ Eine oder mehrere Spalten fehlen (firstname, lastname, email, GeburtsDatum)",
      );
    }

    // --- Spieler durchgehen ---
    const players = values.slice(1).map((row) => {
      const first = row[firstNameIndex] || "";
      const last = row[lastNameIndex] || "";
      const fullName = `${first.trim()} ${last.trim()}`.trim();
      const email = row[emailIndex] || "";
      const birthDate = row[birthIndex] || "";

      return {fullName, email, birthDate};
    });

    console.log(`✅ ${players.length} Spieler geladen.`);
    return {success: true, players};
  } catch (err) {
    console.error("❌ Fehler in readPlayerDetails:", err);
    return {success: false, error: err.message};
  }
});
