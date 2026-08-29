const crypto = require("crypto");
const { google } = require("googleapis");
const { GOOGLE_REQUEST_TIMEOUT_MS, SHEET_ID, TABLE_CONFIG } = require("./config.js");
const dataStore = require("./dataStore.js");
const dataPoller = require("./dataPoller.js");
const { AppError } = require("./errors.js");
const { analyzeMatchRules } = require("./matchRules.js");
const {
  FIELD_DEFINITIONS,
  fieldIndexes,
  personFingerprint,
  projectPeopleNormalization,
  rawPersonValues,
  validateChanges,
} = require("./peopleNormalization.js");
const {
  assertUniqueExternalId,
  assertUpdateCandidate,
  projectPeopleReconciliation,
  reconciliationFingerprint,
  validateReconciliationRequest,
} = require("./memberReconciliation.js");
const { headerIndex, headerOf } = require("./tableUtils.js");
const { assertPlayerLoginConflictsNotWorsened, validateTableValues } = require("./tableSchemas.js");
const logger = require("./logger.js");
const { acquireSheetTableActivity, executeSheetRead, getSheetReadStatus, rateLimitError } = require("./sheetsReadCoordinator.js");

const RECORD_METADATA_KEY = "epiberRecord";
const WRITE_REFRESH_DELAY_MS = 1000;

function withAudit(result, audit) {
  Object.defineProperty(result, "_audit", { value: audit, enumerable: false });
  return result;
}

function reconciliationAuditValues(fields, values, marker) {
  return Object.fromEntries(fields.map((field) => [
    field,
    ["active", "role"].includes(field) ? String(values[field] ?? "") : marker,
  ]));
}

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
  constructor({ repository, clientFactory = null, now = Date.now, refreshDelayMs = process.env.NODE_ENV === "test" ? 60000 : WRITE_REFRESH_DELAY_MS } = {}) {
    this.repository = repository;
    this.clientFactory = clientFactory;
    this.client = null;
    this.queues = new Map();
    this.active = new Set();
    this.stopping = false;
    this.now = now;
    this.refreshDelayMs = refreshDelayMs;
    this.sheetIds = new Map();
    this.sheetIdsLoad = null;
    this.recordMetadata = new Map();
    this.recordMetadataScanned = false;
    this.recordMetadataLoad = null;
    this.recordMetadataUnresolved = new Set();
    this.refreshTimers = new Map();
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
    const activity = Object.hasOwn(TABLE_CONFIG, key) ? acquireSheetTableActivity(key) : Promise.resolve(null);
    const operation = Promise.all([previous.catch(() => {}), activity]).then(async ([, release]) => {
      try {
        return await callback();
      } finally {
        release?.();
      }
    });
    this.queues.set(key, operation);
    this.active.add(operation);
    operation.finally(() => {
      this.active.delete(operation);
      if (this.queues.get(key) === operation) this.queues.delete(key);
    }).catch(() => {});
    return operation;
  }

  async readTable(tableName, purpose = "write_precondition") {
    const config = TABLE_CONFIG[tableName];
    if (!config) throw new AppError("TABLE_UNKNOWN", `Tabelle ${tableName} ist unbekannt`, 500);
    const sheets = await this.getClient();
    const response = await executeSheetRead({
      method: "values_get",
      purpose,
      call: (options) => sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: config.range }, options),
    });
    return validateTableValues(tableName, response.data.values || []);
  }

  async getSheetId(sheets, tableName) {
    if (this.sheetIds.has(tableName)) return this.sheetIds.get(tableName);
    const title = TABLE_CONFIG[tableName].range;
    if (!this.sheetIdsLoad) {
      this.sheetIdsLoad = (async () => {
        const spreadsheet = await executeSheetRead({
          method: "spreadsheet_get",
          purpose: "sheet_properties",
          call: (options) => sheets.spreadsheets.get({
            spreadsheetId: SHEET_ID,
            fields: "sheets.properties(sheetId,title)",
          }, options),
        });
        const tableByTitle = new Map(Object.entries(TABLE_CONFIG).map(([name, config]) => [config.range, name]));
        for (const sheet of spreadsheet.data.sheets || []) {
          const knownTable = tableByTitle.get(sheet.properties?.title);
          if (knownTable) this.sheetIds.set(knownTable, sheet.properties.sheetId);
        }
      })().finally(() => { this.sheetIdsLoad = null; });
    }
    await this.sheetIdsLoad;
    if (!this.sheetIds.has(tableName)) throw new AppError("SHEET_SCHEMA", `${title}-Tab fehlt`, 503);
    return this.sheetIds.get(tableName);
  }

  async loadRecordMetadata(sheets) {
    if (this.recordMetadataScanned) return;
    if (!this.recordMetadataLoad) {
      this.recordMetadataLoad = (async () => {
        const response = await executeSheetRead({
          method: "metadata_search",
          purpose: "metadata_search",
          call: (options) => sheets.spreadsheets.developerMetadata.search({
            spreadsheetId: SHEET_ID,
            requestBody: {
              dataFilters: [{ developerMetadataLookup: {
                metadataKey: RECORD_METADATA_KEY,
                visibility: "DOCUMENT",
                locationType: "ROW",
              } }],
            },
          }, options),
        });
        const grouped = new Map();
        for (const match of response.data.matchedDeveloperMetadata || []) {
          const metadata = match.developerMetadata;
          const cacheKey = String(metadata?.metadataValue || "");
          if (!metadata || !Object.keys(TABLE_CONFIG).some((name) => cacheKey.startsWith(`${name}:`))) continue;
          if (!grouped.has(cacheKey)) grouped.set(cacheKey, []);
          grouped.get(cacheKey).push(metadata);
        }
        for (const [cacheKey, matches] of grouped) {
          if (matches.length === 1) this.recordMetadata.set(cacheKey, matches[0]);
          else this.recordMetadataUnresolved.add(cacheKey);
        }
        this.recordMetadataScanned = true;
      })().finally(() => { this.recordMetadataLoad = null; });
    }
    await this.recordMetadataLoad;
  }

  async findRecordMetadata(sheets, tableName, recordId) {
    const cacheKey = `${tableName}:${recordId}`;
    const previouslyScanned = this.recordMetadataScanned;
    await this.loadRecordMetadata(sheets);
    if (this.recordMetadata.has(cacheKey)) {
      const metadata = this.recordMetadata.get(cacheKey);
      this.confirmRecordMetadataIntent(cacheKey, metadata);
      return metadata;
    }
    if (!previouslyScanned && !this.recordMetadataUnresolved.has(cacheKey)) return null;
    const response = await executeSheetRead({
      method: "metadata_search",
      purpose: "metadata_search",
      call: (options) => sheets.spreadsheets.developerMetadata.search({
        spreadsheetId: SHEET_ID,
        requestBody: {
          dataFilters: [{ developerMetadataLookup: {
            metadataKey: RECORD_METADATA_KEY,
            metadataValue: cacheKey,
            visibility: "DOCUMENT",
            locationType: "ROW",
          } }],
        },
      }, options),
    });
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
        logger.log("warn", "sheet_metadata_duplicate_cleanup_failed", { table: tableName, recordId, duplicateCount: duplicates.length, error });
      }
      matches = [keep];
    }
    const metadata = matches[0] || null;
    if (metadata) {
      this.recordMetadata.set(cacheKey, metadata);
      this.recordMetadataUnresolved.delete(cacheKey);
      this.confirmRecordMetadataIntent(cacheKey, metadata);
    }
    return metadata;
  }

  confirmRecordMetadataIntent(cacheKey, metadata) {
    const intentKey = `record-metadata-intent:${cacheKey}`;
    const intent = this.repository.getState(intentKey, { status: "none" });
    if (["none", "confirmed"].includes(intent.value.status)) return;
    this.repository.setState(intentKey, { status: "confirmed", metadataId: metadata.metadataId, at: this.now() }, intent.revision);
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
        logger.log("error", "sheet_metadata_confirmation_read_failed", { table: tableName, recordId, error: confirmationError });
      }
      if (!metadata) {
        const status = Number(error?.response?.status || error?.status || 0);
        if (status >= 400 && status < 500 && status !== 408) {
          const pending = this.repository.getState(intentKey, { status: "pending" });
          this.repository.setState(intentKey, { status: "failed", at: this.now(), statusCode: status }, pending.revision);
          if (status === 429) throw rateLimitError();
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

  async readMetadataRow(sheets, metadataId, valueRenderOption = "FORMULA", purpose = "metadata_row") {
    const response = await executeSheetRead({
      method: "metadata_row",
      purpose,
      call: (options) => sheets.spreadsheets.values.batchGetByDataFilter({
        spreadsheetId: SHEET_ID,
        requestBody: {
          dataFilters: [{ developerMetadataLookup: { metadataId } }],
          majorDimension: "ROWS",
          valueRenderOption,
        },
      }, options),
    });
    const rows = (response.data.valueRanges || []).flatMap((entry) => entry.valueRange?.values || []);
    return rows.length === 1 ? rows[0] : null;
  }

  async resolveStableRow(tableName, recordId, initialValues = null, valueRenderOption = "FORMULA") {
    const sheets = await this.getClient();
    let values = initialValues || await this.readTable(tableName);
    for (let attempt = 0; attempt < 3; attempt++) {
      const header = headerOf(values);
      const idIndex = headerIndex(header, "id");
      const offset = values.slice(1).findIndex((row) => String(row[idIndex] || "").trim() === recordId);
      if (offset < 0) throw new AppError("RECORD_NOT_FOUND", "Datensatz wurde nicht gefunden", 404);
      let metadata = await this.findRecordMetadata(sheets, tableName, recordId);
      if (!metadata) metadata = await this.createRecordMetadata(sheets, tableName, recordId, offset + 1);
      const row = await this.readMetadataRow(sheets, metadata.metadataId, valueRenderOption);
      if (row && String(row[idIndex] || "").trim() === recordId) return { sheets, metadata, row, header };
      await this.deleteRecordMetadata(sheets, tableName, recordId, metadata.metadataId);
      values = await this.readTable(tableName);
    }
    throw new AppError("WRITE_CONFLICT", "Datensatz wurde waehrend der Aktualisierung verschoben", 409);
  }

  async refreshCache(tableName, fallback) {
    try {
      const fresh = await this.readTable(tableName, "write_refresh");
      dataStore.set(tableName, fresh, { source: "write-refresh" });
      return fresh;
    } catch (error) {
      logger.log("error", "sheet_cache_refresh_failed", { table: tableName, error });
      return fallback(structuredClone(dataStore.get(tableName)));
    }
  }

  cancelScheduledRefresh(tableName) {
    const timer = this.refreshTimers.get(tableName);
    if (timer) clearTimeout(timer);
    this.refreshTimers.delete(tableName);
  }

  scheduleRefresh(tableName) {
    this.cancelScheduledRefresh(tableName);
    const timer = setTimeout(() => {
      this.refreshTimers.delete(tableName);
      this.enqueue(tableName, () => this.refreshCache(tableName, (cached) => cached)).catch((error) => {
        if (error.code !== "SHUTTING_DOWN") logger.log("error", "sheet_scheduled_refresh_failed", { table: tableName, error });
      });
    }, this.refreshDelayMs);
    timer.unref?.();
    this.refreshTimers.set(tableName, timer);
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

  async reconcilePerson(principal, params) {
    const { operationId, ...rawRequest } = params;
    const request = validateReconciliationRequest(rawRequest);
    return this.runIdempotent(principal, "reconcilePerson", operationId, request, ({ recoveryOnly, recoveryDetails }) => this.enqueue("players", async () => {
      this.cancelScheduledRefresh("players");
      const values = await this.readTable("players");
      dataStore.set("players", values, { source: "write-read" });
      const header = headerOf(values);
      const idIndex = headerIndex(header, "id");
      const externalIdIndex = headerIndex(header, "cd-id");
      if (idIndex < 0 || externalIdIndex < 0) throw new AppError("SHEET_SCHEMA", "Personen-Spalten ID oder CD-ID fehlen", 503);
      const projection = projectPeopleReconciliation(values);

      if (request.action === "create") {
        const existingIds = values.slice(1).map((row) => String(row[idIndex] || "").trim()).filter(Boolean);
        if (existingIds.some((id) => !/^\d+$/.test(id))) {
          throw new AppError("SHEET_SCHEMA", "Personen-IDs muessen fuer Neuanlagen numerisch sein", 503);
        }
        const recoveryPersonId = String(recoveryDetails?.personId || recoveryDetails?.recordId || "");
        const newPersonId = recoveryOnly
          ? recoveryPersonId
          : (existingIds.reduce((max, id) => {
            const value = BigInt(id);
            return value > max ? value : max;
          }, 0n) + 1n).toString();
        if (newPersonId.length > 64) throw new AppError("SHEET_SCHEMA", "Naechste Personen-ID ist zu lang", 503);
        if (!newPersonId) {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Neuanlage ist noch nicht nachweisbar", 503, { externalId: request.externalId });
        }
        assertUniqueExternalId(projection.people, request.externalId, recoveryOnly ? newPersonId : "");
        const existingRowOffset = values.slice(1).findIndex((row) => (
          String(row[idIndex] || "").trim() === newPersonId
          && String(row[externalIdIndex] || "").trim() === request.externalId
        ));
        if (recoveryOnly && existingRowOffset < 0) {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Neuanlage ist noch nicht nachweisbar", 503, {
            personId: newPersonId,
            externalId: request.externalId,
          });
        }

        const indexes = fieldIndexes(header);
        for (const field of Object.keys(FIELD_DEFINITIONS)) {
          if (indexes[field] < 0) throw new AppError("SHEET_SCHEMA", `Personen-Spalte fuer ${field} fehlt`, 503);
        }
        const controlledValues = Object.fromEntries(Object.keys(FIELD_DEFINITIONS).map((field) => [field, request.values[field] || ""]));
        let newRow = existingRowOffset >= 0 ? values[existingRowOffset + 1] : null;
        if (newRow && Object.entries(controlledValues).some(([field, value]) => String(newRow[indexes[field]] ?? "") !== value)) {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Neuanlage stimmt nicht mit dem bestaetigten Zielstand ueberein", 503, {
            personId: newPersonId,
            externalId: request.externalId,
          });
        }
        const sheets = await this.getClient();
        let refreshed = values;
        let confirmedRowOffset = existingRowOffset;
        if (!newRow) {
          newRow = Array(header.length).fill("");
          newRow[idIndex] = newPersonId;
          newRow[externalIdIndex] = request.externalId;
          for (const [field, value] of Object.entries(controlledValues)) newRow[indexes[field]] = value;
          const candidate = structuredClone(values);
          candidate.push(newRow);
          validateTableValues("players", candidate);
          assertPlayerLoginConflictsNotWorsened(values, candidate);
          let appendError = null;
          try {
            await sheets.spreadsheets.values.append({
              spreadsheetId: SHEET_ID,
              range: TABLE_CONFIG.players.range,
              valueInputOption: "RAW",
              requestBody: { values: [newRow] },
            }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
          } catch (error) {
            appendError = error;
          }
          try {
            refreshed = await this.readTable("players", "confirmation");
            confirmedRowOffset = refreshed.slice(1).findIndex((row) => (
              String(row[idIndex] || "").trim() === newPersonId
              && String(row[externalIdIndex] || "").trim() === request.externalId
            ));
            if (confirmedRowOffset < 0) throw appendError || new Error("Angehaengte Personenzeile fehlt");
            newRow = refreshed[confirmedRowOffset + 1];
            if (Object.entries(controlledValues).some(([field, value]) => String(newRow[indexes[field]] ?? "") !== value)) {
              throw appendError || new Error("Angehaengte Personenzeile weicht ab");
            }
            validateTableValues("players", refreshed);
            assertPlayerLoginConflictsNotWorsened(values, refreshed);
            assertUniqueExternalId(projectPeopleReconciliation(refreshed).people, request.externalId, newPersonId);
          } catch {
            throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Personenneuanlage ist unklar", 503, {
              personId: newPersonId,
              externalId: request.externalId,
            });
          }
        }

        const rowIndex = confirmedRowOffset + 1;
        let metadata;
        try {
          metadata = await this.findRecordMetadata(sheets, "players", newPersonId);
          if (!metadata) metadata = await this.createRecordMetadata(sheets, "players", newPersonId, rowIndex);
          if (!metadata?.metadataId) throw new Error("Metadaten-ID fehlt");
        } catch {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Metadaten der neuen Person sind unklar", 503, {
            personId: newPersonId,
            externalId: request.externalId,
          });
        }
        dataStore.set("players", refreshed, { source: "write-local", authoritative: false });
        this.scheduleRefresh("players");
        const afterProjection = projectPeopleReconciliation(refreshed).people.find((person) => person.id === newPersonId);
        return withAudit({
          success: true,
          action: "create",
          personId: newPersonId,
          fingerprint: afterProjection?.fingerprint || reconciliationFingerprint(controlledValues, request.externalId),
          recovered: recoveryOnly || undefined,
        }, {
          targetName: [controlledValues.firstName, controlledValues.lastName].filter(Boolean).join(" "),
          before: null,
          after: reconciliationAuditValues(["externalId", ...Object.keys(request.values)], { externalId: request.externalId, ...request.values }, "gesetzt"),
        });
      }

      let stable;
      try {
        stable = await this.resolveStableRow("players", request.personId, values, "FORMATTED_VALUE");
      } catch (error) {
        if (error.code === "RECORD_NOT_FOUND") throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
        throw error;
      }
      const { metadata, row, sheets } = stable;
      const beforeValues = rawPersonValues(header, row);
      const beforeExternalId = String(row[externalIdIndex] || "").trim();
      const currentFingerprint = reconciliationFingerprint(beforeValues, beforeExternalId);
      if (currentFingerprint !== request.expectedFingerprint && !recoveryOnly) {
        throw new AppError("PERSON_CONFLICT", "Personendaten wurden zwischenzeitlich geaendert", 409, {
          personId: request.personId,
          currentFingerprint,
        });
      }

      let targetExternalId = beforeExternalId;
      let changes;
      if (request.action === "deactivate") {
        const role = String(beforeValues.role || "").trim().toLowerCase();
        if (["admin", "operator"].includes(role)) {
          throw new AppError("ROLE_PROTECTED", "Admin und Operator duerfen nicht durch den Mitgliederabgleich deaktiviert werden", 409);
        }
        changes = { active: "" };
      } else {
        const currentPerson = { id: request.personId, externalId: beforeExternalId };
        if (!recoveryOnly) assertUpdateCandidate(currentPerson, request);
        if (!recoveryOnly && beforeExternalId && beforeExternalId !== request.externalId) {
          throw new AppError("EXTERNAL_ID_CONFLICT", "Eine bestehende CD-ID darf nicht neu zugeordnet werden", 409);
        }
        assertUniqueExternalId(projection.people, request.externalId, request.personId);
        targetExternalId = request.externalId;
        changes = request.changes;
        const currentRole = String(beforeValues.role || "").trim().toLowerCase();
        if (["admin", "operator"].includes(currentRole) && Object.hasOwn(changes, "role") && changes.role.toLowerCase() !== currentRole) {
          throw new AppError("ROLE_PROTECTED", "Admin- und Operatorrollen duerfen nicht aus Importdaten geaendert werden", 409);
        }
      }

      const indexes = fieldIndexes(header);
      for (const field of Object.keys(changes)) {
        if (indexes[field] < 0) throw new AppError("SHEET_SCHEMA", `Personen-Spalte fuer ${field} fehlt`, 503);
      }
      const targetsMatch = String(row[externalIdIndex] || "").trim() === targetExternalId
        && Object.entries(changes).every(([field, value]) => String(row[indexes[field]] ?? "") === value);
      if (recoveryOnly && !targetsMatch) {
        if (["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) this.repository.revokeUserSessions(request.personId);
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang des Mitgliederabgleichs ist weiterhin unklar", 503, { personId: request.personId });
      }
      if (targetsMatch) {
        if (recoveryOnly && ["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) {
          this.repository.revokeUserSessions(request.personId);
        }
        return withAudit({ success: true, action: request.action, personId: request.personId, fingerprint: currentFingerprint, repeated: true }, {
          targetName: [beforeValues.firstName, beforeValues.lastName].map((value) => String(value || "").trim()).filter(Boolean).join(" "),
          before: null,
          after: null,
        });
      }

      const candidate = structuredClone(values);
      const candidateRow = candidate.slice(1).find((entry) => String(entry[idIndex] || "").trim() === request.personId);
      if (!candidateRow) throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
      candidateRow[externalIdIndex] = targetExternalId;
      for (const [field, value] of Object.entries(changes)) candidateRow[indexes[field]] = value;
      validateTableValues("players", candidate);
      assertPlayerLoginConflictsNotWorsened(values, candidate);
      if (targetExternalId) assertUniqueExternalId(projectPeopleReconciliation(candidate).people, targetExternalId, request.personId);

      const maxIndex = Math.max(externalIdIndex, ...Object.keys(changes).map((field) => indexes[field]));
      const updates = Array(maxIndex + 1).fill(null);
      updates[externalIdIndex] = targetExternalId;
      for (const [field, value] of Object.entries(changes)) updates[indexes[field]] = value;
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
          const confirmationRow = await this.readMetadataRow(sheets, metadata.metadataId, "FORMATTED_VALUE", "confirmation");
          const confirmed = confirmationRow
            && String(confirmationRow[externalIdIndex] || "").trim() === targetExternalId
            && Object.entries(changes).every(([field, value]) => String(confirmationRow[indexes[field]] ?? "") === value);
          if (!confirmed) throw error;
        } catch {
          if (["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) this.repository.revokeUserSessions(request.personId);
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang des Mitgliederabgleichs ist unklar", 503, { personId: request.personId });
        }
      }

      dataStore.set("players", candidate, { source: "write-local", authoritative: false });
      this.scheduleRefresh("players");
      if (["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) this.repository.revokeUserSessions(request.personId);
      const afterProjection = projectPeopleReconciliation(candidate).people.find((person) => person.id === request.personId);
      const changedExternalId = beforeExternalId !== targetExternalId;
      return withAudit({
        success: true,
        action: request.action,
        personId: request.personId,
        fingerprint: afterProjection?.fingerprint || "",
      }, {
        targetName: [afterProjection?.values.firstName, afterProjection?.values.lastName].map((value) => String(value || "").trim()).filter(Boolean).join(" "),
        before: reconciliationAuditValues(
          [...(changedExternalId ? ["externalId"] : []), ...Object.keys(changes)],
          { externalId: beforeExternalId, ...beforeValues },
          "vorher",
        ),
        after: reconciliationAuditValues(
          [...(changedExternalId ? ["externalId"] : []), ...Object.keys(changes)],
          { externalId: targetExternalId, ...changes },
          "nachher",
        ),
      });
    }));
  }

  async normalizePerson(principal, params) {
    const changes = validateChanges(params.changes);
    const payload = {
      personId: params.personId,
      expectedFingerprint: params.expectedFingerprint,
      changes,
    };
    return this.runIdempotent(principal, "normalizePerson", params.operationId, payload, ({ recoveryOnly }) => this.enqueue("players", async () => {
      this.cancelScheduledRefresh("players");
      const values = await this.readTable("players");
      dataStore.set("players", values, { source: "write-read" });
      let stable;
      try {
        stable = await this.resolveStableRow("players", params.personId, values, "FORMATTED_VALUE");
      } catch (error) {
        if (error.code === "RECORD_NOT_FOUND") throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
        throw error;
      }
      const { header, metadata, row, sheets } = stable;
      const idIndex = headerIndex(header, "id");
      if (!row || String(row[idIndex] || "").trim() !== params.personId) {
        throw new AppError("WRITE_CONFLICT", "Person wurde waehrend der Aktualisierung verschoben", 409);
      }
      const indexes = fieldIndexes(header);
      const beforeValues = rawPersonValues(header, row);
      const currentFingerprint = personFingerprint(beforeValues);
      const targetsMatch = Object.entries(changes).every(([field, value]) => indexes[field] >= 0 && String(row[indexes[field]] ?? "") === value);

      if (recoveryOnly) {
        if (!targetsMatch) {
          if (["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) this.repository.revokeUserSessions(params.personId);
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Personenaenderung ist weiterhin unklar", 503, { personId: params.personId });
        }
        const refreshed = values;
        if (["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) this.repository.revokeUserSessions(params.personId);
        const projected = projectPeopleNormalization(refreshed).people.find((person) => person.id === params.personId);
        return withAudit({ success: true, personId: params.personId, fingerprint: projected?.fingerprint || "", recovered: true }, {
          targetName: [projected?.values.firstName, projected?.values.lastName].map((value) => String(value || "").trim()).filter(Boolean).join(" "),
          before: null,
          after: changes,
        });
      }

      if (currentFingerprint !== params.expectedFingerprint) {
        throw new AppError("PERSON_CONFLICT", "Personendaten wurden zwischenzeitlich geaendert", 409, {
          personId: params.personId,
          currentFingerprint,
        });
      }
      for (const field of Object.keys(changes)) {
        if (indexes[field] < 0) throw new AppError("SHEET_SCHEMA", `Personen-Spalte fuer ${field} fehlt`, 503);
      }
      if (targetsMatch) {
        return withAudit({ success: true, personId: params.personId, fingerprint: currentFingerprint, repeated: true }, {
          targetName: [beforeValues.firstName, beforeValues.lastName].map((value) => String(value || "").trim()).filter(Boolean).join(" "),
          before: Object.fromEntries(Object.keys(changes).map((field) => [field, beforeValues[field]])),
          after: changes,
        });
      }

      const candidate = structuredClone(values);
      const candidateRow = candidate.slice(1).find((entry) => String(entry[idIndex] || "").trim() === params.personId);
      if (!candidateRow) throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
      for (const [field, value] of Object.entries(changes)) candidateRow[indexes[field]] = value;

      const roleIndex = headerIndex(header, "role");
      const activeIndex = headerIndex(header, "aktiv");
      const currentRole = String(row[roleIndex] || "").trim().toLowerCase();
      const targetRole = String(candidateRow[roleIndex] || "").trim().toLowerCase();
      const targetActive = String(candidateRow[activeIndex] || "").trim();
      if (params.personId === principal.id && currentRole === "admin" && (targetRole !== "admin" || targetActive !== "1")) {
        throw new AppError("ADMIN_SELF_PROTECTION", "Die eigene aktive Adminrolle darf nicht entfernt werden", 409);
      }
      const activeAdminCount = candidate.slice(1).filter((entry) => (
        String(entry[roleIndex] || "").trim().toLowerCase() === "admin"
        && String(entry[activeIndex] || "").trim() === "1"
      )).length;
      if (!activeAdminCount) throw new AppError("LAST_ADMIN_PROTECTION", "Mindestens ein aktiver Admin muss erhalten bleiben", 409);

      try {
        validateTableValues("players", candidate);
        assertPlayerLoginConflictsNotWorsened(values, candidate);
      } catch (error) {
        throw error;
      }

      const maxIndex = Math.max(...Object.keys(changes).map((field) => indexes[field]));
      const updates = Array(maxIndex + 1).fill(null);
      for (const [field, value] of Object.entries(changes)) updates[indexes[field]] = value;
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
          const confirmationRow = await this.readMetadataRow(sheets, metadata.metadataId, "FORMATTED_VALUE", "confirmation");
          const confirmed = confirmationRow && Object.entries(changes).every(([field, value]) => String(confirmationRow[indexes[field]] ?? "") === value);
          if (!confirmed) throw error;
        } catch {
          if (["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) this.repository.revokeUserSessions(params.personId);
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Personenaenderung ist unklar", 503, { personId: params.personId });
        }
      }

      const refreshed = candidate;
      dataStore.set("players", refreshed, { source: "write-local", authoritative: false });
      this.scheduleRefresh("players");
      if (["login", "active", "role"].some((field) => Object.hasOwn(changes, field))) this.repository.revokeUserSessions(params.personId);
      const projected = projectPeopleNormalization(refreshed).people.find((person) => person.id === params.personId);
      return withAudit({ success: true, personId: params.personId, fingerprint: projected?.fingerprint || "" }, {
        targetName: [projected?.values.firstName, projected?.values.lastName].map((value) => String(value || "").trim()).filter(Boolean).join(" "),
        before: Object.fromEntries(Object.keys(changes).map((field) => [field, beforeValues[field]])),
        after: changes,
      });
    }));
  }

  async setPasswordHash(personId, storedHash, { expectedHash, requirePasswordSetupAllowed = false } = {}) {
    return this.enqueue("players", async () => {
      this.cancelScheduledRefresh("players");
      const values = await this.readTable("players");
      dataStore.set("players", values, { source: "write-read" });
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
          const confirmationRow = await this.readMetadataRow(sheets, metadata.metadataId, "FORMULA", "confirmation");
          if (confirmationRow && String(confirmationRow[passwordIndex] || "").trim() === storedHash) {
            const candidate = structuredClone(values);
            const candidateRow = candidate.slice(1).find((entry) => String(entry[headerIndex(headerOf(candidate), "id")] || "").trim() === personId);
            if (candidateRow) {
              candidateRow[passwordIndex] = storedHash;
              if (resetIndex >= 0) candidateRow[resetIndex] = "";
            }
            dataStore.set("players", candidate, { source: "write-local", authoritative: false });
            this.scheduleRefresh("players");
            return { success: true, recovered: true };
          }
        } catch (confirmationError) {
          logger.log("error", "sheet_password_confirmation_read_failed", { error: confirmationError });
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Passwortaenderung ist unklar", 503, { personId });
      }
      const candidate = structuredClone(values);
      const candidateRow = candidate.slice(1).find((entry) => String(entry[headerIndex(headerOf(candidate), "id")] || "").trim() === personId);
      if (candidateRow) {
        candidateRow[passwordIndex] = storedHash;
        if (resetIndex >= 0) candidateRow[resetIndex] = "";
      }
      dataStore.set("players", candidate, { source: "write-local", authoritative: false });
      this.scheduleRefresh("players");
      return { success: true };
    });
  }

  async setPasswordSetupAllowed(personId, allowed) {
    return this.enqueue("players", async () => {
      this.cancelScheduledRefresh("players");
      const values = await this.readTable("players");
      dataStore.set("players", values, { source: "write-read" });
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
          const confirmationRow = await this.readMetadataRow(sheets, metadata.metadataId, "FORMULA", "confirmation");
          if (!confirmationRow || String(confirmationRow[setupIndex] || "").trim().toLowerCase() !== marker) throw error;
        } catch {
          throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Passwortfreigabe ist unklar", 503, { personId });
        }
      }
      const candidate = structuredClone(values);
      const candidateRow = candidate.slice(1).find((entry) => String(entry[headerIndex(headerOf(candidate), "id")] || "").trim() === personId);
      if (candidateRow) candidateRow[setupIndex] = marker;
      dataStore.set("players", candidate, { source: "write-local", authoritative: false });
      this.scheduleRefresh("players");
      return { success: true };
    });
  }

  async addMatch(principal, params) {
    const payload = { bewerbId: params.bewerbId, opponentId: params.opponentId };
    return this.runIdempotent(principal, "addMatch", params.operationId, payload, ({ recoveryOnly }) => this.enqueue("matches1", async () => {
      if (params.opponentId === principal.id) throw new AppError("MATCH_SELF", "Ein Spieler kann sich nicht selbst fordern");
      this.cancelScheduledRefresh("matches1");
      const values = await this.readTable("matches1");
      dataStore.set("matches1", values, { source: "write-read" });
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
        spieler1id: principal.id,
        spieler3id: params.opponentId,
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
          const confirmation = await this.readTable("matches1", "confirmation");
          if (confirmation.slice(1).some((row) => String(row[idIndex] || "").trim() === newId)) {
            dataStore.set("matches1", confirmation, { source: "write" });
            return { success: true, newMatchId: newId, recovered: true };
          }
        } catch (confirmationError) {
          logger.log("error", "sheet_match_confirmation_read_failed", { recordId: newId, error: confirmationError });
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Match-Erstellung ist unklar", 503, { operationId: params.operationId, recordId: newId });
      }
      const candidate = structuredClone(values);
      candidate.push(newRow);
      dataStore.set("matches1", candidate, { source: "write-local", authoritative: false });
      this.scheduleRefresh("matches1");
      return { success: true, newMatchId: newId };
    }));
  }

  async addEntry(principal, params) {
    const payload = { bewerbId: params.bewerbId };
    return this.runIdempotent(principal, "addEntryList", params.operationId, payload, ({ recoveryOnly }) => this.enqueue("entryList", async () => {
      this.cancelScheduledRefresh("entryList");
      const values = await this.readTable("entryList");
      dataStore.set("entryList", values, { source: "write-read" });
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
          const confirmation = await this.readTable("entryList", "confirmation");
          if (confirmation.slice(1).some((row) => String(row[idIndex] || "").trim() === newId)) {
            dataStore.set("entryList", confirmation, { source: "write" });
            return { success: true, entryId: newId, recovered: true };
          }
        } catch (confirmationError) {
          logger.log("error", "sheet_entry_confirmation_read_failed", { recordId: newId, error: confirmationError });
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Anmeldung ist unklar", 503, { operationId: params.operationId, recordId: newId });
      }
      const candidate = structuredClone(values);
      candidate.push(newRow);
      dataStore.set("entryList", candidate, { source: "write-local", authoritative: false });
      this.scheduleRefresh("entryList");
      return { success: true, entryId: newId };
    }));
  }

  async removeEntry(principal, params) {
    const payload = { bewerbId: params.bewerbId };
    return this.runIdempotent(principal, "removeEntryList", params.operationId, payload, ({ recoveryOnly, recoveryDetails }) => this.enqueue("entryList", async () => {
      this.cancelScheduledRefresh("entryList");
      const values = await this.readTable("entryList");
      dataStore.set("entryList", values, { source: "write-read" });
      const header = headerOf(values);
      const idIndex = headerIndex(header, "id");
      const competitionIndex = headerIndex(header, "bewerbid", "bewerb id");
      const personIndex = headerIndex(header, "personenid", "personen id", "personid", "playerid", "spielerid");
      if (idIndex < 0 || competitionIndex < 0 || personIndex < 0) throw new AppError("SHEET_SCHEMA", "EntryList-Spalten fehlen", 500);
      if (recoveryOnly && recoveryDetails?.phase === "delete") {
        const recordId = String(recoveryDetails?.recordId || "").trim();
        if (recordId && !values.slice(1).some((row) => String(row[idIndex] || "").trim() === recordId)) {
          dataStore.set("entryList", values, { source: "write" });
          return withAudit({ success: true, removed: true, recovered: true }, { before: recoveryDetails.tombstone || null, after: null });
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Abmeldung ist weiterhin unklar", 503, {
          operationId: params.operationId,
          recordId,
          phase: "delete",
          tombstone: recoveryDetails?.tombstone || null,
        });
      }
      const targetRow = values.slice(1).find((row) =>
        String(row[competitionIndex] || "").trim() === params.bewerbId &&
        String(row[personIndex] || "").trim() === principal.id);
      if (!targetRow) {
        return withAudit({ success: true, removed: false }, { before: null, after: null });
      }
      const recordId = String(targetRow[idIndex] || "").trim();
      const entryDateIndex = headerIndex(header, "entrydate");
      const tombstone = {
        recordId,
        bewerbId: String(targetRow[competitionIndex] || "").trim(),
        personId: String(targetRow[personIndex] || "").trim(),
        entryDate: entryDateIndex < 0 ? "" : String(targetRow[entryDateIndex] || "").trim(),
      };
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
          logger.log("warn", "sheet_entry_metadata_cleanup_failed", { recordId, error: metadataError });
        }
      } catch (error) {
        try {
          const confirmationRow = await this.readMetadataRow(sheets, metadata.metadataId, "FORMULA", "confirmation");
          if (!confirmationRow || !confirmationRow.some((value) => String(value || "").trim())) {
            try {
              await this.deleteRecordMetadata(sheets, "entryList", recordId, metadata.metadataId);
            } catch {
              this.recordMetadata.delete(`entryList:${recordId}`);
            }
            const confirmation = await this.readTable("entryList", "confirmation");
            const confirmationHeader = headerOf(confirmation);
            const confirmationIdIndex = headerIndex(confirmationHeader, "id");
            const stillPresent = confirmation.slice(1).some((entry) => String(entry[confirmationIdIndex] || "").trim() === recordId);
            if (!stillPresent) {
              dataStore.set("entryList", confirmation, { source: "write" });
              return withAudit({ success: true, removed: true, recovered: true }, { before: tombstone, after: null });
            }
          }
        } catch (confirmationError) {
          logger.log("error", "sheet_entry_delete_confirmation_read_failed", { recordId, error: confirmationError });
        }
        throw new AppError("WRITE_OUTCOME_UNKNOWN", "Ausgang der Abmeldung ist unklar", 503, {
          operationId: params.operationId,
          recordId,
          phase: "delete",
          tombstone,
        });
      }
      const candidate = [values[0], ...values.slice(1).filter((entry) => String(entry[idIndex] || "").trim() !== recordId)];
      dataStore.set("entryList", candidate, { source: "write-local", authoritative: false });
      this.scheduleRefresh("entryList");
      return withAudit({ success: true, removed: true }, { before: tombstone, after: null });
    }));
  }

  async withdrawFromRanking(principal, params) {
    const payload = { reason: params.reason, rank: params.rank, bewerbId: params.bewerbId };
    return this.runIdempotent(principal, "withdrawFromRanking", params.operationId, payload, () => this.enqueue("ranking-withdrawal", async () => {
      this.assertRankingMembership(principal, params.bewerbId, params.rank);
      return withAudit(
        { success: true },
        {
          before: { bewerbId: params.bewerbId, rank: params.rank, membership: true },
          after: { withdrawalRequested: true, reason: params.reason },
        },
      );
    }));
  }

  async refreshSheetData(principal, { operationId }) {
    return this.runIdempotent(principal, "refreshSheetData", operationId, {}, async () => {
      const result = await dataPoller.refreshAll("admin");
      for (const tableName of Object.keys(TABLE_CONFIG)) this.cancelScheduledRefresh(tableName);
      return withAudit({
        success: true,
        refreshedAt: result.refreshedAt,
        tableCount: result.tableCount,
        changedTables: result.changedTables,
      }, {
        before: null,
        after: {
          tableCount: result.tableCount,
          changedTableCount: result.changedTables.length,
          refreshedAt: result.refreshedAt,
        },
      });
    });
  }

  async stop() {
    this.stopping = true;
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    await Promise.allSettled([...this.active]);
  }

  status() {
    return {
      stopping: this.stopping,
      activeWrites: this.active.size,
      queues: this.queues.size,
      pendingMetadataIntents: this.repository.countPendingMetadataIntents(),
      scheduledRefreshes: this.refreshTimers.size,
      readCoordinator: getSheetReadStatus(),
    };
  }
}

module.exports = { SheetService, viennaTimestamp };
