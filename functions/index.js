/* eslint-disable require-jsdoc */
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
 * Kombiniert Matches (mit Spieler‑IDs) und Players‑Tab zu vollständigen Match‑Objekten.
 * Unterstützt jetzt 3 Sätze!
 */
export const readFullMatches = onCall(async () => {
  try {
    console.log("✅ readFullMatches gestartet (3‑Satz‑Version)…");
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({version: "v4", auth});

    // --- Tabellen abrufen ---
    const [matchesRes, playersRes] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: "matches",
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: "players",
      }),
    ]);

    const matchesValues = matchesRes.data.values || [];
    const playersValues = playersRes.data.values || [];
    if (matchesValues.length < 2 || playersValues.length < 2) {
      throw new Error("Leere Tabellen (matches oder players).");
    }

    // --- Header finden ---
    const header = matchesValues[0].map((h) => h.trim().toLowerCase());
    const playerHeader = playersValues[0].map((h) => h.trim().toLowerCase());

    const idIndex = playerHeader.indexOf("id");
    const fnIndex = playerHeader.indexOf("firstname");
    const lnIndex = playerHeader.indexOf("lastname");

    // --- ID → Name Map ---
    const playerMap = new Map();
    playersValues.slice(1).forEach((r) => {
      const id = r[idIndex];
      const name = `${r[fnIndex] || ""} ${r[lnIndex] || ""}`.trim();
      playerMap.set(id, name);
    });

    // --- Spaltenindizes dynamisch ermitteln ---
    const idx = (label) => header.findIndex((v) => v.includes(label));

    const i1 = idx("spieler id 1");
    const i2 = idx("spieler id 2");
    const i3 = idx("spieler id 3");
    const i4 = idx("spieler id 4");
    const s1 = idx("satz 1");
    const s2 = idx("satz 2");
    const s3 = idx("satz 3");
    const d = idx("datum");
    const p = idx("platz");

    // --- Matches mappen ---
    const startRow = header[0].toLowerCase().includes("spieler") ? 1 : 0;
    const allMatches = matchesValues.slice(startRow).map((row) => {
      const sets = [row[s1], row[s2], row[s3]].filter(Boolean);

      return {
        date: row[d] || "---",
        players: [
          playerMap.get(row[i1]) || "---",
          playerMap.get(row[i2]) || "---",
          playerMap.get(row[i3]) || "---",
          playerMap.get(row[i4]) || "---",
        ],
        sets,
        platz: row[p] || "",
      };
    });

    console.log(`🏁 ${allMatches.length} Matches verarbeitet.`);
    return {success: true, matches: allMatches};
  } catch (err) {
    console.error("❌ Fehler in readFullMatches (3‑Satz‑Version):", err);
    return {success: false, error: err.message};
  }
});

/**
 * Fügt ein Match in die "matches"-Tabelle ein.
 */
export const addMatch = onCall(async (request) => {
  try {
    const {
      player1Id,
      player2Id = "",
      player3Id,
      player4Id = "",
    } = request.data || {};

    if (!player1Id || !player3Id) {
      return {
        success: false,
        error: "player1Id und player3Id müssen gesetzt sein",
      };
    }

    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({version: "v4", auth});

    // optional: IDs existieren in players
    const playersRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "players",
    });

    const players = playersRes.data.values || [];
    if (players.length < 2) {
      return {success: false, error: "Keine Spieler in players-Tabelle gefunden."};
    }

    const header = players[0].map((h) => (h || "").trim().toLowerCase());
    const idIdx = header.indexOf("id");
    if (idIdx === -1) {
      return {success: false, error: "players-Tabelle muss Spalte id enthalten."};
    }

    const validIds = new Set(players.slice(1).map((r) => (r[idIdx] || "").toString().trim()));

    const missingIds = [];
    if (!validIds.has(player1Id.toString().trim())) missingIds.push(`player1Id '${player1Id}'`);
    if (!validIds.has(player3Id.toString().trim())) missingIds.push(`player3Id '${player3Id}'`);
    if (player2Id && !validIds.has(player2Id.toString().trim())) missingIds.push(`player2Id '${player2Id}'`);
    if (player4Id && !validIds.has(player4Id.toString().trim())) missingIds.push(`player4Id '${player4Id}'`);

    if (missingIds.length > 0) {
      return {success: false, error: `ID(s) nicht gefunden: ${missingIds.join(", ")}`};
    }

    const p1id = player1Id.toString().trim();
    const p2id = player2Id.toString().trim();
    const p3id = player3Id.toString().trim();
    const p4id = player4Id.toString().trim();
    // Daten in preMatches schreiben (leere datum/platz = offen)
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "preMatches!A:F",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[p1id, p2id, p3id, p4id, "", ""]],
      },
    });

    console.log("✅ preMatch gespeichert:", res.data.updates);
    return {success: true, updates: res.data.updates};
  } catch (err) {
    console.error("❌ Google Sheets Schreibfehler:", err);
    return {success: false, error: err.message};
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
      return {rank, playerId, name};
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
 * Liest offene Herausforderungen für einen Spieler aus preMatches.
 * Nur der GEFORDERTE (Spieler 1) bekommt die Notification.
 */
export const getMyChallenges = onCall(async (request) => {
  try {
    const {userId} = request.data || {};
    if (!userId) {
      return {success: false, error: "userId fehlt"};
    }

    console.log("🔔 Lade Herausforderungen für User:", userId);

    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({version: "v4", auth});

    const [preMatchesRes, playersRes] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: "preMatches",
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: "players",
      }),
    ]);

    const preRows = preMatchesRes.data.values || [];
    const playerRows = playersRes.data.values || [];

    if (preRows.length < 2) {
      return {success: true, challenges: []};
    }

    const playerHeader = playerRows[0].map((h) => h.trim().toLowerCase());
    const pIdIdx = playerHeader.indexOf("id");
    const pFnIdx = playerHeader.indexOf("firstname");
    const pLnIdx = playerHeader.indexOf("lastname");

    const playerMap = new Map();
    playerRows.slice(1).forEach((r) => {
      const id = String(r[pIdIdx] || "");
      const name = (r[pFnIdx] || "") + " " + (r[pLnIdx] || "");
      playerMap.set(id, name.trim());
    });

    const preHeader = preRows[0].map((h) => h.trim().toLowerCase());
    const i1 = preHeader.indexOf("spieler id 1");
    const i2 = preHeader.indexOf("spieler id 2");
    const i3 = preHeader.indexOf("spieler id 3");
    const d = preHeader.indexOf("datum");

    const challenges = [];
    preRows.slice(1).forEach((row, rowIndex) => {
      const rowNum = rowIndex + 2;
      const p1 = String(row[i1] || "");
      const p2 = String(row[i2] || "");
      const p3 = String(row[i3] || "");
      const datum = row[d] || "";

      const isForMe = p1 === userId;
      const isOpen = !datum;

      if (isForMe && isOpen) {
        challenges.push({
          row: rowNum,
          player1: playerMap.get(p1) || p1,
          player2: playerMap.get(p2) || p2,
          player3: playerMap.get(p3) || p3,
        });
      }
    });

    console.log(`✅ ${challenges.length} offene Herausforderungen gefunden.`);
    return {success: true, challenges};
  } catch (err) {
    console.error("❌ Fehler in getMyChallenges:", err);
    return {success: false, error: err.message};
  }
});

/**
 * Trägt Datum (und optional Platz) in eine preMatches-Zeile ein.
 */
export const setMatchDate = onCall(async (request) => {
  try {
    const {row, datum, platz} = request.data || {};
    if (!row || !datum) {
      return {success: false, error: "row und datum sind erforderlich"};
    }

    console.log("📅 Setze Datum in preMatches Zeile", row, ":", datum);

    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({version: "v4", auth});

    const preRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "preMatches",
    });
    const preRows = preRes.data.values || [];
    if (preRows.length < 2) {
      return {success: false, error: "preMatches ist leer"};
    }

    const header = preRows[0].map((h) => h.trim().toLowerCase());
    // const dIdx = header.indexOf("datum");
    const pIdx = header.indexOf("platz");

    const rowInSheet = row;
    const cellE = `preMatches!E${rowInSheet}`;
    const updates = [];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: cellE,
      valueInputOption: "USER_ENTERED",
      requestBody: {values: [[datum]]},
    });
    updates.push(`datum=${datum}`);

    if (platz && pIdx !== -1) {
      const cellF = `preMatches!F${rowInSheet}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: cellF,
        valueInputOption: "USER_ENTERED",
        requestBody: {values: [[platz]]},
      });
      updates.push(`platz=${platz}`);
    }

    console.log("✅ Datum gesetzt:", updates.join(", "));
    return {success: true};
  } catch (err) {
    console.error("❌ Fehler in setMatchDate:", err);
    return {success: false, error: err.message};
  }
});

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

/**
 * Liest ALLE PreMatches (kein Filter).
 */
export const readPreMatches = onCall(async (request) => {
  try {
    const userId = request.data && request.data.userId ? String(request.data.userId).trim() : null;

    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({version: "v4", auth});

    const [preRes, playerRes] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: "preMatches",
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: "players",
      }),
    ]);

    const preValues = preRes.data.values || [];
    const playerValues = playerRes.data.values || [];

    if (preValues.length < 2) {
      return {success: true, preMatches: []};
    }

    const playerHeader = playerValues[0].map((h) => h.trim().toLowerCase());
    const pIdIdx = playerHeader.indexOf("id");
    const pFnIdx = playerHeader.indexOf("firstname");
    const pLnIdx = playerHeader.indexOf("lastname");

    const playerMap = new Map();
    playerValues.slice(1).forEach((r) => {
      const id = String(r[pIdIdx] || "");
      const name = (r[pFnIdx] || "") + " " + (r[pLnIdx] || "");
      playerMap.set(id, name.trim());
    });

    const preHeader = preValues[0].map((h) => h.trim().toLowerCase());
    const i1 = preHeader.indexOf("spieler id 1");
    const i2 = preHeader.indexOf("spieler id 2");
    const i3 = preHeader.indexOf("spieler id 3");
    const i4 = preHeader.indexOf("spieler id 4");
    const d = preHeader.indexOf("datum");
    const p = preHeader.indexOf("platz");
    const st = preHeader.indexOf("status");
    const er = preHeader.indexOf("ergebnis");
    const be = preHeader.indexOf("bestaetigtvon");

    const preMatches = [];
    preValues.slice(1).forEach((row, rowIndex) => {
      const rowNum = rowIndex + 2;
      const p1 = String(row[i1] || "");
      const p2 = String(row[i2] || "");
      const p3 = String(row[i3] || "");
      const p4 = String(row[i4] || "");
      const datum = d !== -1 ? (row[d] || "") : "";
      const platz = p !== -1 ? (row[p] || "") : "";
      const status = st !== -1 ? (row[st] || "") : "offen";
      const ergebnis = er !== -1 ? (row[er] || "") : "";
      const bestaetigtVon = be !== -1 ? (row[be] || "") : "";

      if (!p1 && !p2 && !p3 && !p4) {
        return;
      }

      const isForMe = userId ? [p1, p2, p3, p4].includes(userId) : false;

      const match = {
        row: rowNum,
        player1: playerMap.get(p1) || p1,
        player2: playerMap.get(p2) || p2,
        player3: playerMap.get(p3) || p3,
        player4: playerMap.get(p4) || p4,
        player1Id: p1,
        player2Id: p2,
        player3Id: p3,
        player4Id: p4,
        datum,
        platz,
        status,
        ergebnis,
        bestaetigtVon,
        isForMe: isForMe,
        canEnterResult: !ergebnis && isForMe,
        canConfirm: !!ergebnis && isForMe,
      };

      preMatches.push(match);
    });

    return {success: true, preMatches};
  } catch (err) {
    console.error("Fehler in readPreMatches:", err);
    return {success: false, error: err.message};
  }
});

/**
 * Tragt Match-Ergebnis ein, verschiebt in matches Tabelle.
 */
export const setPreMatchResult = onCall(async (request) => {
  try {
    const {row, satz1, satz2, satz3, userId} = request.data || {};

    if (!row || !satz1 || !satz2 || !satz3 || !userId) {
      return {success: false, error: "Alle Felder erforderlich"};
    }

    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({version: "v4", auth});

    const preRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "preMatches",
    });
    const preValues = preRes.data.values || [];
    if (preValues.length < 2 || row > preValues.length) {
      return {success: false, error: "PreMatch nicht gefunden"};
    }

    const preHeader = preValues[0].map((h) => h.trim().toLowerCase());
    const i1 = preHeader.indexOf("spieler id 1");
    const i2 = preHeader.indexOf("spieler id 2");
    const i3 = preHeader.indexOf("spieler id 3");
    const i4 = preHeader.indexOf("spieler id 4");
    const d = preHeader.indexOf("datum");
    const p = preHeader.indexOf("platz");
    const er = preHeader.indexOf("ergebnis");
    const be = preHeader.indexOf("bestaetigtvon");

    const matchRow = preValues[row - 1];
    const existingErgebnis = matchRow[er] || "";
    const existingBestaetigt = matchRow[be] || "";

    const ergebnisWert = satz1 + "," + satz2 + "," + satz3;

    if (existingErgebnis && existingErgebnis !== ergebnisWert) {
      return {success: false, error: "Anderes Ergebnis bereits eingetragen"};
    }

    if (existingBestaetigt.includes(userId)) {
      return {success: false, error: "Ergebnis bereits bestatigt"};
    }

    const p1 = String(matchRow[i1] || "");
    const p2 = String(matchRow[i2] || "");
    const p3 = String(matchRow[i3] || "");
    const p4 = String(matchRow[i4] || "");
    const datum = matchRow[d] || "";
    const platz = matchRow[p] || "";

    const saetze = [satz1, satz2, satz3];
    let siegeP1 = 0;
    let siegeP3 = 0;
    saetze.forEach((s) => {
      if (s && s.includes(":")) {
        const teile = s.split(":");
        const punkte1 = parseInt(teile[0], 10);
        const punkte3 = parseInt(teile[1], 10);
        if (!isNaN(punkte1) && !isNaN(punkte3)) {
          if (punkte1 > punkte3) {
            siegeP1++;
          } else if (punkte3 > punkte1) {
            siegeP3++;
          }
        }
      }
    });
    const gewinner = siegeP1 > siegeP3 ? p1 : p3;

    const newRow = [p1, p2, p3, p4, satz1, satz2, satz3, datum, platz, gewinner];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "matches!A:J",
      valueInputOption: "USER_ENTERED",
      requestBody: {values: [newRow]},
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "preMatches!A" + row + ":J" + row,
      valueInputOption: "USER_ENTERED",
      requestBody: {values: [["", "", "", "", "", "", "", "", "", ""]]},
    });

    return {success: true};
  } catch (err) {
    console.error("Fehler in setPreMatchResult:", err);
    return {success: false, error: err.message};
  }
});
