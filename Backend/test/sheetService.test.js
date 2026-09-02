const test = require("node:test");
const assert = require("node:assert/strict");
const { peopleFixture, setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const dataStore = require("../dataStore.js");
const dataPoller = require("../dataPoller.js");
const { TABLE_CONFIG } = require("../config.js");
const { SheetService } = require("../sheetService.js");
const { StateRepository } = require("../stateRepository.js");
const metrics = require("../metrics.js");
const { projectPeopleNormalization } = require("../peopleNormalization.js");
const { projectPeopleReconciliation } = require("../memberReconciliation.js");
const { acquireExclusiveSheetActivity, resetSheetReadCoordinatorForTests } = require("../sheetsReadCoordinator.js");

test.beforeEach(() => resetSheetReadCoordinatorForTests());

const messagingService = { async ensureChallengeMessages() {}, async ensureRankingWithdrawalEvent() {} };

test("manueller Gesamtimport ist pro Admin und operationId idempotent", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const service = new SheetService({ repository });
  let calls = 0;
  t.mock.method(dataPoller, "refreshAll", async () => {
    calls++;
    return { refreshedAt: 1000, tableCount: 8, changedTables: ["players"] };
  });
  const principal = { type: "user", id: "p1", role: "admin", name: "Ada Admin" };
  const params = { operationId: "00000000-0000-4000-8000-000000000101" };

  const first = await service.refreshSheetData(principal, params);
  const repeated = await service.refreshSheetData(principal, params);

  assert.equal(first.success, true);
  assert.equal(repeated.repeated, true);
  assert.equal(calls, 1);
  await service.stop();
  repository.close();
});

test("fehlgeschlagener Gesamtimport verwirft keinen geplanten Write-Refresh", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const service = new SheetService({ repository });
  const timer = setTimeout(() => {}, 60000);
  timer.unref();
  service.refreshTimers.set("players", timer);
  t.mock.method(dataPoller, "refreshAll", async () => {
    throw Object.assign(new Error("refresh unavailable"), { code: "DATA_REFRESH_FAILED" });
  });

  await assert.rejects(
    service.refreshSheetData(
      { type: "user", id: "p1", role: "admin", name: "Ada Admin" },
      { operationId: "00000000-0000-4000-8000-000000000102" },
    ),
    { code: "DATA_REFRESH_FAILED" },
  );
  assert.equal(service.refreshTimers.get("players"), timer);
  await service.stop();
  repository.close();
});

test("Gesamtimport ueberholt keine bereits angenommene Write-Queue", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const service = new SheetService({ repository });
  const order = [];
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = service.enqueue("players", async () => {
    order.push("write-1");
    await gate;
  });
  const second = service.enqueue("players", async () => { order.push("write-2"); });
  const exclusive = acquireExclusiveSheetActivity().then((release) => {
    order.push("import");
    release();
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["write-1"]);
  releaseFirst();
  await Promise.all([first, second, exclusive]);
  assert.deepEqual(order, ["write-1", "write-2", "import"]);
  await service.stop();
  repository.close();
});

function fakeSheets(initialTables) {
  const tables = structuredClone(initialTables);
  const calls = { append: [], delete: [], valueUpdates: [], valueGets: 0, metadataRows: 0, metadataSearches: 0, spreadsheetGets: 0, spreadsheetUpdates: 0, metadataCreates: 0 };
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
          calls.valueGets++;
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
          calls.metadataRows++;
          const valueRanges = [];
          for (const filter of requestBody.dataFilters || []) {
            for (const entry of metadataForFilter(filter)) {
              if (!tables[entry.title].includes(entry.rowRef)) continue;
              const row = structuredClone(entry.rowRef);
              if (requestBody.valueRenderOption === "FORMULA" && entry.title === "Personen") {
                const birthDateIndex = tables.Personen[0].indexOf("GeburtsDatum");
                if (/^\d{2}\.\d{2}\.\d{4}$/.test(String(row[birthDateIndex] || ""))) row[birthDateIndex] = "32875";
              }
              valueRanges.push({ dataFilters: [structuredClone(filter)], valueRange: { values: [row] } });
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
        calls.spreadsheetGets++;
        return {
          data: {
            sheets: Object.keys(tables).map((title, index) => ({ properties: { title, sheetId: index + 1 } })),
          },
        };
      },
      developerMetadata: {
        async search({ requestBody }) {
          calls.metadataSearches++;
          const matches = [];
          for (const filter of requestBody.dataFilters || []) {
            for (const entry of metadataForFilter(filter)) {
              matches.push({ developerMetadata: structuredClone({
                metadataId: entry.metadataId,
                metadataKey: entry.metadataKey,
                metadataValue: entry.metadataValue,
                visibility: entry.visibility,
                location: { dimensionRange: {
                  sheetId: tableNames().indexOf(entry.title) + 1,
                  dimension: "ROWS",
                  startIndex: tables[entry.title].indexOf(entry.rowRef),
                  endIndex: tables[entry.title].indexOf(entry.rowRef) + 1,
                } },
              }) });
            }
          }
          return { data: { matchedDeveloperMetadata: matches } };
        },
      },
      async batchUpdate({ requestBody }) {
        calls.spreadsheetUpdates++;
        const replies = [];
        for (const request of requestBody.requests || []) {
          if (request.createDeveloperMetadata) {
            calls.metadataCreates++;
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
  function seedRecordMetadata(title, rowIndex, recordId) {
    const tableName = Object.entries(TABLE_CONFIG).find(([, config]) => config.range === title)?.[0];
    const entry = {
      metadataId: nextMetadataId++,
      metadataKey: "epiberRecord",
      metadataValue: `${tableName}:${recordId}`,
      visibility: "DOCUMENT",
      title,
      rowRef: tables[title][rowIndex],
    };
    metadata.set(entry.metadataId, entry);
  }
  return { calls, client, seedRecordMetadata, tables };
}

function fixtures() {
  const people = peopleFixture();
  people.push(
    ["p3", "Chris", "Challenger", "chris@example.test", "c".repeat(64), "", "+43789", "2", "1", "player"],
    ["p4", "Olivia", "Opponent", "olivia@example.test", "d".repeat(64), "", "+43000", "2", "1", "player"],
  );
  people[0].push("Login");
  people.slice(1).forEach((row) => row.push(`${row[1]}.${row[2]}`.toLowerCase()));
  const ranking = [
    ["ID", "BewerbID", "PersonID", "Rang", "RausgehangenAm", "RausgehangenLetztePlatzierung", "RausgehangenGrund"],
    ["r1", "cup-1", "p2", "1", "", "", ""], ["r2", "cup-1", "p1", "2", "", "", ""],
    ["r3", "cup-2", "p4", "1", "", "", ""], ["r4", "cup-2", "p3", "2", "", "", ""],
  ];
  return {
    Personen: people,
    Bewerb: [["ID", "Bezeichnung", "BewerbsartID"], ["cup-1", "Cup", "2"], ["cup-2", "Cup 2", "2"]],
    Matches1: [[
      "Ignore", "ID", "MatchDate", "ForderungDate", "BewerbID", "BewerbRunde",
      "Spieler1ID", "Spieler2ID", "Spieler3ID", "Spieler4ID", "Ergebnis",
    ]],
    Rangliste: ranking,
    "RL-Platzierung": ranking,
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

function reconciliationFixtures() {
  return {
    Personen: [
      ["ID", "CD-ID", "Vorname", "Nachname", "E-Mail", "PasswdHash", "KennwortVergessen", "GeburtsDatum", "GeschlechtID", "TelefonMobil", "Land", "PLZ", "Ort", "Adresse", "Aktiv", "Role", "Login"],
      ["1", "1000001", "Ada", "Admin", "ada@example.test", "a".repeat(64), "", "02.01.1990", "2", "0043 664 1111111", "Österreich", "4060", "Piberbach", "Dorf 1", "1", "admin", "ada.admin"],
      ["1032", "", "Peter", "Player", "peter@example.test", "b".repeat(64), "x", "03.02.1991", "1", "0043 664 2222222", "Österreich", "4060", "Piberbach", "Dorf 2", "1", "player", "peter.player"],
      ["1000", "1000999", "Olivia", "Operator", "olivia@example.test", "c".repeat(64), "", "04.03.1992", "2", "0043 664 3333333", "Österreich", "4060", "Piberbach", "Dorf 3", "1", "operator", "olivia.operator"],
    ],
  };
}

function seedReconciliationStore(tables) {
  dataStore.resetForTests();
  dataStore.set("players", structuredClone(tables.Personen), { source: "test" });
}

test("Mitgliederabgleich verknuepft und aktualisiert bestehende Personen konfliktgeschuetzt", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(reconciliationFixtures());
  seedReconciliationStore(fake.tables);
  const service = new SheetService({ repository, messagingService, clientFactory: async () => fake.client });
  t.after(() => service.stop());
  const person = projectPeopleReconciliation(fake.tables.Personen).people.find((entry) => entry.id === "1032");
  const passwordBefore = fake.tables.Personen[2][5];
  const session = repository.createSession({ userId: "1032", email: "peter@example.test", ttlMs: 60000 });

  const result = await service.reconcilePerson(
    { type: "user", id: "1", role: "admin", name: "Ada Admin" },
    {
      operationId: "00000000-0000-4000-8000-000000000201",
      action: "update",
      personId: "1032",
      expectedFingerprint: person.fingerprint,
      externalId: "1000068",
      changes: { firstName: "Petra", email: "petra@example.test", role: "player A" },
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.action, "update");
  assert.equal(fake.tables.Personen[2][1], "1000068");
  assert.equal(fake.tables.Personen[2][2], "Petra");
  assert.equal(fake.tables.Personen[2][4], "petra@example.test");
  assert.equal(fake.tables.Personen[2][15], "player A");
  assert.equal(fake.tables.Personen[2][16], "peter.player");
  assert.equal(fake.tables.Personen[2][5], passwordBefore);
  assert.deepEqual(result._audit.before, { externalId: "vorher", firstName: "vorher", email: "vorher", role: "player" });
  assert.deepEqual(result._audit.after, { externalId: "nachher", firstName: "nachher", email: "nachher", role: "player A" });
  assert.equal(JSON.stringify(result._audit).includes("peter@example.test"), false);
  assert.equal(JSON.stringify(result._audit).includes("petra@example.test"), false);
  assert.equal(JSON.stringify(result._audit).includes("peter.player"), false);
  assert.equal(JSON.stringify(result._audit).includes("petra.player"), false);
  assert.equal(repository.getSession(session.token), null);
});

test("Mitgliederabgleich deaktiviert nur Spieler und widerruft deren Sitzungen", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(reconciliationFixtures());
  seedReconciliationStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  t.after(() => service.stop());
  const projection = projectPeopleReconciliation(fake.tables.Personen);
  const session = repository.createSession({ userId: "1032", email: "peter@example.test", ttlMs: 60000 });

  await service.reconcilePerson({ type: "user", id: "1", role: "admin" }, {
    operationId: "00000000-0000-4000-8000-000000000202",
    action: "deactivate",
    personId: "1032",
    expectedFingerprint: projection.people.find((entry) => entry.id === "1032").fingerprint,
  });
  assert.equal(fake.tables.Personen[2][14], "");
  assert.equal(repository.getSession(session.token), null);

  await assert.rejects(service.reconcilePerson({ type: "user", id: "1", role: "admin" }, {
    operationId: "00000000-0000-4000-8000-000000000203",
    action: "deactivate",
    personId: "1000",
    expectedFingerprint: projection.people.find((entry) => entry.id === "1000").fingerprint,
  }), { code: "ROLE_PROTECTED" });
});

test("Mitgliederabgleich legt neue Personen mit max ID plus eins und Metadata idempotent an", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(reconciliationFixtures());
  seedReconciliationStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  t.after(() => service.stop());
  const params = {
    operationId: "00000000-0000-4000-8000-000000000204",
    action: "create",
    externalId: "1000494",
    values: {
      firstName: "Neue",
      lastName: "Person",
      birthDate: "05.04.1993",
      gender: "2",
      phone: "0043 664 4444444",
      email: "neu@example.test",
      login: "neue.person",
      country: "Österreich",
      postalCode: "4060",
      city: "Piberbach",
      address: "Dorf 4",
      active: "1",
      role: "player B",
    },
  };

  const first = await service.reconcilePerson({ type: "user", id: "1", role: "admin" }, params);
  const repeated = await service.reconcilePerson({ type: "user", id: "1", role: "admin" }, params);
  assert.equal(first.personId, "1033");
  assert.equal(repeated.personId, "1033");
  assert.equal(repeated.repeated, true);
  assert.equal(fake.calls.append.filter((entry) => entry.range === "Personen").length, 1);
  assert.equal(fake.calls.metadataCreates, 1);
  const row = fake.tables.Personen.find((entry) => entry[0] === "1033");
  assert.equal(row[1], "1000494");
  assert.equal(row[5], "");
  assert.equal(row[6], "");
  assert.equal(row[15], "player B");
  assert.equal(row[16], "neue.person");
});

test("parallele Mitgliedsneuanlagen vergeben fortlaufende eindeutige Personen-IDs", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(reconciliationFixtures());
  seedReconciliationStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  t.after(() => service.stop());
  const principal = { type: "user", id: "1", role: "admin" };
  const create = (operationId, externalId, firstName) => service.reconcilePerson(principal, {
    operationId,
    action: "create",
    externalId,
    values: { firstName, lastName: "Neu", active: "1", role: "player" },
  });

  const [first, second] = await Promise.all([
    create("00000000-0000-4000-8000-000000000205", "1000501", "Erste"),
    create("00000000-0000-4000-8000-000000000206", "1000502", "Zweite"),
  ]);
  assert.deepEqual(new Set([first.personId, second.personId]), new Set(["1033", "1034"]));
  assert.equal(fake.calls.append.filter((entry) => entry.range === "Personen").length, 2);
});

test("Mitgliedsneuanlage vergibt auch oberhalb der sicheren Number-Grenze die exakte Folge-ID", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fixture = reconciliationFixtures();
  fixture.Personen[2][0] = "9007199254740993";
  const fake = fakeSheets(fixture);
  seedReconciliationStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  t.after(() => service.stop());

  const result = await service.reconcilePerson({ type: "user", id: "1", role: "admin" }, {
    operationId: "00000000-0000-4000-8000-000000000214",
    action: "create",
    externalId: "1000503",
    values: { firstName: "Gross", lastName: "ID", active: "1", role: "player" },
  });
  assert.equal(result.personId, "9007199254740994");
});

test("unklare Mitgliedsneuanlage wird nicht blind erneut angehaengt", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(reconciliationFixtures());
  seedReconciliationStore(fake.tables);
  let appendAttempts = 0;
  fake.client.spreadsheets.values.append = async () => {
    appendAttempts++;
    throw new Error("append unavailable");
  };
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  t.after(() => service.stop());
  const params = {
    operationId: "00000000-0000-4000-8000-000000000210",
    action: "create",
    externalId: "1000600",
    values: { firstName: "Unklar", lastName: "Neu", active: "1", role: "player" },
  };

  await assert.rejects(service.reconcilePerson({ type: "user", id: "1", role: "admin" }, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  await assert.rejects(service.reconcilePerson({ type: "user", id: "1", role: "admin" }, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal(appendAttempts, 1);
  assert.equal(fake.tables.Personen.some((row) => row[1] === "1000600"), false);
});

test("Metadatenfehler nach Personappend bleibt wiederaufnehmbar und haengt nicht doppelt an", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(reconciliationFixtures());
  seedReconciliationStore(fake.tables);
  const batchUpdate = fake.client.spreadsheets.batchUpdate;
  fake.client.spreadsheets.batchUpdate = async () => {
    throw Object.assign(new Error("metadata forbidden"), { response: { status: 403 } });
  };
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  t.after(() => service.stop());
  const params = {
    operationId: "00000000-0000-4000-8000-000000000212",
    action: "create",
    externalId: "1000601",
    values: { firstName: "Metadata", lastName: "Neu", active: "1", role: "player" },
  };

  await assert.rejects(service.reconcilePerson({ type: "user", id: "1", role: "admin" }, params), (error) => (
    error.code === "WRITE_OUTCOME_UNKNOWN" && error.details?.personId === "1033"
  ));
  assert.equal(fake.calls.append.filter((entry) => entry.range === "Personen").length, 1);
  fake.client.spreadsheets.batchUpdate = batchUpdate;
  const recovered = await service.reconcilePerson({ type: "user", id: "1", role: "admin" }, params);
  assert.equal(recovered.personId, "1033");
  assert.equal(recovered.recovered, true);
  assert.equal(fake.calls.append.filter((entry) => entry.range === "Personen").length, 1);
});

test("unklare CD-ID-Verknuepfung wird bei Wiederholung nur bestaetigt", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(reconciliationFixtures());
  seedReconciliationStore(fake.tables);
  let writeAttempts = 0;
  fake.client.spreadsheets.values.batchUpdateByDataFilter = async () => {
    writeAttempts++;
    throw new Error("update unavailable");
  };
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  t.after(() => service.stop());
  const person = projectPeopleReconciliation(fake.tables.Personen).people.find((entry) => entry.id === "1032");
  const params = {
    operationId: "00000000-0000-4000-8000-000000000211",
    action: "update",
    personId: "1032",
    expectedFingerprint: person.fingerprint,
    externalId: "1000068",
    changes: {},
  };

  await assert.rejects(service.reconcilePerson({ type: "user", id: "1", role: "admin" }, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  await assert.rejects(service.reconcilePerson({ type: "user", id: "1", role: "admin" }, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal(writeAttempts, 1);
  assert.equal(fake.tables.Personen[2][1], "");
});

test("unklare Deaktivierung widerruft Sitzungen vorsorglich", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(reconciliationFixtures());
  seedReconciliationStore(fake.tables);
  fake.client.spreadsheets.values.batchUpdateByDataFilter = async () => { throw new Error("update unavailable"); };
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  t.after(() => service.stop());
  const person = projectPeopleReconciliation(fake.tables.Personen).people.find((entry) => entry.id === "1032");
  const session = repository.createSession({ userId: "1032", email: "peter@example.test", ttlMs: 60000 });

  await assert.rejects(service.reconcilePerson({ type: "user", id: "1", role: "admin" }, {
    operationId: "00000000-0000-4000-8000-000000000213",
    action: "deactivate",
    personId: "1032",
    expectedFingerprint: person.fingerprint,
  }), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal(repository.getSession(session.token), null);
});

test("Mitgliederabgleich behaelt Sitzungen bei E-Mail-only und widerruft sie bei unklarer Rolle", async (t) => {
  for (const entry of [
    { field: "email", value: "new@example.test", unknown: false, revoked: false },
    { field: "role", value: "player B", unknown: true, revoked: true },
  ]) {
    const repository = new StateRepository(":memory:");
    repository.init();
    const fake = fakeSheets(reconciliationFixtures());
    seedReconciliationStore(fake.tables);
    if (entry.unknown) {
      fake.client.spreadsheets.values.batchUpdateByDataFilter = async () => { throw new Error("update unavailable"); };
    }
    const service = new SheetService({ repository, clientFactory: async () => fake.client });
    t.after(() => service.stop());
    const person = projectPeopleReconciliation(fake.tables.Personen).people.find((candidate) => candidate.id === "1032");
    const session = repository.createSession({ userId: "1032", email: "peter@example.test", ttlMs: 60000 });
    const operation = service.reconcilePerson({ type: "user", id: "1", role: "admin" }, {
      operationId: entry.unknown ? "00000000-0000-4000-8000-000000000216" : "00000000-0000-4000-8000-000000000215",
      action: "update",
      personId: "1032",
      expectedFingerprint: person.fingerprint,
      externalId: "1000068",
      changes: { [entry.field]: entry.value },
    });
    if (entry.unknown) await assert.rejects(operation, { code: "WRITE_OUTCOME_UNKNOWN" });
    else await operation;
    assert.equal(repository.getSession(session.token) === null, entry.revoked, entry.field);
  }
});

test("Recovery eines angewendeten Rollen-Writes widerruft zwischenzeitlich erzeugte Sitzungen", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(reconciliationFixtures());
  seedReconciliationStore(fake.tables);
  const applyUpdate = fake.client.spreadsheets.values.batchUpdateByDataFilter;
  const readMetadata = fake.client.spreadsheets.values.batchGetByDataFilter;
  let failNextConfirmation = false;
  fake.client.spreadsheets.values.batchUpdateByDataFilter = async (request) => {
    await applyUpdate(request);
    failNextConfirmation = true;
    throw new Error("update response unavailable");
  };
  fake.client.spreadsheets.values.batchGetByDataFilter = async (request) => {
    if (failNextConfirmation) {
      failNextConfirmation = false;
      throw new Error("confirmation unavailable");
    }
    return readMetadata(request);
  };
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  t.after(() => service.stop());
  const person = projectPeopleReconciliation(fake.tables.Personen).people.find((candidate) => candidate.id === "1032");
  const params = {
    operationId: "00000000-0000-4000-8000-000000000217",
    action: "update",
    personId: "1032",
    expectedFingerprint: person.fingerprint,
    externalId: "1000068",
    changes: { role: "player B" },
  };

  await assert.rejects(service.reconcilePerson({ type: "user", id: "1", role: "admin" }, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  const session = repository.createSession({ userId: "1032", email: "peter@example.test", login: "peter.player", ttlMs: 60000 });
  const recovered = await service.reconcilePerson({ type: "user", id: "1", role: "admin" }, params);
  assert.equal(recovered.repeated, true);
  assert.equal(repository.getSession(session.token), null);
});

test("Mitgliederabgleich lehnt Fingerprint-, CD-ID- und Login-Konflikte vor Writes ab", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(reconciliationFixtures());
  seedReconciliationStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  t.after(() => service.stop());
  const person = projectPeopleReconciliation(fake.tables.Personen).people.find((entry) => entry.id === "1032");
  const base = {
    action: "update",
    personId: "1032",
    expectedFingerprint: person.fingerprint,
    externalId: "1000068",
  };
  await assert.rejects(service.reconcilePerson({ type: "user", id: "1", role: "admin" }, {
    ...base,
    operationId: "00000000-0000-4000-8000-000000000207",
    expectedFingerprint: "0".repeat(64),
    changes: { city: "Linz" },
  }), { code: "PERSON_CONFLICT" });
  await assert.rejects(service.reconcilePerson({ type: "user", id: "1", role: "admin" }, {
    ...base,
    operationId: "00000000-0000-4000-8000-000000000208",
    externalId: "1000001",
    changes: { city: "Linz" },
  }), { code: "EXTERNAL_ID_CONFLICT" });
  await assert.rejects(service.reconcilePerson({ type: "user", id: "1", role: "admin" }, {
    ...base,
    operationId: "00000000-0000-4000-8000-000000000209",
    changes: { login: "ada.admin" },
  }), { code: "VALIDATION_ERROR" });
  await assert.rejects(service.reconcilePerson({ type: "user", id: "1", role: "admin" }, {
    operationId: "00000000-0000-4000-8000-000000000217",
    action: "create",
    externalId: "1000602",
    values: { lastName: "Collision", login: "ada.admin", active: "1", role: "player" },
  }), { code: "LOGIN_CONFLICT" });
  assert.equal(fake.calls.valueUpdates.length, 0);
  assert.equal(fake.calls.append.length, 0);
});

test("Personennormalisierung schreibt konfliktgeschuetzt und laesst Sicherheitsfelder unveraendert", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  fake.tables.Personen[2][10] = "04.03.1985";
  seedStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  t.after(() => service.stop());
  const principal = { type: "user", id: "p1", role: "admin", name: "Ada Admin" };
  const person = projectPeopleNormalization(fake.tables.Personen).people.find((entry) => entry.id === "p2");
  const passwordBefore = fake.tables.Personen[2][4];
  const resetBefore = fake.tables.Personen[2][5];

  const result = await service.normalizePerson(principal, {
    operationId: "00000000-0000-4000-8000-000000000090",
    personId: "p2",
    expectedFingerprint: person.fingerprint,
    changes: { firstName: "Petra", email: "petra@example.test" },
  });

  assert.equal(result.success, true);
  assert.equal(result._audit.targetName, "Petra Player");
  assert.deepEqual(result._audit.before, { firstName: "Peter", email: "peter@example.test" });
  assert.deepEqual(result._audit.after, { firstName: "Petra", email: "petra@example.test" });
  assert.equal(fake.tables.Personen[2][1], "Petra");
  assert.equal(fake.tables.Personen[2][3], "petra@example.test");
  assert.equal(fake.tables.Personen[2][4], passwordBefore);
  assert.equal(fake.tables.Personen[2][5], resetBefore);
  assert.equal(fake.calls.valueUpdates.some((entry) => entry.index === 4 || entry.index === 5), false);
  assert.equal(dataStore.get("players")[2][1], "Petra");
  assert.equal(fake.calls.valueGets, 1);
  assert.equal(fake.calls.metadataRows, 1);
});

test("Personenserie nutzt einen Metadatenscan und fasst den Abschlussrefresh zusammen", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  fake.seedRecordMetadata("Personen", 2, "p2");
  fake.seedRecordMetadata("Personen", 3, "p3");
  seedStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client, refreshDelayMs: 10 });
  t.after(() => service.stop());
  const principal = { type: "user", id: "p1", role: "admin", name: "Ada Admin" };
  const projection = projectPeopleNormalization(fake.tables.Personen);

  await service.normalizePerson(principal, {
    operationId: "00000000-0000-4000-8000-000000000094",
    personId: "p2",
    expectedFingerprint: projection.people.find((person) => person.id === "p2").fingerprint,
    changes: { firstName: "Petra" },
  });
  await service.normalizePerson(principal, {
    operationId: "00000000-0000-4000-8000-000000000095",
    personId: "p3",
    expectedFingerprint: projection.people.find((person) => person.id === "p3").fingerprint,
    changes: { firstName: "Christian" },
  });

  assert.equal(fake.calls.metadataSearches, 1);
  assert.equal(fake.calls.metadataRows, 2);
  assert.equal(fake.calls.valueGets, 2);
  assert.equal(service.status().scheduledRefreshes, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.calls.valueGets, 3);
  assert.equal(service.status().scheduledRefreshes, 0);
});

test("Sheet-IDs und bestehende Record-Metadaten werden single-flight gesammelt", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  fake.seedRecordMetadata("Personen", 2, "p2");
  fake.seedRecordMetadata("Personen", 3, "p3");
  const service = new SheetService({ repository, clientFactory: async () => fake.client });

  const [playersSheet, entriesSheet] = await Promise.all([
    service.getSheetId(fake.client, "players"),
    service.getSheetId(fake.client, "entryList"),
  ]);
  assert.notEqual(playersSheet, entriesSheet);
  assert.equal(fake.calls.spreadsheetGets, 1);

  const [player2, player3] = await Promise.all([
    service.findRecordMetadata(fake.client, "players", "p2"),
    service.findRecordMetadata(fake.client, "players", "p3"),
  ]);
  assert.ok(player2.metadataId);
  assert.ok(player3.metadataId);
  assert.equal(fake.calls.metadataSearches, 1);
});

test("wiedergefundene Record-Metadata bestaetigt einen persistenten pending Intent", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(reconciliationFixtures());
  fake.seedRecordMetadata("Personen", 2, "1032");
  const intent = repository.getState("record-metadata-intent:players:1032", { status: "none" });
  repository.setState("record-metadata-intent:players:1032", { status: "pending", at: 1 }, intent.revision);
  const service = new SheetService({ repository, clientFactory: async () => fake.client, now: () => 1234 });

  const metadata = await service.findRecordMetadata(fake.client, "players", "1032");
  assert.ok(metadata.metadataId);
  assert.deepEqual(repository.getState("record-metadata-intent:players:1032", {}).value, {
    status: "confirmed",
    metadataId: metadata.metadataId,
    at: 1234,
  });
  await service.stop();
});

test("doppelte Metadaten aus dem Gesamtscan bleiben ein Schemakonflikt", async () => {
  const initial = fixtures();
  initial.EntryList.push(["e-own", "cup-1", "p1", ""], ["e-other", "cup-1", "p2", ""]);
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(initial);
  fake.seedRecordMetadata("EntryList", 1, "e-own");
  fake.seedRecordMetadata("EntryList", 2, "e-own");
  seedStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });

  await assert.rejects(service.removeEntry(
    { type: "user", id: "p1", name: "Ada Admin" },
    { operationId: "00000000-0000-4000-8000-000000000096", bewerbId: "cup-1" },
  ), { code: "SHEET_SCHEMA" });
  assert.equal(fake.calls.metadataCreates, 0);
  assert.equal(fake.tables.EntryList.some((row) => row[0] === "e-own"), true);
});

test("fehlgeschlagener Abschlussrefresh erzeugt keine Scheingegenmutation", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  const staleRead = dataStore.beginRead("players");
  const mutationBefore = dataStore.getMeta("players").lastMutation;
  fake.client.spreadsheets.values.get = async () => { throw new Error("refresh unavailable"); };

  await service.refreshCache("players", (cached) => cached);
  const applied = dataStore.set("players", structuredClone(fake.tables.Personen), { source: "poll", readToken: staleRead });
  assert.equal(applied.ignored, undefined);
  assert.equal(dataStore.getMeta("players").lastMutation, mutationBefore);
});

test("Personennormalisierung lehnt veraltete Fingerprints und doppelte Logins vor dem Write ab", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  const principal = { type: "user", id: "p1", role: "admin", name: "Ada Admin" };
  const person = projectPeopleNormalization(fake.tables.Personen).people.find((entry) => entry.id === "p2");

  await assert.rejects(
    service.normalizePerson(principal, {
      operationId: "00000000-0000-4000-8000-000000000091",
      personId: "p2",
      expectedFingerprint: "0".repeat(64),
      changes: { firstName: "Petra" },
    }),
    (error) => error.code === "PERSON_CONFLICT" && error.status === 409,
  );
  await assert.rejects(
    service.normalizePerson(principal, {
      operationId: "00000000-0000-4000-8000-000000000092",
      personId: "p2",
      expectedFingerprint: person.fingerprint,
      changes: { login: "ada.admin" },
    }),
    (error) => error.code === "LOGIN_CONFLICT" && error.status === 409,
  );
  assert.equal(fake.calls.valueUpdates.length, 0);
});

test("Personennormalisierung reduziert bestehende Login-Dubletten personweise und erlaubt doppelte E-Mails", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  const loginIndex = fake.tables.Personen[0].indexOf("Login");
  fake.tables.Personen[1][loginIndex] = "shared.login";
  fake.tables.Personen[2][loginIndex] = "shared.login";
  fake.tables.Personen[3][loginIndex] = "other.login";
  fake.tables.Personen[4][loginIndex] = "other.login";
  seedStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  t.after(() => service.stop());
  const person = projectPeopleNormalization(fake.tables.Personen).people.find((entry) => entry.id === "p2");

  const result = await service.normalizePerson(
    { type: "user", id: "p1", role: "admin", name: "Ada Admin" },
    {
      operationId: "00000000-0000-4000-8000-000000000094",
      personId: "p2",
      expectedFingerprint: person.fingerprint,
      changes: { login: "peter.player", email: "ada@example.test" },
    },
  );

  assert.equal(result.success, true);
  assert.equal(fake.calls.valueUpdates.length, 2);
  assert.equal(fake.tables.Personen[2][loginIndex], "peter.player");
  assert.equal(fake.tables.Personen[2][3], "ada@example.test");
  assert.equal(fake.tables.Personen[3][loginIndex], "other.login");
  assert.equal(fake.tables.Personen[4][loginIndex], "other.login");
});

test("Personennormalisierung widerruft Sitzungen exakt fuer Login, Aktiv und Rolle", async (t) => {
  const cases = [
    { field: "email", value: "new@example.test", revoked: false },
    { field: "login", value: "new.login", revoked: true },
    { field: "active", value: "", revoked: true },
    { field: "role", value: "player B", revoked: true },
  ];
  for (const outcome of ["success", "unknown"]) {
    for (const entry of cases) {
      const repository = new StateRepository(":memory:");
      repository.init();
      const fake = fakeSheets(fixtures());
      seedStore(fake.tables);
      if (outcome === "unknown") {
        fake.client.spreadsheets.values.batchUpdateByDataFilter = async () => { throw new Error("update unavailable"); };
      }
      const service = new SheetService({ repository, clientFactory: async () => fake.client });
      t.after(() => service.stop());
      const person = projectPeopleNormalization(fake.tables.Personen).people.find((candidate) => candidate.id === "p2");
      const session = repository.createSession({ userId: "p2", email: "peter@example.test", ttlMs: 60000 });
      const operation = service.normalizePerson(
        { type: "user", id: "p1", role: "admin" },
        {
          operationId: `00000000-0000-4000-8000-${outcome === "success" ? "1" : "2"}${String(cases.indexOf(entry)).padStart(11, "0")}`,
          personId: "p2",
          expectedFingerprint: person.fingerprint,
          changes: { [entry.field]: entry.value },
        },
      );
      if (outcome === "unknown") await assert.rejects(operation, { code: "WRITE_OUTCOME_UNKNOWN" });
      else await operation;
      assert.equal(repository.getSession(session.token) === null, entry.revoked, `${outcome}:${entry.field}`);
    }
  }
});

test("Personennormalisierung meldet die Google-Read-Quote verstaendlich und wiederholbar", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  fake.client.spreadsheets.values.get = async () => {
    throw Object.assign(new Error("Quota exceeded"), { code: 429, response: { status: 429 } });
  };
  const service = new SheetService({ repository, clientFactory: async () => fake.client });

  await assert.rejects(
    service.normalizePerson(
      { type: "user", id: "p1", role: "admin", name: "Ada Admin" },
      {
        operationId: "00000000-0000-4000-8000-000000000093",
        personId: "p2",
        expectedFingerprint: "a".repeat(64),
        changes: { firstName: "Petra" },
      },
    ),
    (error) => (
      error.code === "SHEETS_RATE_LIMITED"
      && error.status === 429
      && error.message === "Die Google-Sheets-Schnittstelle hat ihr Zugriffslimit erreicht. Bitte etwa eine Minute warten und danach erneut versuchen."
      && error.details?.retryAfterMs === 60000
    ),
  );
  assert.equal(fake.calls.valueUpdates.length, 0);
  assert.equal(repository.getOperation("user:p1", "00000000-0000-4000-8000-000000000093", "normalizePerson", {
    personId: "p2",
    expectedFingerprint: "a".repeat(64),
    changes: { firstName: "Petra" },
  }), null);
});

test("parallele Adds bleiben serialisiert, eindeutig und idempotent", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const service = new SheetService({ repository, messagingService, clientFactory: async () => fake.client });
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
  const firstMatch = fake.tables.Matches1.find((row) => row[1] === first.newMatchId);
  assert.equal(firstMatch[6], "p1");
  assert.equal(firstMatch[8], "p2");

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

test("Passwortfreigabe wird gesetzt und beim Passwortwrite verbraucht", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  const person = fake.tables.Personen.find((row) => row[0] === "p2");

  await service.setPasswordSetupAllowed("p2", true);
  assert.equal(person[5], "x");
  await service.setPasswordHash("p2", "new-stored-hash", {
    expectedHash: "b".repeat(64),
    requirePasswordSetupAllowed: true,
  });
  assert.equal(person[4], "new-stored-hash");
  assert.equal(person[5], "");
  await assert.rejects(
    service.setPasswordHash("p2", "another-hash", {
      expectedHash: "new-stored-hash",
      requirePasswordSetupAllowed: true,
    }),
    { code: "PASSWORD_SETUP_INVALID" },
  );

  await service.stop();
  repository.close();
});

test("Passwortvergabe prueft den Aktivstatus im frischen Personen-Stand", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const person = fake.tables.Personen.find((row) => row[0] === "p2");
  person[5] = "x";
  person[8] = "0";
  const service = new SheetService({ repository, clientFactory: async () => fake.client });

  await assert.rejects(
    service.setPasswordHash("p2", "new-stored-hash", {
      expectedHash: "b".repeat(64),
      requirePasswordSetupAllowed: true,
    }),
    { code: "PASSWORD_SETUP_INVALID" },
  );
  assert.equal(person[4], "b".repeat(64));
  assert.equal(person[5], "x");

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
  const service = new SheetService({ repository, messagingService, clientFactory: async () => fake.client });
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

test("Ranglistenforderung uebergibt die aktuellen Positionen als Meldungssnapshot", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const messages = [];
  const service = new SheetService({
    repository,
    messagingService: {
      async ensureChallengeMessages(params) { messages.push(params); },
      async ensureRankingWithdrawalEvent() {},
    },
    clientFactory: async () => fake.client,
  });

  await service.addMatch({ type: "user", id: "p1", name: "Ada Admin" }, {
    operationId: "00000000-0000-4000-8000-000000000128",
    bewerbId: "cup-1",
    opponentId: "p2",
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].challengerRank, 2);
  assert.equal(messages[0].opponentRank, 1);
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
  const service = new SheetService({ repository, messagingService, clientFactory: async () => fake.client });
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

test("eine nach Match-Commit fehlgeschlagene Inbox wird ohne doppelten Match repariert", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  let messageAttempts = 0;
  const failingMessaging = {
    async ensureChallengeMessages() {
      messageAttempts++;
      if (messageAttempts === 1) throw Object.assign(new Error("sqlite unavailable"), { code: "MESSAGING_WRITE_FAILED" });
    },
  };
  const service = new SheetService({ repository, messagingService: failingMessaging, clientFactory: async () => fake.client });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };
  const params = {
    operationId: "00000000-0000-4000-8000-000000000126",
    bewerbId: "cup-1",
    opponentId: "p2",
  };

  await assert.rejects(service.addMatch(principal, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  const recovered = await service.addMatch(principal, params);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.repeated, true);
  assert.equal(fake.calls.append.length, 1);
  assert.equal(messageAttempts, 2);

  await service.stop();
  repository.close();
});

test("wiedergefundene Match-ID wird vor einer Benachrichtigung gegen den Request validiert", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  let messageAttempts = 0;
  const service = new SheetService({
    repository,
    messagingService: { async ensureChallengeMessages() { messageAttempts++; } },
    clientFactory: async () => fake.client,
  });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };
  const operationId = "00000000-0000-4000-8000-000000000127";
  const original = { operationId, bewerbId: "cup-1", opponentId: "p2" };
  await service.addMatch(principal, original);
  assert.equal(repository.deleteOperation("user:p1", operationId, "addMatch", { bewerbId: "cup-1", opponentId: "p2" }), true);

  await assert.rejects(
    service.addMatch(principal, { operationId, bewerbId: "cup-2", opponentId: "p4" }),
    { code: "OPERATION_ID_CONFLICT" },
  );
  assert.equal(fake.calls.append.length, 1);
  assert.equal(messageAttempts, 1);

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
  assert.equal(dataStore.getMeta("entryList").lastMutation, 0);

  fake.tables.EntryList.splice(1);
  const absent = await service.removeEntry(principal, {
    operationId: "00000000-0000-4000-8000-000000000115",
    bewerbId: "cup-1",
  });
  assert.equal(absent.removed, false);
  assert.equal(dataStore.get("entryList").length, 1);
  assert.equal(dataStore.getMeta("entryList").lastMutation, 0);

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

test("Profilprojektion kann Forderbarkeit mit denselben Serverregeln pruefen", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const initial = fixtures();
  seedStore(initial);
  const service = new SheetService({ repository, clientFactory: async () => fakeSheets(initial).client });

  assert.deepEqual(
    service.challengeEligibility({ type: "user", id: "p1" }, "cup-1", "p2"),
    { allowed: true, code: "" },
  );
  assert.deepEqual(
    service.challengeEligibility({ type: "user", id: "p2" }, "cup-1", "p1"),
    { allowed: false, code: "CHALLENGE_NOT_ALLOWED" },
  );
  assert.deepEqual(
    service.challengeEligibility({ type: "user", id: "p1" }, "cup-1", "p1"),
    { allowed: false, code: "MATCH_SELF" },
  );
  const invalidMatches = structuredClone(initial.Matches1);
  invalidMatches.push(["", "m-invalid", "", "260829-1200", "cup-1", "", "p2", "", "p1", "", "6-4/6-4"]);
  dataStore.set("matches1", invalidMatches, { source: "test-invalid" });
  assert.deepEqual(
    service.challengeEligibility({ type: "user", id: "p1" }, "cup-1", "p2"),
    { allowed: false, code: "MATCH_DATA_INVALID" },
  );

  await service.stop();
  repository.close();
});

test("rausgehaengte Spieler fordern ab ihrem gespeicherten Rang und dahinter", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const initial = fixtures();
  initial.Rangliste[2] = ["r2", "cup-1", "p1", "0", "260829-1200", "2", "Pause"];
  initial.Rangliste.push(["r5", "cup-1", "p3", "2", "", "", ""]);
  initial.Rangliste.push(["r6", "cup-1", "p4", "3", "", "", ""]);
  const fake = fakeSheets(initial);
  seedStore(fake.tables);
  const service = new SheetService({ repository, messagingService, clientFactory: async () => fake.client, now: () => Date.UTC(2026, 7, 29, 11, 0) });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };

  assert.deepEqual(service.challengeEligibility(principal, "cup-1", "p2"), { allowed: false, code: "CHALLENGE_NOT_ALLOWED" });
  assert.deepEqual(service.challengeEligibility(principal, "cup-1", "p3"), { allowed: true, code: "" });
  assert.deepEqual(service.challengeEligibility(principal, "cup-1", "p4"), { allowed: true, code: "" });
  const match = await service.addMatch(principal, {
    operationId: "00000000-0000-4000-8000-000000000125",
    bewerbId: "cup-1",
    opponentId: "p4",
  });
  assert.equal(match.success, true);
  assert.equal(fake.tables.Matches1.at(-1)[6], "p1");
  assert.equal(fake.tables.Matches1.at(-1)[8], "p4");
  const expiredRankings = structuredClone(dataStore.get("rlPlatzierung"));
  expiredRankings.find((row) => row[2] === "p1")[4] = "250829-1059";
  dataStore.set("rlPlatzierung", expiredRankings, { source: "test-expired" });
  dataStore.set("matches1", [initial.Matches1[0]], { source: "test-expired" });
  assert.deepEqual(service.rankingChallengeState(principal, "cup-1"), {
    success: true, mode: "newcomer", rank: null, returnFromRank: null,
  });
  assert.deepEqual(service.challengeEligibility(principal, "cup-1", "p2"), { allowed: true, code: "" });

  await service.stop();
  repository.close();
});

test("Neueinsteiger fordern jeden freien Rang ohne automatische Einreihung", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const initial = fixtures();
  const fake = fakeSheets(initial);
  seedStore(fake.tables);
  const service = new SheetService({ repository, messagingService, clientFactory: async () => fake.client, now: () => Date.UTC(2026, 7, 29, 11, 0) });
  const principal = { type: "user", id: "p3", name: "Chris Challenger" };
  const rankingBefore = structuredClone(fake.tables["RL-Platzierung"]);

  assert.deepEqual(service.rankingChallengeState(principal, "cup-1"), {
    success: true, mode: "newcomer", rank: null, returnFromRank: null,
  });
  assert.deepEqual(service.challengeEligibility(principal, "cup-1", "p2"), { allowed: true, code: "" });
  assert.deepEqual(service.challengeEligibility(principal, "cup-1", "p1"), { allowed: true, code: "" });
  const match = await service.addMatch(principal, {
    operationId: "00000000-0000-4000-8000-000000000127",
    bewerbId: "cup-1",
    opponentId: "p1",
  });
  assert.equal(match.success, true);
  assert.deepEqual(fake.tables["RL-Platzierung"], rankingBefore);
  assert.equal(fake.tables.Matches1.at(-1)[6], "p3");
  assert.equal(fake.tables.Matches1.at(-1)[8], "p1");

  await service.stop();
  repository.close();
});

test("Neueinsteiger muessen Geschlecht und Alterskategorie des Bewerbs erfuellen", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const initial = fixtures();
  initial.Bewerb[0].push("Geschlecht", "Alterskategorie");
  initial.Bewerb[1].push("2", "60+");
  initial.Bewerb[2].push("", "");
  const playerHeader = initial.Personen[0];
  const legacyGenderIndex = playerHeader.indexOf("Geschlecht");
  playerHeader.push("GeschlechtID");
  const genderIndex = playerHeader.indexOf("GeschlechtID");
  const birthDateIndex = playerHeader.indexOf("GeburtsDatum");
  const newcomer = initial.Personen.find((row) => row[0] === "p3");
  newcomer[legacyGenderIndex] = "1";
  newcomer[genderIndex] = "2";
  newcomer[birthDateIndex] = "31.12.1966";
  seedStore(initial);
  const service = new SheetService({ repository, clientFactory: async () => fakeSheets(initial).client, now: () => Date.UTC(2026, 0, 1, 0, 30) });
  const principal = { type: "user", id: "p3", name: "Chris Challenger" };

  assert.deepEqual(service.rankingChallengeState(principal, "cup-1"), {
    success: true, mode: "newcomer", rank: null, returnFromRank: null,
  });
  newcomer[genderIndex] = "3";
  dataStore.set("players", structuredClone(initial.Personen), { source: "test-gender" });
  assert.deepEqual(service.rankingChallengeState(principal, "cup-1"), {
    success: true, mode: "ineligible", rank: null, returnFromRank: null,
  });
  assert.deepEqual(service.challengeEligibility(principal, "cup-1", "p2"), { allowed: false, code: "RANKING_ENTRY_NOT_ELIGIBLE" });

  newcomer[genderIndex] = "2";
  newcomer[birthDateIndex] = "01.01.1967";
  dataStore.set("players", structuredClone(initial.Personen), { source: "test-age" });
  assert.deepEqual(service.challengeEligibility(principal, "cup-1", "p2"), { allowed: false, code: "RANKING_ENTRY_NOT_ELIGIBLE" });
  newcomer[birthDateIndex] = "";
  dataStore.set("players", structuredClone(initial.Personen), { source: "test-missing-age" });
  assert.deepEqual(service.challengeEligibility(principal, "cup-1", "p2"), { allowed: false, code: "RANKING_ENTRY_NOT_ELIGIBLE" });

  initial.Bewerb[1][initial.Bewerb[0].indexOf("Alterskategorie")] = "18-";
  newcomer[birthDateIndex] = "31.12.2008";
  dataStore.set("players", structuredClone(initial.Personen), { source: "test-youth" });
  dataStore.set("bewerbe", structuredClone(initial.Bewerb), { source: "test-youth" });
  assert.deepEqual(service.challengeEligibility(principal, "cup-1", "p2"), { allowed: true, code: "" });
  newcomer[birthDateIndex] = "01.01.2027";
  dataStore.set("players", structuredClone(initial.Personen), { source: "test-future-birth" });
  assert.deepEqual(service.challengeEligibility(principal, "cup-1", "p2"), { allowed: false, code: "RANKING_ENTRY_NOT_ELIGIBLE" });

  initial.Bewerb[1][initial.Bewerb[0].indexOf("Alterskategorie")] = "Senioren";
  dataStore.set("bewerbe", structuredClone(initial.Bewerb), { source: "test-invalid-age-rule" });
  assert.throws(() => service.rankingChallengeState(principal, "cup-1"), { code: "SHEET_SCHEMA" });

  await service.stop();
  repository.close();
});

test("Neueinsteiger behalten offene-Forderung-, Sperr- und Schonzeitregeln", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const initial = fixtures();
  seedStore(initial);
  const service = new SheetService({ repository, clientFactory: async () => fakeSheets(initial).client, now: () => Date.UTC(2026, 7, 29, 11, 0) });
  const principal = { type: "user", id: "p3", name: "Chris Challenger" };
  const header = initial.Matches1[0];

  dataStore.set("matches1", [header, ["", "open", "", "260829-1000", "cup-1", "", "p3", "", "p1", "", ""]], { source: "test-busy" });
  assert.deepEqual(service.challengeEligibility(principal, "cup-1", "p2"), { allowed: false, code: "PLAYER_BUSY" });
  dataStore.set("matches1", [header, ["", "lost", "260828-1000", "", "cup-1", "", "p3", "", "p4", "", "4-6/4-6"]], { source: "test-blocked" });
  assert.deepEqual(service.challengeEligibility(principal, "cup-1", "p2"), { allowed: false, code: "PLAYER_BLOCKED" });
  dataStore.set("matches1", [header, ["", "won", "260828-1000", "", "cup-1", "", "p2", "", "p4", "", "6-4/6-4"]], { source: "test-protected" });
  assert.deepEqual(service.challengeEligibility(principal, "cup-1", "p2"), { allowed: false, code: "OPPONENT_PROTECTED" });

  await service.stop();
  repository.close();
});

test("abgelehnte Selbstforderung behaelt einen geplanten Matchrefresh", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };
  service.scheduleRefresh("matches1");

  await assert.rejects(service.addMatch(principal, {
    operationId: "00000000-0000-4000-8000-000000000097",
    bewerbId: "cup-1",
    opponentId: "p1",
  }), { code: "MATCH_SELF" });
  assert.equal(service.status().scheduledRefreshes, 1);
  await service.stop();
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

test("Ranglistenrueckzug schreibt die Mitgliedschaft und wird lokal dedupliziert", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const initial = fixtures();
  initial.Rangliste.push(["r5", "cup-1", "p3", "3", "", "", ""]);
  const fake = fakeSheets(initial);
  seedStore(fake.tables);
  const withdrawalEvents = [];
  const service = new SheetService({
    repository,
    messagingService: { ...messagingService, async ensureRankingWithdrawalEvent(params) { withdrawalEvents.push(params); } },
    clientFactory: async () => fake.client,
    now: () => Date.UTC(2026, 7, 29, 10, 30),
  });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };
  const params = {
    operationId: "00000000-0000-4000-8000-000000000117",
    bewerbId: "cup-1",
    rank: 2,
    reason: "Test rueckzug",
  };

  const first = await service.withdrawFromRanking(principal, params);
  assert.deepEqual(first, {
    success: true,
    withdrawnAt: "260829-1230",
    previousRank: 2,
    shiftedCount: 1,
  });
  assert.deepEqual(first._audit, {
    before: { bewerbId: "cup-1", rank: 2 },
    after: { rank: 0, withdrawnAt: "260829-1230", shiftedCount: 1, reasonRecorded: true },
  });
  assert.deepEqual(fake.tables["RL-Platzierung"][2].slice(3), [0, "260829-1230", 2, "Test rueckzug"]);
  assert.equal(fake.tables["RL-Platzierung"].find((row) => row[2] === "p3" && row[1] === "cup-1")[3], 2);
  assert.equal(fake.calls.metadataCreates, 2);
  assert.equal(fake.calls.spreadsheetUpdates, 1);
  assert.equal(fake.calls.metadataRows, 1);
  assert.equal(fake.calls.append.filter((call) => call.range === "Logging").length, 0);
  assert.deepEqual(withdrawalEvents.map(({ competitionId, participantId, operationId, reason }) => ({ competitionId, participantId, operationId, reason })), [{
    competitionId: "cup-1",
    participantId: "p1",
    operationId: params.operationId,
    reason: "Test rueckzug",
  }]);

  const repeated = await service.withdrawFromRanking(principal, params);
  assert.equal(repeated.repeated, true);
  assert.equal(fake.calls.append.filter((call) => call.range === "Logging").length, 0);

  await service.stop();
  repository.close();
});

test("Ranglistenrueckzug wird bei einer offenen Forderung abgelehnt", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const initial = fixtures();
  initial.Matches1.push(["", "m-open", "", "260829-1200", "cup-1", "F", "p1", "", "p2", "", ""]);
  const fake = fakeSheets(initial);
  seedStore(fake.tables);
  const service = new SheetService({ repository, clientFactory: async () => fake.client });

  await assert.rejects(service.withdrawFromRanking(
    { type: "user", id: "p1", name: "Ada Admin" },
    { operationId: "00000000-0000-4000-8000-000000000121", bewerbId: "cup-1", rank: 2, reason: "Test rueckzug" },
  ), { code: "RANKING_WITHDRAWAL_MATCH_OPEN" });
  assert.equal(fake.calls.valueUpdates.length, 0);

  await service.stop();
  repository.close();
});

test("eine nach dem Raushängen fehlgeschlagene Meldung wird ohne zweiten Sheet-Write repariert", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  let eventAttempts = 0;
  const service = new SheetService({
    repository,
    messagingService: {
      async ensureRankingWithdrawalEvent() {
        eventAttempts++;
        if (eventAttempts === 1) throw Object.assign(new Error("sqlite unavailable"), { code: "MESSAGING_WRITE_FAILED" });
      },
    },
    clientFactory: async () => fake.client,
    now: () => Date.UTC(2026, 7, 29, 10, 30),
  });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };
  const params = {
    operationId: "00000000-0000-4000-8000-000000000128",
    bewerbId: "cup-1",
    rank: 2,
    reason: "Test rueckzug",
  };

  await assert.rejects(service.withdrawFromRanking(principal, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  const recovered = await service.withdrawFromRanking(principal, params);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.repeated, true);
  assert.equal(eventAttempts, 2);
  assert.equal(fake.calls.spreadsheetUpdates, 1);

  await service.stop();
  repository.close();
});

test("Ranglistenrueckzug buendelt vierundzwanzig Metadatenzeilen in konstante API-Aufrufe", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const initial = fixtures();
  const header = initial.Rangliste[0];
  initial.Rangliste.splice(0, initial.Rangliste.length, header);
  for (let rank = 1; rank <= 24; rank++) {
    initial.Rangliste.push([`bulk-${rank}`, "cup-1", rank === 1 ? "p1" : `bulk-p${rank}`, String(rank), "", "", ""]);
  }
  const fake = fakeSheets(initial);
  seedStore(fake.tables);
  const service = new SheetService({ repository, messagingService, clientFactory: async () => fake.client, now: () => Date.UTC(2026, 7, 29, 10, 30) });

  const result = await service.withdrawFromRanking(
    { type: "user", id: "p1", name: "Ada Admin" },
    { operationId: "00000000-0000-4000-8000-000000000123", bewerbId: "cup-1", rank: 1, reason: "Test rueckzug" },
  );

  assert.equal(result.shiftedCount, 23);
  assert.equal(fake.calls.valueGets, 2);
  assert.equal(fake.calls.metadataSearches, 1);
  assert.equal(fake.calls.spreadsheetUpdates, 1);
  assert.equal(fake.calls.metadataCreates, 24);
  assert.equal(fake.calls.metadataRows, 1);

  await service.stop();
  repository.close();
});

test("Ranglistenrueckzug bereinigt Metadatendubletten aller Zielzeilen in einem Batch", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const initial = fixtures();
  const header = initial.Rangliste[0];
  initial.Rangliste.splice(0, initial.Rangliste.length, header);
  for (let rank = 1; rank <= 24; rank++) {
    initial.Rangliste.push([`duplicate-${rank}`, "cup-1", rank === 1 ? "p1" : `duplicate-p${rank}`, String(rank), "", "", ""]);
  }
  const fake = fakeSheets(initial);
  for (let rowIndex = 1; rowIndex <= 24; rowIndex++) {
    const personId = rowIndex === 1 ? "p1" : `duplicate-p${rowIndex}`;
    fake.seedRecordMetadata("RL-Platzierung", rowIndex, `membership:cup-1:${personId}`);
    fake.seedRecordMetadata("RL-Platzierung", rowIndex, `membership:cup-1:${personId}`);
  }
  seedStore(fake.tables);
  const service = new SheetService({ repository, messagingService, clientFactory: async () => fake.client, now: () => Date.UTC(2026, 7, 29, 11, 0) });
  const cleanupAttempts = [];
  const cleanupResults = [];
  t.mock.method(metrics, "recordSheetApiAttempt", (entry) => {
    if (entry.method === "metadata_cleanup") cleanupAttempts.push(entry);
  });
  t.mock.method(metrics, "recordSheetApiRequest", (entry) => {
    if (entry.method === "metadata_cleanup") cleanupResults.push(entry);
  });

  const result = await service.withdrawFromRanking(
    { type: "user", id: "p1", name: "Ada Admin" },
    { operationId: "00000000-0000-4000-8000-000000000126", bewerbId: "cup-1", rank: 1, reason: "Test rueckzug" },
  );

  assert.equal(result.shiftedCount, 23);
  assert.equal(fake.calls.metadataSearches, 2);
  assert.equal(fake.calls.spreadsheetUpdates, 1);
  assert.equal(fake.calls.metadataCreates, 0);
  assert.equal(fake.calls.metadataRows, 1);
  assert.deepEqual(cleanupAttempts, [{ method: "metadata_cleanup", purpose: "metadata_cleanup", kind: "initial" }]);
  assert.equal(cleanupResults.length, 1);
  assert.deepEqual({
    method: cleanupResults[0].method,
    purpose: cleanupResults[0].purpose,
    result: cleanupResults[0].result,
  }, { method: "metadata_cleanup", purpose: "metadata_cleanup", result: "success" });

  await service.stop();
  repository.close();
});

test("gebuendelte Metadatensuche lehnt denselben Schluessel auf verschiedenen Zeilen ab", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  fake.seedRecordMetadata("RL-Platzierung", 1, "membership:cup-1:p2");
  fake.seedRecordMetadata("RL-Platzierung", 2, "membership:cup-1:p2");
  const service = new SheetService({ repository, clientFactory: async () => fake.client });

  await assert.rejects(
    service.searchRecordMetadataBatch(fake.client, "rlPlatzierung", ["membership:cup-1:p2"]),
    { code: "SHEET_SCHEMA" },
  );
  assert.equal(fake.calls.spreadsheetUpdates, 0);

  await service.stop();
  repository.close();
});

test("unklarer Ranglistenrueckzug wird ueber den gespeicherten Plan bestaetigt", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const originalUpdate = fake.client.spreadsheets.values.batchUpdateByDataFilter;
  const originalRead = fake.client.spreadsheets.values.batchGetByDataFilter;
  let writeAttempted = false;
  fake.client.spreadsheets.values.batchUpdateByDataFilter = async (request) => {
    const result = await originalUpdate(request);
    writeAttempted = true;
    throw new Error("response lost");
  };
  fake.client.spreadsheets.values.batchGetByDataFilter = async (request) => {
    if (writeAttempted) throw new Error("confirmation unavailable");
    return originalRead(request);
  };
  const service = new SheetService({ repository, messagingService, clientFactory: async () => fake.client, now: () => Date.UTC(2026, 7, 29, 10, 30) });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };
  const params = { operationId: "00000000-0000-4000-8000-000000000122", bewerbId: "cup-1", rank: 2, reason: "Test rueckzug" };

  await assert.rejects(service.withdrawFromRanking(principal, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  fake.client.spreadsheets.values.batchGetByDataFilter = originalRead;
  const recovered = await service.withdrawFromRanking(principal, params);
  assert.equal(recovered.success, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.repeated, true);
  assert.equal(fake.calls.valueUpdates.filter((update) => update.index === 3 && update.value === 0).length, 1);

  await service.stop();
  repository.close();
});

test("Ranglistenrueckzug setzt nach unklarer Bulk-Metadatenerstellung mit demselben Plan fort", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  const originalMetadataUpdate = fake.client.spreadsheets.batchUpdate;
  fake.client.spreadsheets.batchUpdate = async () => { throw new Error("metadata unavailable"); };
  const service = new SheetService({ repository, messagingService, clientFactory: async () => fake.client, now: () => Date.UTC(2026, 7, 29, 10, 30) });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };
  const params = { operationId: "00000000-0000-4000-8000-000000000124", bewerbId: "cup-1", rank: 2, reason: "Test rueckzug" };

  await assert.rejects(service.withdrawFromRanking(principal, params), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal(fake.calls.valueUpdates.length, 0);
  fake.client.spreadsheets.batchUpdate = originalMetadataUpdate;
  const recovered = await service.withdrawFromRanking(principal, params);
  assert.equal(recovered.success, true);
  assert.equal(recovered.repeated, true);
  assert.equal(fake.tables["RL-Platzierung"].find((row) => row[2] === "p1")[3], 0);

  await service.stop();
  repository.close();
});

test("Ranglistenrueckzug ist unabhaengig vom entfernten Logging-Sheet", async () => {
  const repository = new StateRepository(":memory:");
  repository.init();
  const fake = fakeSheets(fixtures());
  seedStore(fake.tables);
  fake.client.spreadsheets.values.append = async () => { throw new Error("Kein Append erwartet"); };
  const service = new SheetService({ repository, messagingService, clientFactory: async () => fake.client });
  const principal = { type: "user", id: "p1", name: "Ada Admin" };
  const params = {
    operationId: "00000000-0000-4000-8000-000000000120",
    bewerbId: "cup-1",
    rank: 2,
    reason: "Test rueckzug",
  };

  const result = await service.withdrawFromRanking(principal, params);
  assert.equal(result.success, true);
  assert.equal(result.previousRank, 2);
  const repeated = await service.withdrawFromRanking(principal, params);
  assert.equal(repeated.repeated, true);

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
  const rankingRefresh = setTimeout(() => {}, 60000);
  rankingRefresh.unref();
  service.refreshTimers.set("rlPlatzierung", rankingRefresh);
  await assert.rejects(service.withdrawFromRanking(principal, {
    operationId: "00000000-0000-4000-8000-000000000109",
    bewerbId: "cup-1",
    rank: 99,
    reason: "Test rueckzug",
  }), { code: "RANK_CONFLICT" });
  assert.equal(service.refreshTimers.get("rlPlatzierung"), rankingRefresh);
  assert.equal(fake.calls.append.length, 0);

  await service.stop();
  repository.close();
});
