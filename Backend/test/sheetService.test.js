const test = require("node:test");
const assert = require("node:assert/strict");
const { peopleFixture, setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const dataStore = require("../dataStore.js");
const { SheetService } = require("../sheetService.js");
const { StateRepository } = require("../stateRepository.js");

function fakeSheets(initialTables) {
  const tables = structuredClone(initialTables);
  const calls = { append: [], delete: [], valueUpdates: [] };
  const metadata = new Map();
  let nextMetadataId = 1;
  const tableNames = () => Object.keys(tables);
  const metadataForFilter = (filter) => {
    const lookup = filter?.developerMetadataLookup || {};
    return [...metadata.values()].filter((entry) => (
      (lookup.metadataId === undefined || entry.metadataId === lookup.metadataId)
      && (lookup.metadataKey === undefined || entry.metadataKey === lookup.metadataKey)
      && (lookup.metadataValue === undefined || entry.metadataValue === lookup.metadataValue)
    ));
  };
  const client = {
    spreadsheets: {
      values: {
        async get({ range }) {
          return { data: { values: structuredClone(tables[range] || []) } };
        },
        async append({ range, requestBody, valueInputOption }) {
          calls.append.push({ range, valueInputOption, values: structuredClone(requestBody.values) });
          tables[range].push(...structuredClone(requestBody.values));
          return { data: {} };
        },
        async batchUpdate({ requestBody }) {
          for (const update of requestBody.data || []) {
            calls.valueUpdates.push(structuredClone(update));
            const match = update.range.match(/^([^!]+)!([A-Z]+)(\d+)$/);
            if (!match) continue;
            const [, title, letters, rowText] = match;
            let column = 0;
            for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
            tables[title][Number(rowText) - 1][column - 1] = update.values[0][0];
          }
          return { data: {} };
        },
        async batchGetByDataFilter({ requestBody }) {
          const valueRanges = [];
          for (const filter of requestBody.dataFilters || []) {
            for (const entry of metadataForFilter(filter)) {
              if (!tables[entry.title].includes(entry.rowRef)) continue;
              valueRanges.push({ valueRange: { values: [structuredClone(entry.rowRef)] } });
            }
          }
          return { data: { valueRanges } };
        },
        async batchUpdateByDataFilter({ requestBody }) {
          let totalUpdatedRows = 0;
          for (const update of requestBody.data || []) {
            const matches = metadataForFilter(update.dataFilter);
            for (const entry of matches) {
              if (!tables[entry.title].includes(entry.rowRef)) continue;
              const values = update.values?.[0] || [];
              values.forEach((value, index) => {
                if (value === null || value === undefined) return;
                entry.rowRef[index] = value;
                calls.valueUpdates.push({ metadataId: entry.metadataId, index, value });
              });
              totalUpdatedRows++;
            }
          }
          return { data: { totalUpdatedRows } };
        },
        async batchClearByDataFilter({ requestBody }) {
          const clearedRanges = [];
          for (const filter of requestBody.dataFilters || []) {
            for (const entry of metadataForFilter(filter)) {
              const rowIndex = tables[entry.title].indexOf(entry.rowRef);
              if (rowIndex < 0) continue;
              tables[entry.title].splice(rowIndex, 1);
              calls.delete.push({ title: entry.title, rowIndex });
              clearedRanges.push(`${entry.title}!${rowIndex + 1}:${rowIndex + 1}`);
            }
          }
          return { data: { clearedRanges } };
        },
      },
      async get() {
        return {
          data: {
            sheets: Object.keys(tables).map((title, index) => ({ properties: { title, sheetId: index + 1 } })),
          },
        };
      },
      developerMetadata: {
        async search({ requestBody }) {
          const matches = [];
          for (const filter of requestBody.dataFilters || []) {
            for (const entry of metadataForFilter(filter)) {
              matches.push({ developerMetadata: structuredClone({
                metadataId: entry.metadataId,
                metadataKey: entry.metadataKey,
                metadataValue: entry.metadataValue,
                visibility: entry.visibility,
              }) });
            }
          }
          return { data: { matchedDeveloperMetadata: matches } };
        },
      },
      async batchUpdate({ requestBody }) {
        const replies = [];
        for (const request of requestBody.requests || []) {
          if (request.createDeveloperMetadata) {
            const value = request.createDeveloperMetadata.developerMetadata;
            const range = value.location.dimensionRange;
            const title = tableNames()[range.sheetId - 1];
            const entry = {
              metadataId: nextMetadataId++,
              metadataKey: value.metadataKey,
              metadataValue: value.metadataValue,
              visibility: value.visibility,
              title,
              rowRef: tables[title][range.startIndex],
            };
            metadata.set(entry.metadataId, entry);
            replies.push({ createDeveloperMetadata: { developerMetadata: structuredClone({
              metadataId: entry.metadataId,
              metadataKey: entry.metadataKey,
              metadataValue: entry.metadataValue,
              visibility: entry.visibility,
            }) } });
            continue;
          }
          if (request.deleteDeveloperMetadata) {
            for (const entry of metadataForFilter(request.deleteDeveloperMetadata.dataFilter)) metadata.delete(entry.metadataId);
            replies.push({});
            continue;
          }
          const range = request.deleteDimension?.range;
          if (!range) {
            replies.push({});
            continue;
          }
          const title = tableNames()[range.sheetId - 1];
          calls.delete.push({ title, startIndex: range.startIndex, endIndex: range.endIndex });
          tables[title].splice(range.startIndex, range.endIndex - range.startIndex);
          replies.push({});
        }
        return { data: { replies } };
      },
    },
  };
  return { calls, client, tables };
}

function fixtures() {
  const people = peopleFixture();
  people.push(
    ["p3", "Chris", "Challenger", "chris@example.test", "c".repeat(64), "", "+43789", "2", "1", "player"],
    ["p4", "Olivia", "Opponent", "olivia@example.test", "d".repeat(64), "", "+43000", "2", "1", "player"],
  );
  return {
    Personen: people,
    Bewerb: [["ID", "Bezeichnung", "BewerbsartID"], ["cup-1", "Cup", "type-1"], ["cup-2", "Cup 2", "type-1"]],
    Matches1: [[
      "Ignore", "ID", "MatchDate", "ForderungDate", "BewerbID", "BewerbRunde",
      "Spieler1ID", "Spieler2ID", "Spieler3ID", "Spieler4ID", "Ergebnis",
    ]],
    Rangliste: [
      ["ID", "BewerbID", "PersonID", "Rang"],
      ["r1", "cup-1", "p2", "1"], ["r2", "cup-1", "p1", "2"],
      ["r3", "cup-2", "p4", "1"], ["r4", "cup-2", "p3", "2"],
    ],
    EntryList: [["ID", "BewerbID", "PersonenID", "Entrydate"]],
    Logging: [["Timestamp", "Type", "Message"]],
  };
}

function seedStore(tables) {
  dataStore.resetForTests();
  dataStore.set("players", structuredClone(tables.Personen), { source: "test" });
  dataStore.set("bewerbe", structuredClone(tables.Bewerb), { source: "test" });
  dataStore.set("matches1", structuredClone(tables.Matches1), { source: "test" });
  dataStore.set("rlPlatzierung", structuredClone(tables.Rangliste), { source: "test" });
  dataStore.set("entryList", structuredClone(tables.EntryList), { source: "test" });
}

test("parallele Adds bleiben serialisiert, eindeutig und idempotent", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };
  const secondPrincipal = { type: "user", id: "p3", name: "Chris Challenger" };

  const firstOperation = "00000000-0000-4000-8000-000000000101";
  const secondOperation = "00000000-0000-4000-8000-000000000102";
  const [first, second] = await Promise.all([
    service.addMatch(principal, { operationId: firstOperation, bewerbId: "cup-1", opponentId: "p2" }),
    service.addMatch(secondPrincipal, { operationId: secondOperation, bewerbId: "cup-2", opponentId: "p4" }),
  ]);

  assert.notEqual(first.newMatchId, second.newMatchId);
  assert.equal(fake.calls.append.filter((call) => call.range === "Matches1").length, 2);
  assert.equal(dataStore.get("matches1").length, 3);

  const repeated = await service.addMatch(principal, { operationId: firstOperation, bewerbId: "cup-1", opponentId: "p2" });
  assert.equal(repeated.newMatchId, first.newMatchId);
  assert.equal(repeated.repeated, true);
  assert.equal(fake.calls.append.filter((call) => call.range === "Matches1").length, 2);

  await service.stop();
  repository.close();
});

test("EntryList-Delete loest die stabile Zeile frisch auf und ist wiederholbar", async () => {
  const initial = fixtures();
  initial.EntryList.push(
    ["e-other-1", "cup-1", "p2", ""],
    ["e-own", "cup-1", "p1", ""],
    ["e-other-2", "cup-1", "p2", ""],
  );
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(initial);
  seedStore({ ...fake.tables, EntryList: [["ID", "BewerbID", "PersonenID", "Entrydate"], ["stale", "cup-1", "p1", ""]] });
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };
  const operationId = "00000000-0000-4000-8000-000000000103";

  const removed = await service.removeEntry(principal, { operationId, bewerbId: "cup-1" });
  assert.deepEqual(removed, { success: true, removed: true });
  assert.equal(fake.tables.EntryList.some((row) => row[2] === "p1"), false);
  assert.deepEqual(fake.tables.EntryList.slice(1).map((row) => row[0]), ["e-other-1", "e-other-2"]);

  const repeated = await service.removeEntry(principal, { operationId, bewerbId: "cup-1" });
  assert.equal(repeated.repeated, true);
  assert.equal(fake.calls.delete.length, 1);

  const absent = await service.removeEntry(principal, {
    operationId: "00000000-0000-4000-8000-000000000104",
    bewerbId: "cup-1",
  });
  assert.deepEqual(absent, { success: true, removed: false });
  assert.equal(fake.calls.delete.length, 1);

  await service.stop();
  repository.close();
});

test("EntryList-Delete loest eine vor dem Delete verschobene Zeile erneut auf", async () => {
  const initial = fixtures();
  initial.EntryList.push(["e-own", "cup-1", "p1", ""], ["e-other", "cup-1", "p2", ""]);
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(initial);
  seedStore(fake.tables);
  const get = fake.client.spreadsheets.values.get;
  let entryReads = 0;
  fake.client.spreadsheets.values.get = async (params) => {
    const response = await get(params);
    if (params.range === "EntryList" && ++entryReads === 1) {
      fake.tables.EntryList.splice(1, 0, ["e-inserted", "cup-1", "p2", ""]);
    }
    return response;
  };
  const service = new SheetService({ repository, clientFactory: async () => fake.client });

  const result = await service.removeEntry(
    { type: "user", id: "p1", name: "Ada Admin" },
    { operationId: "00000000-0000-4000-8000-000000000110", bewerbId: "cup-1" },
  );
  assert.equal(result.removed, true);
  assert.deepEqual(fake.tables.EntryList.slice(1).map((row) => row[0]), ["e-inserted", "e-other"]);

  await service.stop();
  repository.close();
});

test("EntryList-Delete bestaetigt einen fehlenden Metadatentreffer gegen die Volltabelle", async () => {
  const initial = fixtures();
  initial.EntryList.push(["e-own", "cup-1", "p1", ""]);
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(initial);
  seedStore(fake.tables);
  const readByFilter = fake.client.spreadsheets.values.batchGetByDataFilter;
  let metadataReads = 0;
  fake.client.spreadsheets.values.batchGetByDataFilter = async (params) => {
    if (++metadataReads > 1) return { data: { valueRanges: [] } };
    return readByFilter(params);
  };
  fake.client.spreadsheets.values.batchClearByDataFilter = async () => ({ data: { clearedRanges: [] } });
  const service = new SheetService({ repository, clientFactory: async () => fake.client });

  await assert.rejects(service.removeEntry(
    { type: "user", id: "p1", name: "Ada Admin" },
    { operationId: "00000000-0000-4000-8000-000000000112", bewerbId: "cup-1" },
  ), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal(fake.tables.EntryList.some((row) => row[0] === "e-own"), true);

  await service.stop();
  repository.close();
});

test("unklarer EntryList-Delete entfernt bei Wiederholung keine neue Anmeldung", async () => {
  const initial = fixtures();
  initial.EntryList.push(["e-old", "cup-1", "p1", ""]);
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(initial);
  seedStore(fake.tables);
  const clear = fake.client.spreadsheets.values.batchClearByDataFilter;
  fake.client.spreadsheets.values.batchClearByDataFilter = async (params) => {
    await clear(params);
    throw new Error("delete response lost");
  };
  const readByFilter = fake.client.spreadsheets.values.batchGetByDataFilter;
  let metadataReads = 0;
  fake.client.spreadsheets.values.batchGetByDataFilter = async (params) => {
    if (++metadataReads > 1) throw new Error("confirmation unavailable");
    return readByFilter(params);
  };
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };
  const params = { operationId: "00000000-0000-4000-8000-000000000119", bewerbId: "cup-1" };

  await assert.rejects(service.removeEntry(principal, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  fake.tables.EntryList.push(["e-new", "cup-1", "p1", ""]);

  const recovered = await service.removeEntry(principal, params);
  assert.equal(recovered.recovered, true);
  assert.equal(fake.tables.EntryList.some((row) => row[0] === "e-new"), true);
  assert.equal(fake.calls.delete.length, 1);

  await service.stop();
  repository.close();
});

test("unklare Metadatenerstellung erzeugt bei Wiederholung keine zweite Metadatenzeile", async () => {
  const initial = fixtures();
  initial.EntryList.push(["e-own", "cup-1", "p1", ""]);
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(initial);
  seedStore(fake.tables);
  const batchUpdate = fake.client.spreadsheets.batchUpdate;
  let delayedRequest;
  let createAttempts = 0;
  fake.client.spreadsheets.batchUpdate = async (params) => {
    if (params.requestBody.requests?.[0]?.createDeveloperMetadata) {
      createAttempts++;
      delayedRequest = structuredClone(params);
      throw new Error("metadata timeout before delayed commit");
    }
    return batchUpdate(params);
  };
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };
  const params = {
    operationId: "00000000-0000-4000-8000-000000000116",
    bewerbId: "cup-1",
  };

  await assert.rejects(service.removeEntry(principal, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  await assert.rejects(service.removeEntry(principal, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal(createAttempts, 1);

  await batchUpdate(delayedRequest);
  const recovered = await service.removeEntry(principal, params);
  assert.equal(recovered.removed, true);
  assert.equal(recovered.repeated, true);
  assert.equal(createAttempts, 1);

  await service.stop();
  repository.close();
});

test("EntryList-Add lehnt unbekannte Bewerbe vor dem Write ab", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });

  await assert.rejects(service.addEntry(
    { type: "user", id: "p1", name: "Ada Admin" },
    { operationId: "00000000-0000-4000-8000-000000000105", bewerbId: "missing" },
  ), { code: "COMPETITION_NOT_FOUND" });
  assert.equal(fake.calls.append.length, 0);

  await service.stop();
  repository.close();
});

test("EntryList-Add schreibt den Zeitstempel in Entrydate", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });

  const added = await service.addEntry(
    { type: "user", id: "p1", name: "Ada Admin" },
    { operationId: "00000000-0000-4000-8000-000000000116", bewerbId: "cup-1" },
  );
  const row = fake.tables.EntryList.find((entry) => entry[0] === added.entryId);
  assert.match(row[3], /^\d{6}-\d{4}$/);

  await service.stop();
  repository.close();
});

test("parallele Passwortwrites verwenden Compare-and-set", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  const expectedHash = "a".repeat(64);

  const results = await Promise.allSettled([
    service.setPasswordHash("p1", "new-hash-1", { expectedHash }),
    service.setPasswordHash("p1", "new-hash-2", { expectedHash }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "PASSWORD_CONFLICT");
  assert.equal(fake.calls.valueUpdates.length, 2);

  await service.stop();
  repository.close();
});

test("Passwortwrite folgt der Personen-ID auch bei einer verschobenen Zeile", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const get = fake.client.spreadsheets.values.get;
  let peopleReads = 0;
  fake.client.spreadsheets.values.get = async (params) => {
    const response = await get(params);
    if (params.range === "Personen" && ++peopleReads === 1) {
      fake.tables.Personen.splice(1, 0, ["inserted", "Ivy", "Inserted", "ivy@example.test", "f".repeat(64), "", "", "2", "1", "player"]);
    }
    return response;
  };
  const service = new SheetService({ repository, clientFactory: async () => fake.client });

  await service.setPasswordHash("p1", "new-stored-hash", { expectedHash: "a".repeat(64) });
  const idIndex = fake.tables.Personen[0].indexOf("ID");
  const passwordIndex = fake.tables.Personen[0].indexOf("PasswdHash");
  const inserted = fake.tables.Personen.find((row) => row[idIndex] === "inserted");
  const target = fake.tables.Personen.find((row) => row[idIndex] === "p1");
  assert.equal(inserted[passwordIndex], "f".repeat(64));
  assert.equal(target[passwordIndex], "new-stored-hash");

  await service.stop();
  repository.close();
});

test("ein nach Commit verlorenes Append-Ergebnis wird ueber die stabile ID erkannt", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const append = fake.client.spreadsheets.values.append;
  let loseResponse = true;
  fake.client.spreadsheets.values.append = async (params) => {
    await append(params);
    if (loseResponse) {
      loseResponse = false;
      throw new Error("response lost");
    }
  };
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  const params = {
    operationId: "00000000-0000-4000-8000-000000000106",
    bewerbId: "cup-1",
    opponentId: "p2",
  };

  const result = await service.addMatch({ type: "user", id: "p1", name: "Ada Admin" }, params);
  assert.equal(result.recovered, true);
  assert.equal(fake.tables.Matches1.filter((row) => row.includes(result.newMatchId)).length, 1);
  const repeated = await service.addMatch({ type: "user", id: "p1", name: "Ada Admin" }, params);
  assert.equal(repeated.repeated, true);

  await service.stop();
  repository.close();
});

test("ein unklarer Append darf bei Wiederholung keinen zweiten Append starten", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const append = fake.client.spreadsheets.values.append;
  let delayedParams;
  fake.client.spreadsheets.values.append = async (params) => {
    delayedParams = structuredClone(params);
    throw new Error("timeout before delayed commit");
  };
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };
  const params = {
    operationId: "00000000-0000-4000-8000-000000000113",
    bewerbId: "cup-1",
    opponentId: "p2",
  };

  await assert.rejects(service.addMatch(principal, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  await assert.rejects(service.addMatch(principal, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal(delayedParams !== undefined, true);
  assert.equal(fake.calls.append.length, 0);

  await append(delayedParams);
  const recovered = await service.addMatch(principal, params);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.repeated, true);
  assert.equal(fake.calls.append.length, 1);

  await service.stop();
  repository.close();
});

test("erfolgreiche EntryList-No-ops synchronisieren einen veralteten Cache", async () => {
  const initial = fixtures();
  initial.EntryList.push(["existing", "cup-1", "p1", ""]);
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(initial);
  seedStore({ ...fake.tables, EntryList: [["ID", "BewerbID", "PersonenID", "Entrydate"]] });
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };

  const present = await service.addEntry(principal, {
    operationId: "00000000-0000-4000-8000-000000000114",
    bewerbId: "cup-1",
  });
  assert.equal(present.alreadyPresent, true);
  assert.equal(dataStore.get("entryList").some((row) => row[0] === "existing"), true);

  fake.tables.EntryList.splice(1);
  const absent = await service.removeEntry(principal, {
    operationId: "00000000-0000-4000-8000-000000000115",
    bewerbId: "cup-1",
  });
  assert.equal(absent.removed, false);
  assert.equal(dataStore.get("entryList").length, 1);

  await service.stop();
  repository.close();
});

test("Matchregeln verwenden die unmittelbar zuvor gelesene Tabelle", async () => {
  const initial = fixtures();
  initial.Matches1.push(["", "m-open", "", "260101-1200", "cup-1", "", "p2", "", "p1", "", ""]);
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(initial);
  seedStore({ ...fake.tables, Matches1: [fake.tables.Matches1[0]] });
  const service = new SheetService({ repository, clientFactory: async () => fake.client });

  await assert.rejects(service.addMatch(
    { type: "user", id: "p1", name: "Ada Admin" },
    { operationId: "00000000-0000-4000-8000-000000000111", bewerbId: "cup-1", opponentId: "p2" },
  ), { code: "PLAYER_BUSY" });
  assert.equal(fake.calls.append.length, 0);

  await service.stop();
  repository.close();
});

test("Shutdown fuehrt bereits angenommene Queue-Eintraege noch aus", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const service = new SheetService({ repository, clientFactory: async () => ({}) });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  service.enqueue("test", async () => {
    calls.push("first-start");
    await gate;
    calls.push("first-end");
  });
  service.enqueue("test", async () => calls.push("second"));
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = service.stop();
  release();
  await stopping;
  assert.deepEqual(calls, ["first-start", "first-end", "second"]);
  await assert.rejects(service.enqueue("test", async () => {}), { code: "SHUTTING_DOWN" });
  repository.close();
});

test("Ranglistenrueckzug verwendet das dreispaltige Legacy-Logging", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };
  const params = {
    operationId: "00000000-0000-4000-8000-000000000117",
    bewerbId: "cup-1",
    rank: 2,
    reason: "Test rueckzug",
  };

  assert.deepEqual(await service.withdrawFromRanking(principal, params), { success: true });
  const loggingCalls = fake.calls.append.filter((call) => call.range === "Logging");
  assert.equal(loggingCalls.length, 1);
  assert.equal(loggingCalls[0].valueInputOption, "USER_ENTERED");
  assert.equal(loggingCalls[0].values[0].length, 3);
  assert.match(loggingCalls[0].values[0][0], /^\d{6}-\d{4}-\d{2}$/);
  assert.equal(loggingCalls[0].values[0][1], "withdrawFromRanking");
  assert.match(loggingCalls[0].values[0][2], /Ada Admin.*Rang 2.*cup-1.*Test rueckzug/);

  const repeated = await service.withdrawFromRanking(principal, params);
  assert.equal(repeated.repeated, true);
  assert.equal(fake.calls.append.filter((call) => call.range === "Logging").length, 1);

  await service.stop();
  repository.close();
});

test("unklarer Legacy-Logging-Append wird nicht blind wiederholt", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const append = fake.client.spreadsheets.values.append;
  fake.client.spreadsheets.values.append = async (params) => {
    const response = await append(params);
    if (params.range === "Logging") throw new Error("append response lost");
    return response;
  };
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };
  const params = {
    operationId: "00000000-0000-4000-8000-000000000120",
    bewerbId: "cup-1",
    rank: 2,
    reason: "Test rueckzug",
  };

  await assert.rejects(service.withdrawFromRanking(principal, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  await assert.rejects(service.withdrawFromRanking(principal, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal(fake.calls.append.filter((call) => call.range === "Logging").length, 1);

  await service.stop();
  repository.close();
});

test("Entry- und Ranking-Writes erzwingen serverseitige Fachregeln", async () => {
  const initial = fixtures();
  initial.Bewerb[0].push("EntryStart", "EntryDeadline");
  for (const row of initial.Bewerb.slice(1)) row.push("", "20000101");
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(initial);
  seedStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };

  await assert.rejects(service.addEntry(principal, {
    operationId: "00000000-0000-4000-8000-000000000107",
    bewerbId: "cup-1",
  }), { code: "ENTRY_CLOSED" });
  await assert.rejects(service.addMatch(principal, {
    operationId: "00000000-0000-4000-8000-000000000108",
    bewerbId: "cup-1",
    opponentId: "p3",
  }), { code: "RANKING_MEMBERSHIP_REQUIRED" });
  await assert.rejects(service.withdrawFromRanking(principal, {
    operationId: "00000000-0000-4000-8000-000000000109",
    bewerbId: "cup-1",
    rank: 99,
    reason: "Test rueckzug",
  }), { code: "RANK_CONFLICT" });
  assert.equal(fake.calls.append.length, 0);

  await service.stop();
  repository.close();
});
