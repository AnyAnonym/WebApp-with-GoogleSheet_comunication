const crypto = require("crypto");
const { google } = require("googleapis");
const { GOOGLE_REQUEST_TIMEOUT_MS, SHEET_ID, TABLE_CONFIG } = require("./config.js");
const dataStore = require("./dataStore.js");
const { AppError } = require("./errors.js");
const { analyzeMatchRules } = require("./matchRules.js");
const { headerIndex, headerOf } = require("./tableUtils.js");
const { validateTableValues } = require("./tableSchemas.js");

const RECORD_METADATA_KEY = "epiberRecord";

function viennaTimestamp(includeSeconds = false) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: includeSeconds ? "2-digit" : undefined,
    hourCycle: "h23",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}-${values.hour}${values.minute}${includeSeconds ? `-${values.second}` : ""}`;
}

function stableRecordId(prefix, principal, operationId) {
  const digest = crypto.createHash("sha256").update(`${principal.type}:${principal.id}:${operationId}`).digest("hex").slice(0, 32);
  return `${prefix}-${digest}`;
}

function rowForHeader(header, valuesByName) {
  const row = Array(header.length).fill("");
  for (const [name, value] of Object.entries(valuesByName)) {
    const index = headerIndex(header, name);
    if (index < 0) throw new AppError("SHEET_SCHEMA", `Spalte ${name} fehlt`, 503);
    row[index] = value;
  }
  return row;
}

function requireCurrentData(...tableNames) {
  for (const tableName of tableNames) {
    if (!dataStore.isTableCurrent(tableName)) {
      throw new AppError("DATA_NOT_READY", `Tabelle ${tableName} ist nicht aktuell`, 503);
    }
  }
}

function parseCompetitionDate(raw, endOfDay) {
  const value = String(raw || "").trim();
  if (!value) return null;
  const match = value.match(/^(\d{2}|\d{4})(\d{2})(\d{2})(?:-(\d{2})(\d{2}))?$/);
  if (!match) throw new AppError("COMPETITION_DATE_INVALID", "Bewerbszeitraum ist ungueltig", 503);
  const [, yearValue, month, day, hour, minute] = match;
  const year = yearValue.length === 2
    ? (Number(yearValue) >= 50 ? 1900 + Number(yearValue) : 2000 + Number(yearValue))
    : Number(yearValue);
  const date = new Date(
    year,
    Number(month) - 1,
    Number(day),
    hour === undefined ? (endOfDay ? 23 : 0) : Number(hour),
    minute === undefined ? (endOfDay ? 59 : 0) : Number(minute),
    endOfDay && hour === undefined ? 59 : 0,
  );
  if (date.getFullYear() !== year || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) {
    throw new AppError("COMPETITION_DATE_INVALID", "Bewerbszeitraum ist ungueltig", 503);
  }
  return date;
}

class SheetService {
  constructor({ repository, clientFactory = null, now = Date.now } = {}) {
    this.repository = repository;
    this.clientFactory = clientFactory;
    this.client = null;
    this.queues = new Map();
    this.active = new Set();
    this.stopping = false;
    this.now = now;
    this.sheetIds = new Map();
    this.recordMetadata = new Map();
  }

  competition(competitionId) {
    const values = dataStore.get("bewerbe");
    const header = headerOf(values);
    const idIndex = headerIndex(header, "id");
    const row = values.slice(1).find((entry) => String(entry[idIndex] || "").trim() === competitionId);
    if (!row) throw new AppError("COMPETITION_NOT_FOUND", "Bewerb wurde nicht gefunden", 404);
    return { header, row };
  }

  assertEntryWindow(competitionId, personId) {
    requireCurrentData("bewerbe", "players");
    const players = dataStore.get("players");
    const playerHeader = headerOf(players);
    const playerIdIndex = headerIndex(playerHeader, "id");
    const activeIndex = headerIndex(playerHeader, "aktiv");
    const person = players.slice(1).find((row) => String(row[playerIdIndex] || "").trim() === personId);
    if (!person || (activeIndex >= 0 && String(person[activeIndex] || "").trim() !== "1")) {
      throw new AppError("PLAYER_NOT_ACTIVE", "Spieler ist nicht aktiv", 409);
    }
    const { header, row } = this.competition(competitionId);
    const startIndex = headerIndex(header, "entrystart");
    const deadlineIndex = headerIndex(header, "entrydeadline");
    const start = startIndex < 0 ? null : parseCompetitionDate(row[startIndex], false);
    const deadline = deadlineIndex < 0 ? null : parseCompetitionDate(row[deadlineIndex], true);
    const now = new Date(this.now());
    if (start && now < start) throw new AppError("ENTRY_NOT_OPEN", "Eintragungsfrist hat noch nicht begonnen", 409);
    if (deadline && now > deadline) throw new AppError("ENTRY_CLOSED", "Eintragungsfrist ist abgelaufen", 409);
  }

  assertChallengeAllowed(principal, competitionId, opponentId, matches = dataStore.get("matches1")) {
    requireCurrentData("players", "bewerbe", "matches1", "rlPlatzierung");
    this.competition(competitionId);
    const players = dataStore.get("players");
    const playerHeader = headerOf(players);
    const playerIdIndex = headerIndex(playerHeader, "id");
    const activeIndex = headerIndex(playerHeader, "aktiv");
    const activePlayers = new Set(players.slice(1)
      .filter((row) => activeIndex < 0 || String(row[activeIndex] || "").trim() === "1")
      .map((row) => String(row[playerIdIndex] || "").trim()));
    if (!activePlayers.has(principal.id) || !activePlayers.has(opponentId)) {
      throw new AppError("PLAYER_NOT_ACTIVE", "Spieler ist nicht aktiv", 409);
    }

    const rankings = dataStore.get("rlPlatzierung");
    const rankingHeader = headerOf(rankings);
    const competitionIndex = headerIndex(rankingHeader, "bewerbid");
    const personIndex = headerIndex(rankingHeader, "personid");
    const rankIndex = headerIndex(rankingHeader, "rang");
    const entries = rankings.slice(1)
      .filter((row) => String(row[competitionIndex] || "").trim() === competitionId)
      .map((row) => ({ id: String(row[personIndex] || "").trim(), rank: Number(row[rankIndex]) }))
      .filter((entry) => entry.id && Number.isInteger(entry.rank) && entry.rank > 0)
      .sort((left, right) => left.rank - right.rank);
    const myIndex = entries.findIndex((entry) => entry.id === principal.id);
    const opponentIndex = entries.findIndex((entry) => entry.id === opponentId);
    if (myIndex < 0 || opponentIndex < 0) throw new AppError("RANKING_MEMBERSHIP_REQUIRED", "Beide Spieler muessen in der Rangliste sein", 409);

    const rows = [];
    for (let index = 0, size = 1; index < entries.length; size++) {
      rows.push(entries.slice(index, index + size));
      index += size;
    }
    let myRow = -1;
    let myColumn = -1;
    for (const [rowIndex, row] of rows.entries()) {
      const column = row.findIndex((entry) => entry.id === principal.id);
      if (column >= 0) {
        myRow = rowIndex;
        myColumn = column;
        break;
      }
    }
    const allowed = new Set();
    for (let index = 0; index < myColumn; index++) allowed.add(rows[myRow][index].id);
    const rowAbove = rows[myRow - 1] || [];
    for (let index = myColumn; index < rowAbove.length; index++) allowed.add(rowAbove[index].id);
    if (entries[myIndex].rank === 3) {
      const first = entries.find((entry) => entry.rank === 1);
      if (first) allowed.add(first.id);
    }
    if (!allowed.has(opponentId)) throw new AppError("CHALLENGE_NOT_ALLOWED", "Dieser Spieler kann nicht gefordert werden", 409);

    const rules = analyzeMatchRules(matches, competitionId, new Date(this.now()));
    if (rules.busyIds.has(principal.id) || rules.busyIds.has(opponentId)) {
      throw new AppError("PLAYER_BUSY", "Mindestens ein Spieler hat bereits eine offene Forderung", 409);
    }
    if (rules.blocked.has(principal.id)) throw new AppError("PLAYER_BLOCKED", "Eigene Sperrzeit ist noch aktiv", 409);
    if (rules.protection.has(opponentId)) throw new AppError("OPPONENT_PROTECTED", "Gegnerische Schutzzeit ist noch aktiv", 409);
  }

  assertRankingMembership(principal, competitionId, rank) {
    requireCurrentData("rlPlatzierung");
    const values = dataStore.get("rlPlatzierung");
    const header = headerOf(values);
    const competitionIndex = headerIndex(header, "bewerbid");
    const personIndex = headerIndex(header, "personid");
    const rankIndex = headerIndex(header, "rang");
    const row = values.slice(1).find((entry) => (
      String(entry[competitionIndex] || "").trim() === competitionId
      && String(entry[personIndex] || "").trim() === principal.id
    ));
    if (!row) throw new AppError("RANKING_MEMBERSHIP_REQUIRED", "Spieler ist nicht in dieser Rangliste", 409);
    if (Number(row[rankIndex]) !== rank) throw new AppError("RANK_CONFLICT", "Rang wurde zwischenzeitlich geaendert", 409);
  }

  async getClient() {
    if (this.client) return this.client;
    if (this.clientFactory) {
      this.client = await this.clientFactory();
      return this.client;
    }
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.client = google.sheets({ version: "v4", auth });
    return this.client;
  }

  enqueue(key, callback) {
    if (this.stopping) return Promise.reject(new AppError("SHUTTING_DOWN", "Server wird beendet", 503));
    if (this.active.size >= 1000) return Promise.reject(new AppError("WRITE_QUEUE_FULL", "Schreibwarteschlange ist voll", 503));
    const previous = this.queues.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(callback);
    this.queues.set(key, operation);
    this.active.add(operation);
    operation.finally(() => {
      this.active.delete(operation);
      if (this.queues.get(key) === operation) this.queues.delete(key);
    }).catch(() => {});
    return operation;
  }

  async readTable(tableName) {
    const config = TABLE_CONFIG[tableName];
    if (!config) throw new AppError("TABLE_UNKNOWN", `Tabelle ${tableName} ist unbekannt`, 500);
    const sheets = await this.getClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: config.range,
    }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
    return validateTableValues(tableName, response.data.values || []);
  }

  async getSheetId(sheets, tableName) {
    if (this.sheetIds.has(tableName)) return this.sheetIds.get(tableName);
    const title = TABLE_CONFIG[tableName].range;
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: "sheets.properties(sheetId,title)",
    }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
    const sheet = spreadsheet.data.sheets.find((entry) => entry.properties.title === title);
    if (!sheet) throw new AppError("SHEET_SCHEMA", `${title}-Tab fehlt`, 503);
    this.sheetIds.set(tableName, sheet.properties.sheetId);
    return sheet.properties.sheetId;
  }

  async findRecordMetadata(sheets, tableName, recordId) {
    const cacheKey = `${tableName}:${recordId}`;
    if (this.recordMetadata.has(cacheKey)) return this.recordMetadata.get(cacheKey);
    const response = await sheets.spreadsheets.developerMetadata.search({
      spreadsheetId: SHEET_ID,
      requestBody: {
        dataFilters: [{ developerMetadataLookup: {
          metadataKey: RECORD_METADATA_KEY,
          metadataValue: cacheKey,
          visibility: "DOCUMENT",
          locationType: "ROW",
        } }],
      },
    }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
    let matches = (response.data.matchedDeveloperMetadata || []).map((entry) => entry.developerMetadata).filter(Boolean);
    if (matches.length > 1) {
      const locationKey = (metadata) => {
        const range = metadata.location?.dimensionRange;
        return range ? `${range.sheetId}:${range.startIndex}:${range.endIndex}` : null;
      };
      const locations = matches.map(locationKey);
      if (locations.some((location) => !location) || new Set(locations).size !== 1) {
        throw new AppError("SHEET_SCHEMA", `Metadaten fuer ${cacheKey} sind nicht eindeutig`, 503);
      }
      matches.sort((left, right) => Number(left.metadataId) - Number(right.metadataId));
      const [keep, ...duplicates] = matches;
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: {
            requests: duplicates.map((metadata) => ({
              deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataId: metadata.metadataId } } },
            })),
          },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
      } catch (error) {
        console.warn(`sheetService: Doppelte Metadaten fuer ${cacheKey} konnten nicht bereinigt werden:`, error.message);
      }
      matches = [keep];
    }
    const metadata = matches[0] || null;
    if (metadata) this.recordMetadata.set(cacheKey, metadata);
    return metadata;
  }

  async createRecordMetadata(sheets, tableName, recordId, rowIndex) {
    const cacheKey = `${tableName}:${recordId}`;
    const sheetId = await this.getSheetId(sheets, tableName);
    const intentKey = `record-metadata-intent:${cacheKey}`;
    const intent = this.repository.getState(intentKey, { status: "none" });
    if (intent.value.status === "pending") {
      throw new AppError("WRITE_OUTCOME_UNKNOWN", "Zeilenmetadaten werden noch bestaetigt", 503, { tableName, recordId });
    }
    this.repository.setState(intentKey, { status: "pending", at: this.now() }, intent.revision);
    let metadata;
    try {
      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: [{ createDeveloperMetadata: { developerMetadata: {
            metadataKey: RECORD_METADATA_KEY,
            metadataValue: cacheKey,
            visibility: "DOCUMENT",
            location: { dimensionRange: { sheetId, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1 } },
          } } }],
        },
      }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
      metadata = response.data.replies?.[0]?.createDeveloperMetadata?.developerMetadata;
    } catch (error) {
      try {
        metadata = await this.findRecordMetadata(sheets, tableName, recordId);
      } catch (confirmationError) {
        console.error("sheetService: Metadaten-Bestaetigungsread fehlgeschlagen:", confirmationError.message);
      }
      if (!metadata) {
        const status = Number(error?.response?.status || error?.status || 0);
        if (status >= 400 && status < 500 && status !== 408) {
          const pending = this.repository.getState(intentKey, { status: "pending" });
          this.repository.setState(intentKey, { status: "failed", at: this.now(), statusCode: status }, pending.revision);
          throw error;
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Metadatenerstellung ist unklar", 503, { tableName, recordId });
      }
    }
    if (metadata?.metadataId === undefined || metadata.metadataId === null) {
      throw new AppError("WRITE_OUTCOME_UNKNOWN", "Zeilenmetadaten konnten nicht bestaetigt werden", 503);
    }
    this.recordMetadata.set(cacheKey, metadata);
    const pending = this.repository.getState(intentKey, { status: "pending" });
    this.repository.setState(intentKey, { status: "confirmed", metadataId: metadata.metadataId, at: this.now() }, pending.revision);
    return metadata;
  }

  async deleteRecordMetadata(sheets, tableName, recordId, metadataId) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataId } } } }] },
    }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
    this.recordMetadata.delete(`${tableName}:${recordId}`);
    const intentKey = `record-metadata-intent:${tableName}:${recordId}`;
    const intent = this.repository.getState(intentKey, { status: "none" });
    this.repository.setState(intentKey, { status: "deleted", at: this.now() }, intent.revision);
  }

  async readMetadataRow(sheets, metadataId) {
    const response = await sheets.spreadsheets.values.batchGetByDataFilter({
      spreadsheetId: SHEET_ID,
      requestBody: {
        dataFilters: [{ developerMetadataLookup: { metadataId } }],
        majorDimension: "ROWS",
        valueRenderOption: "FORMULA",
      },
    }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
    const rows = (response.data.valueRanges || []).flatMap((entry) => entry.valueRange?.values || []);
    return rows.length === 1 ? rows[0] : null;
  }

  async resolveStableRow(tableName, recordId, initialValues = null) {
    const sheets = await this.getClient();
    let values = initialValues || await this.readTable(tableName);
    for (let attempt = 0; attempt < 3; attempt++) {
      const header = headerOf(values);
      const idIndex = headerIndex(header, "id");
      const offset = values.slice(1).findIndex((row) => String(row[idIndex] || "").trim() === recordId);
      if (offset < 0) throw new AppError("RECORD_NOT_FOUND", "Datensatz wurde nicht gefunden", 404);
      let metadata = await this.findRecordMetadata(sheets, tableName, recordId);
      if (!metadata) metadata = await this.createRecordMetadata(sheets, tableName, recordId, offset + 1);
      const row = await this.readMetadataRow(sheets, metadata.metadataId);
      if (row && String(row[idIndex] || "").trim() === recordId) return { sheets, metadata, row, header };
      await this.deleteRecordMetadata(sheets, tableName, recordId, metadata.metadataId);
      values = await this.readTable(tableName);
    }
    throw new AppError("WRITE_CONFLICT", "Datensatz wurde waehrend der Aktualisierung verschoben", 409);
  }

  async refreshCache(tableName, fallback) {
    try {
      const fresh = await this.readTable(tableName);
      dataStore.set(tableName, fresh, { source: "write" });
      return fresh;
    } catch (error) {
      console.error(`sheetService: Cache-Refresh fuer ${tableName} fehlgeschlagen:`, error.message);
      const merged = fallback(structuredClone(dataStore.get(tableName)));
      dataStore.set(tableName, merged, { source: "write" });
      return merged;
    }
  }

  async runIdempotent(principal, endpoint, operationId, payload, callback) {
    const actorKey = `${principal.type}:${principal.id}`;
    const existing = this.repository.getOperation(actorKey, operationId, endpoint, payload);
    if (existing && existing.operationStatus !== "unknown") return { ...existing, repeated: true };
    return this.enqueue(`operation:${actorKey}:${operationId}`, async () => {
      const repeated = this.repository.getOperation(actorKey, operationId, endpoint, payload);
      if (repeated && repeated.operationStatus !== "unknown") return { ...repeated, repeated: true };
      try {
        const result = await callback({
          recoveryOnly: repeated?.operationStatus === "unknown",
          recoveryDetails: repeated?.details || null,
        });
        if (repeated) this.repository.replaceOperation(actorKey, operationId, endpoint, payload, result);
        else this.repository.saveOperation(actorKey, operationId, endpoint, payload, result);
        return repeated ? { ...result, repeated: true } : result;
      } catch (error) {
        if (error.code === "WRITE_OUTCOME_UNKNOWN") {
          const marker = { operationStatus: "unknown", details: error.details || null };
          if (repeated) this.repository.replaceOperation(actorKey, operationId, endpoint, payload, marker);
          else this.repository.saveOperation(actorKey, operationId, endpoint, payload, marker);
        }
        throw error;
      }
    });
  }

  async setPasswordHash(personId, storedHash, { expectedHash, requirePasswordSetupAllowed = false } = {}) {
    return this.enqueue("players", async () => {
      const values = await this.readTable("players");
      let stable;
      try {
        stable = await this.resolveStableRow("players", personId, values);
      } catch (error) {
        if (error.code === "RECORD_NOT_FOUND") throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
        throw error;
      }
      const { header, metadata, row, sheets } = stable;
      const passwordIndex = headerIndex(header, "passwdhash");
      const resetIndex = headerIndex(header, "kennwortvergessen");
      const activeIndex = headerIndex(header, "aktiv");
      if (passwordIndex < 0) throw new AppError("SHEET_SCHEMA", "Personen-Spalten fehlen", 500);
      if (requirePasswordSetupAllowed && (
        resetIndex < 0
        || activeIndex < 0
        || String(row[resetIndex] || "").trim().toLowerCase() !== "x"
        || String(row[activeIndex] || "").trim() !== "1"
      )) {
        throw new AppError("PASSWORD_SETUP_INVALID", "Passwortvergabe ist nicht freigegeben", 401);
      }
      if (String(row[passwordIndex] || "").trim() === storedHash) {
        const confirmation = await this.readTable("players");
        dataStore.set("players", confirmation, { source: "write" });
        return { success: true, recovered: true };
      }
      if (expectedHash !== undefined && String(row[passwordIndex] || "").trim() !== expectedHash) {
        throw new AppError("PASSWORD_CONFLICT", "Passwort wurde zwischenzeitlich geaendert", 409);
      }
      const updates = Array(Math.max(passwordIndex, resetIndex) + 1).fill(null);
      updates[passwordIndex] = storedHash;
      if (resetIndex >= 0) updates[resetIndex] = "";
      try {
        const response = await sheets.spreadsheets.values.batchUpdateByDataFilter({
          spreadsheetId: SHEET_ID,
          requestBody: {
            valueInputOption: "RAW",
            data: [{
              dataFilter: { developerMetadataLookup: { metadataId: metadata.metadataId } },
              majorDimension: "ROWS",
              values: [updates],
            }],
          },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
        if (Number(response.data.totalUpdatedRows) !== 1) throw new Error("Metadaten-Update hat keine eindeutige Zeile aktualisiert");
      } catch (error) {
        try {
          const confirmationRow = await this.readMetadataRow(sheets, metadata.metadataId);
          if (confirmationRow && String(confirmationRow[passwordIndex] || "").trim() === storedHash) {
            const confirmation = await this.readTable("players");
            dataStore.set("players", confirmation, { source: "write" });
            return { success: true, recovered: true };
          }
        } catch (confirmationError) {
          console.error("sheetService: Passwort-Bestaetigungsread fehlgeschlagen:", confirmationError.message);
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Passwortaenderung ist unklar", 503, { personId });
      }
      await this.refreshCache("players", (cached) => {
        const cachedHeader = headerOf(cached);
        const cachedIdIndex = headerIndex(cachedHeader, "id");
        const cachedPasswordIndex = headerIndex(cachedHeader, "passwdhash");
        const cachedResetIndex = headerIndex(cachedHeader, "kennwortvergessen");
        const cachedRow = cached.slice(1).find((row) => String(row[cachedIdIndex] || "").trim() === personId);
        if (cachedRow && cachedPasswordIndex >= 0) cachedRow[cachedPasswordIndex] = storedHash;
        if (cachedRow && cachedResetIndex >= 0) cachedRow[cachedResetIndex] = "";
        return cached;
      });
      return { success: true };
    });
  }

  async setPasswordSetupAllowed(personId, allowed) {
    return this.enqueue("players", async () => {
      const values = await this.readTable("players");
      let stable;
      try {
        stable = await this.resolveStableRow("players", personId, values);
      } catch (error) {
        if (error.code === "RECORD_NOT_FOUND") throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
        throw error;
      }
      const { header, metadata, row, sheets } = stable;
      const setupIndex = headerIndex(header, "kennwortvergessen");
      if (setupIndex < 0) throw new AppError("SHEET_SCHEMA", "Personen-Spalte KennwortVergessen fehlt", 500);
      const marker = allowed ? "x" : "";
      if (String(row[setupIndex] || "").trim().toLowerCase() === marker) return { success: true, repeated: true };
      const updates = Array(setupIndex + 1).fill(null);
      updates[setupIndex] = marker;
      try {
        const response = await sheets.spreadsheets.values.batchUpdateByDataFilter({
          spreadsheetId: SHEET_ID,
          requestBody: {
            valueInputOption: "RAW",
            data: [{
              dataFilter: { developerMetadataLookup: { metadataId: metadata.metadataId } },
              majorDimension: "ROWS",
              values: [updates],
            }],
          },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
        if (Number(response.data.totalUpdatedRows) !== 1) throw new Error("Metadaten-Update hat keine eindeutige Zeile aktualisiert");
      } catch (error) {
        try {
          const confirmationRow = await this.readMetadataRow(sheets, metadata.metadataId);
          if (!confirmationRow || String(confirmationRow[setupIndex] || "").trim().toLowerCase() !== marker) throw error;
        } catch {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Passwortfreigabe ist unklar", 503, { personId });
        }
      }
      await this.refreshCache("players", (cached) => {
        const cachedHeader = headerOf(cached);
        const cachedIdIndex = headerIndex(cachedHeader, "id");
        const cachedSetupIndex = headerIndex(cachedHeader, "kennwortvergessen");
        const cachedRow = cached.slice(1).find((entry) => String(entry[cachedIdIndex] || "").trim() === personId);
        if (cachedRow && cachedSetupIndex >= 0) cachedRow[cachedSetupIndex] = marker;
        return cached;
      });
      return { success: true };
    });
  }

  async addMatch(principal, params) {
    const payload = { bewerbId: params.bewerbId, opponentId: params.opponentId };
    return this.runIdempotent(principal, "addMatch", params.operationId, payload, ({ recoveryOnly }) => this.enqueue("matches1", async () => {
      if (params.opponentId === principal.id) throw new AppError("MATCH_SELF", "Ein Spieler kann sich nicht selbst fordern");
      const values = await this.readTable("matches1");
      const header = headerOf(values);
      const idIndex = headerIndex(header, "id");
      const newId = stableRecordId("m", principal, params.operationId);
      if (values.slice(1).some((row) => String(row[idIndex] || "").trim() === newId)) {
        dataStore.set("matches1", values, { source: "write" });
        return { success: true, newMatchId: newId, recovered: true };
      }
      if (recoveryOnly) {
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Match-Erstellung ist noch nicht nachweisbar", 503, { operationId: params.operationId, recordId: newId });
      }
      this.assertChallengeAllowed(principal, params.bewerbId, params.opponentId, values);
      const newRow = rowForHeader(header, {
        id: newId,
        forderungdate: viennaTimestamp(),
        bewerbid: params.bewerbId,
        spieler1id: params.opponentId,
        spieler3id: principal.id,
      });
      const sheets = await this.getClient();
      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: TABLE_CONFIG.matches1.range,
          valueInputOption: "RAW",
          requestBody: { values: [newRow] },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
      } catch (error) {
        try {
          const confirmation = await this.readTable("matches1");
          if (confirmation.slice(1).some((row) => String(row[idIndex] || "").trim() === newId)) {
            dataStore.set("matches1", confirmation, { source: "write" });
            return { success: true, newMatchId: newId, recovered: true };
          }
        } catch (confirmationError) {
          console.error("sheetService: Match-Bestaetigungsread fehlgeschlagen:", confirmationError.message);
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Match-Erstellung ist unklar", 503, { operationId: params.operationId, recordId: newId });
      }
      await this.refreshCache("matches1", (cached) => {
        const cachedIdIndex = headerIndex(headerOf(cached), "id");
        if (!cached.slice(1).some((row) => String(row[cachedIdIndex] || "").trim() === newId)) cached.push(newRow);
        return cached;
      });
      return { success: true, newMatchId: newId };
    }));
  }

  async addEntry(principal, params) {
    const payload = { bewerbId: params.bewerbId };
    return this.runIdempotent(principal, "addEntryList", params.operationId, payload, ({ recoveryOnly }) => this.enqueue("entryList", async () => {
      const values = await this.readTable("entryList");
      const header = headerOf(values);
      const idIndex = headerIndex(header, "id");
      const competitionIndex = headerIndex(header, "bewerbid", "bewerb id");
      const personIndex = headerIndex(header, "personenid", "personen id", "personid", "playerid", "spielerid");
      if (competitionIndex < 0 || personIndex < 0) throw new AppError("SHEET_SCHEMA", "EntryList-Spalten fehlen", 500);
      const newId = stableRecordId("e", principal, params.operationId);
      if (values.slice(1).some((row) => String(row[idIndex] || "").trim() === newId)) {
        dataStore.set("entryList", values, { source: "write" });
        return { success: true, entryId: newId, recovered: true };
      }
      if (recoveryOnly) {
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Anmeldung ist noch nicht nachweisbar", 503, { operationId: params.operationId, recordId: newId });
      }
      this.assertEntryWindow(params.bewerbId, principal.id);
      const exists = values.slice(1).some((row) =>
        String(row[competitionIndex] || "").trim() === params.bewerbId &&
        String(row[personIndex] || "").trim() === principal.id);
      if (exists) {
        dataStore.set("entryList", values, { source: "write" });
        return { success: true, alreadyPresent: true };
      }
      const newRow = rowForHeader(header, { id: newId, bewerbid: params.bewerbId, personenid: principal.id, entrydate: viennaTimestamp() });
      const sheets = await this.getClient();
      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: TABLE_CONFIG.entryList.range,
          valueInputOption: "RAW",
          requestBody: { values: [newRow] },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
      } catch (error) {
        try {
          const confirmation = await this.readTable("entryList");
          if (confirmation.slice(1).some((row) => String(row[idIndex] || "").trim() === newId)) {
            dataStore.set("entryList", confirmation, { source: "write" });
            return { success: true, entryId: newId, recovered: true };
          }
        } catch (confirmationError) {
          console.error("sheetService: EntryList-Bestaetigungsread fehlgeschlagen:", confirmationError.message);
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Anmeldung ist unklar", 503, { operationId: params.operationId, recordId: newId });
      }
      await this.refreshCache("entryList", (cached) => {
        const cachedIdIndex = headerIndex(headerOf(cached), "id");
        if (!cached.slice(1).some((row) => String(row[cachedIdIndex] || "").trim() === newId)) cached.push(newRow);
        return cached;
      });
      return { success: true, entryId: newId };
    }));
  }

  async removeEntry(principal, params) {
    const payload = { bewerbId: params.bewerbId };
    return this.runIdempotent(principal, "removeEntryList", params.operationId, payload, ({ recoveryOnly, recoveryDetails }) => this.enqueue("entryList", async () => {
      const values = await this.readTable("entryList");
      const header = headerOf(values);
      const idIndex = headerIndex(header, "id");
      const competitionIndex = headerIndex(header, "bewerbid", "bewerb id");
      const personIndex = headerIndex(header, "personenid", "personen id", "personid", "playerid", "spielerid");
      if (idIndex < 0 || competitionIndex < 0 || personIndex < 0) throw new AppError("SHEET_SCHEMA", "EntryList-Spalten fehlen", 500);
      if (recoveryOnly && recoveryDetails?.phase === "delete") {
        const recordId = String(recoveryDetails?.recordId || "").trim();
        if (recordId && !values.slice(1).some((row) => String(row[idIndex] || "").trim() === recordId)) {
          dataStore.set("entryList", values, { source: "write" });
          return { success: true, removed: true, recovered: true };
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Abmeldung ist weiterhin unklar", 503, {
          operationId: params.operationId,
          recordId,
          phase: "delete",
        });
      }
      const targetRow = values.slice(1).find((row) =>
        String(row[competitionIndex] || "").trim() === params.bewerbId &&
        String(row[personIndex] || "").trim() === principal.id);
      if (!targetRow) {
        dataStore.set("entryList", values, { source: "write" });
        return { success: true, removed: false };
      }
      const recordId = String(targetRow[idIndex] || "").trim();
      const { metadata, row, sheets } = await this.resolveStableRow("entryList", recordId, values);
      if (
        String(row[competitionIndex] || "").trim() !== params.bewerbId
        || String(row[personIndex] || "").trim() !== principal.id
      ) {
        throw new AppError("WRITE_CONFLICT", "EntryList-Datensatz wurde zwischenzeitlich geaendert", 409);
      }
      try {
        const response = await sheets.spreadsheets.values.batchClearByDataFilter({
          spreadsheetId: SHEET_ID,
          requestBody: { dataFilters: [{ developerMetadataLookup: { metadataId: metadata.metadataId } }] },
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
        if ((response.data.clearedRanges || []).length !== 1) throw new Error("Metadaten-Clear hat keine eindeutige Zeile aktualisiert");
        try {
          await this.deleteRecordMetadata(sheets, "entryList", recordId, metadata.metadataId);
        } catch (metadataError) {
          this.recordMetadata.delete(`entryList:${recordId}`);
          console.warn("sheetService: Verwaiste EntryList-Metadaten konnten nicht entfernt werden:", metadataError.message);
        }
      } catch (error) {
        try {
          const confirmationRow = await this.readMetadataRow(sheets, metadata.metadataId);
          if (!confirmationRow || !confirmationRow.some((value) => String(value || "").trim())) {
            try {
              await this.deleteRecordMetadata(sheets, "entryList", recordId, metadata.metadataId);
            } catch {
              this.recordMetadata.delete(`entryList:${recordId}`);
            }
            const confirmation = await this.readTable("entryList");
            const confirmationHeader = headerOf(confirmation);
            const confirmationIdIndex = headerIndex(confirmationHeader, "id");
            const stillPresent = confirmation.slice(1).some((entry) => String(entry[confirmationIdIndex] || "").trim() === recordId);
            if (!stillPresent) {
              dataStore.set("entryList", confirmation, { source: "write" });
              return { success: true, removed: true, recovered: true };
            }
          }
        } catch (confirmationError) {
          console.error("sheetService: EntryList-Delete-Bestaetigungsread fehlgeschlagen:", confirmationError.message);
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Abmeldung ist unklar", 503, {
          operationId: params.operationId,
          recordId,
          phase: "delete",
        });
      }
      await this.refreshCache("entryList", (cached) => {
        const cachedHeader = headerOf(cached);
        const cachedIdIndex = headerIndex(cachedHeader, "id");
        return [cached[0], ...cached.slice(1).filter((entry) => String(entry[cachedIdIndex] || "").trim() !== recordId)];
      });
      return { success: true, removed: true };
    }));
  }

  async withdrawFromRanking(principal, params) {
    const payload = { reason: params.reason, rank: params.rank, bewerbId: params.bewerbId };
    return this.runIdempotent(principal, "withdrawFromRanking", params.operationId, payload, ({ recoveryOnly }) => this.enqueue("logging", async () => {
      if (recoveryOnly) {
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Logging-Write ist weiterhin unklar", 503, {
          operationId: params.operationId,
        });
      }
      const sheets = await this.getClient();
      this.assertRankingMembership(principal, params.bewerbId, params.rank);
      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: "Logging",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[
            viennaTimestamp(true),
            "withdrawFromRanking",
            `Rückzug: ${principal.name} (Rang ${params.rank}, Bewerb ${params.bewerbId}) — ${params.reason}`,
          ]] },
        });
      } catch (error) {
        throw new AppError("WRITE_OUTCOME_UNKNOWN", `Ausgang des Logging-Writes ist unklar: ${error.message}`, 503, {
          operationId: params.operationId,
        });
      }
      return { success: true };
    }));
  }

  async stop() {
    this.stopping = true;
    await Promise.allSettled([...this.active]);
  }

  status() {
    return {
      stopping: this.stopping,
      activeWrites: this.active.size,
      queues: this.queues.size,
      pendingMetadataIntents: this.repository.countPendingMetadataIntents(),
    };
  }
}

module.exports = { SheetService, viennaTimestamp };
