const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const modulePromise = import(pathToFileURL(path.join(__dirname, "../../Frontend/JS/memberImport.js")));
const headers = [
  "[Id]", "[Gruppen]", "Nachname", "Vorname", "Geburtsdatum", "Geschlecht",
  "Telefon Mobil", "E-Mail", "Land", "PLZ", "Ort", "Adresse",
];

function bytes(text) {
  return Uint8Array.from([...text].map((character) => character.charCodeAt(0))).buffer;
}

function csv(rows, customHeaders = headers) {
  return bytes([customHeaders, ...rows].map((row) => row.join(";")).join("\r\n"));
}

function row(overrides = {}) {
  const values = {
    id: "101", groups: "A-Mitglieder", lastName: "Muster", firstName: "Anna",
    birthDate: "02.01.1990", gender: "weiblich", phone: "+43 664 123 45 67",
    email: "anna@example.test", country: "Österreich", postalCode: "4060",
    city: "Piberbach", address: "Dorf 1", ...overrides,
  };
  return [values.id, values.groups, values.lastName, values.firstName, values.birthDate,
    values.gender, values.phone, values.email, values.country, values.postalCode,
    values.city, values.address];
}

function person(id, externalId, values = {}) {
  return {
    id,
    externalId,
    fingerprint: id.repeat(64).slice(0, 64),
    values: {
      firstName: "Anna", lastName: "Muster", birthDate: "02.01.1990", gender: "2",
      phone: "0043 664 123 45 67", email: "anna@example.test", login: "", country: "Österreich",
      postalCode: "4060", city: "Piberbach", address: "Dorf 1", active: "1",
      role: "player A", ...values,
    },
    secret: "must not survive projection",
  };
}

test("decodes Windows-1252 and projects only controlled fields", async () => {
  const { parseClubDeskCsv, VALUE_FIELDS } = await modulePromise;
  const customHeaders = [...headers, "IBAN", "Interne Notiz"];
  const source = row({ lastName: "M\xfcller", country: "\xd6sterreich" });
  source.push("AT000000", "private");
  const [record] = parseClubDeskCsv(csv([source], customHeaders));

  assert.equal(record.values.lastName, "Müller");
  assert.equal(record.values.country, "Österreich");
  assert.deepEqual(Object.keys(record.values), VALUE_FIELDS);
  assert.equal(record.values.login, "");
  assert.equal(headers.includes("Login"), false);
  assert.equal(JSON.stringify(record).includes("IBAN"), false);
  assert.equal(JSON.stringify(record).includes("private"), false);
});

test("parses quoted semicolon fields and escaped quotes, rejecting malformed quoting", async () => {
  const { parseClubDeskCsv } = await modulePromise;
  const quoted = row({ address: 'Dorf; Haus "A"' }).map((value) => `"${value.replaceAll('"', '""')}"`);
  assert.equal(parseClubDeskCsv(csv([quoted]))[0].values.address, 'Dorf; Haus "A"');
  assert.throws(() => parseClubDeskCsv(bytes(`${headers.join(";")}\n${row()[0]};"offen`)), { code: "CSV_MALFORMED_QUOTING" });
  assert.throws(() => parseClubDeskCsv(bytes(`${headers.join(";")}\n${row()[0]};x"y"`)), { code: "CSV_MALFORMED_QUOTING" });
});

test("enforces exact required headers, file/row limits, and unique numeric IDs", async () => {
  const { MAX_FILE_BYTES, parseClubDeskCsv } = await modulePromise;
  assert.throws(() => parseClubDeskCsv(csv([row()], headers.filter((name) => name !== "Land"))), { code: "CSV_REQUIRED_HEADER_MISSING" });
  assert.throws(() => parseClubDeskCsv(csv([row()], [...headers, "Land"])), { code: "CSV_REQUIRED_HEADER_DUPLICATE" });
  assert.throws(() => parseClubDeskCsv(csv([row({ id: "x1" })])), { code: "CSV_ID_INVALID" });
  assert.throws(() => parseClubDeskCsv(csv([row({ id: "0" })])), { code: "CSV_ID_INVALID" });
  assert.throws(() => parseClubDeskCsv(csv([row(), row()])), { code: "CSV_ID_DUPLICATE" });
  assert.throws(() => parseClubDeskCsv(csv([row().slice(0, -1)])), { code: "CSV_COLUMN_COUNT_INVALID" });
  assert.throws(() => parseClubDeskCsv(new ArrayBuffer(MAX_FILE_BYTES + 1)), { code: "CSV_FILE_TOO_LARGE" });
  const manyRows = Array.from({ length: 2001 }, (_, index) => row({ id: String(index + 1) }));
  assert.throws(() => parseClubDeskCsv(csv(manyRows)), { code: "CSV_TOO_MANY_ROWS" });
});

test("canonicalizes exact preview values and marks invalid import fields", async () => {
  const { parseClubDeskCsv } = await modulePromise;
  const [record] = parseClubDeskCsv(csv([row({
    email: " ANNA@MÜNCHEN.example ",
    postalCode: "A-4060",
    birthDate: "2020-01-01",
  })]));
  assert.equal(record.values.email, "anna@xn--mnchen-3ya.example");
  assert.deepEqual(record.issues, [
    { field: "birthDate", code: "IMPORT_VALUE_INVALID" },
    { field: "postalCode", code: "IMPORT_VALUE_INVALID" },
  ]);
});

test("maps groups, gender, and safely convertible Austrian phones", async () => {
  const { parseClubDeskCsv } = await modulePromise;
  const records = parseClubDeskCsv(csv([
    row(),
    row({ id: "102", groups: "B-Mitglieder", gender: "männlich" }),
    row({ id: "103", groups: "A-Mitglieder,B-Mitglieder", gender: "divers" }),
    row({ id: "104", groups: "Sonstige", gender: "", phone: "0664 1234567" }),
    row({ id: "105", groups: "A-Mitglieder (Trainer), Trainer (Trainer), Vorstand (Obmann Stv.)" }),
    row({ id: "106", groups: "B-Mitglieder (Jugend), Funktionär" }),
  ]));
  assert.deepEqual(records.map((record) => record.values.role), ["player A", "player B", "player A", "player", "player A", "player B"]);
  assert.deepEqual(records.map((record) => record.values.gender), ["2", "1", "", "", "2", "2"]);
  assert.equal(records[0].values.phone, "0043 664 123 45 67");
  assert.equal(records[3].values.phone, "0664 1234567");
  assert.deepEqual(records[3].issues, [{ field: "phone", code: "PHONE_COMPARISON_UNCLEAR" }]);
});

test("matches unique ClubDesk IDs and exposes changes without selecting values", async () => {
  const { compareClubDeskMembers, parseClubDeskCsv } = await modulePromise;
  const [record] = parseClubDeskCsv(csv([row({ city: "Neuer Ort" })]));
  const result = compareClubDeskMembers([record], [person("p1", "101")]);
  assert.equal(result.changed.length, 1);
  assert.deepEqual(result.changed[0].differences, [{ field: "city", before: "Piberbach", import: "Neuer Ort" }]);
  assert.equal(result.changed[0].match, "externalId");
  assert.equal(result.changed[0].requiresConfirmation, false);
  assert.equal(Object.hasOwn(result.changed[0].person, "secret"), false);
});

test("existing Login never follows imported contact E-Mail or appears as a difference", async () => {
  const { compareClubDeskMembers, parseClubDeskCsv } = await modulePromise;
  const [record] = parseClubDeskCsv(csv([row({ email: "new-contact@example.test", city: "Linz" })]));
  const result = compareClubDeskMembers([record], [person("p1", "101", { login: "private-login@example.test" })]);
  assert.deepEqual(result.changed[0].differences.map(({ field }) => field), ["email", "city"]);
  assert.equal(result.changed[0].person.values.login, "private-login@example.test");
  assert.equal(result.changed[0].import.values.login, "");
});

test("exact normalized identity is only a confirmation-required proposal", async () => {
  const { compareClubDeskMembers, parseClubDeskCsv } = await modulePromise;
  const [record] = parseClubDeskCsv(csv([row({ firstName: " ANNA ", lastName: "MUSTER" })]));
  const result = compareClubDeskMembers([record], [person("p1", "")]);
  assert.equal(result.unclear.length, 1);
  assert.equal(result.unclear[0].match, "proposed");
  assert.equal(result.unclear[0].requiresConfirmation, true);
  assert.equal(result.identical.length, 0);
});

test("classifies new and missing while excluding protected and inactive people", async () => {
  const { compareClubDeskMembers, parseClubDeskCsv } = await modulePromise;
  const [record] = parseClubDeskCsv(csv([row({
    id: "999", firstName: "Neu", lastName: "Person", email: "neu@example.test",
  })]));
  const result = compareClubDeskMembers([record], [
    person("p1", "101"),
    person("p2", "102", { role: "admin", email: "admin@example.test" }),
    person("p3", "103", { role: "operator", email: "operator@example.test" }),
    person("p4", "104", { active: "", email: "inactive@example.test" }),
  ]);
  assert.equal(result.new.length, 1);
  assert.deepEqual(result.missing.map((entry) => entry.person.id), ["p1"]);
  assert.deepEqual(result.identical.map((entry) => entry.person.id), ["p2", "p3", "p4"]);
});

test("empty imported fields preserve existing values and protected roles", async () => {
  const { compareClubDeskMembers, parseClubDeskCsv } = await modulePromise;
  const [record] = parseClubDeskCsv(csv([row({ email: "", city: "", groups: "B-Mitglieder" })]));
  const result = compareClubDeskMembers([record], [person("p1", "101", { role: "admin" })]);
  assert.equal(result.identical.length, 1);
  assert.deepEqual(result.identical[0].differences, []);
});

test("duplicate contact emails are accepted and leave Login empty", async () => {
  const { compareClubDeskMembers, parseClubDeskCsv } = await modulePromise;
  const records = parseClubDeskCsv(csv([
    row(),
    row({ id: "102", firstName: "Berta", email: "ANNA@example.test" }),
  ]));
  const emailResult = compareClubDeskMembers(records, []);
  assert.equal(emailResult.conflict.length, 0);
  assert.equal(emailResult.new.length, 2);
  assert.deepEqual(emailResult.new.map((entry) => entry.import.values.login), ["", ""]);
  assert.equal(Object.hasOwn(emailResult, "loginFamilies"), false);

  const collision = compareClubDeskMembers([records[0]], [
    person("p1", "101"),
    person("p2", "101", { email: "other@example.test" }),
  ]);
  assert.equal(collision.conflict.length, 1);
  assert.ok(collision.conflict[0].issues.some((issue) => issue.code === "EXTERNAL_ID_CONFLICT"));
  assert.ok(collision.conflict[0].issues.every((issue) => !issue.code.startsWith("EMAIL_")));
});

test("duplicate contact email has no special deactivation side effect", async () => {
  const { compareClubDeskMembers, parseClubDeskCsv } = await modulePromise;
  const records = parseClubDeskCsv(csv([
    row({ id: "998", firstName: "Neu", lastName: "Mitglied" }),
    row({ id: "999", firstName: "Zweit", lastName: "Mitglied" }),
  ]));
  const result = compareClubDeskMembers(records, [person("p1", "101")]);
  assert.equal(result.conflict.length, 0);
  assert.equal(result.new.length, 2);
  assert.deepEqual(result.missing.map((entry) => entry.person.id), ["p1"]);
  assert.deepEqual(result.new.map((entry) => entry.import.values.login), ["", ""]);
});

test("unique new contact proposes Login only without an existing Login collision", async () => {
  const { compareClubDeskMembers, parseClubDeskCsv } = await modulePromise;
  const records = parseClubDeskCsv(csv([
    row({ id: "201", firstName: "Dora", email: "unique@example.test" }),
    row({ id: "202", firstName: "Erna", email: "owned@example.test" }),
  ]));
  const result = compareClubDeskMembers(records, [
    person("p1", "101", { email: "shared-contact@example.test", login: "owned@example.test" }),
  ]);
  assert.equal(result.new.find((entry) => entry.import.externalId === "201").import.values.login, "unique@example.test");
  assert.equal(result.new.find((entry) => entry.import.externalId === "202").import.values.login, "");

  const refreshed = compareClubDeskMembers([records[0]], [
    person("p2", "102", { login: "unique@example.test" }),
  ]);
  assert.equal(records[0].values.login, "");
  assert.equal(refreshed.new[0].import.values.login, "");
});

test("existing people preserve Login when sharing a contact email", async () => {
  const { compareClubDeskMembers, parseClubDeskCsv } = await modulePromise;
  const records = parseClubDeskCsv(csv([
    row({ id: "101", firstName: "Anna", email: "family@example.test" }),
    row({ id: "102", firstName: "Berta", birthDate: "03.02.1991", email: "family@example.test" }),
  ]));
  const result = compareClubDeskMembers(records, [
    person("p1", "101", { email: "family@example.test", login: "family@example.test" }),
    person("p2", "102", { firstName: "Berta", birthDate: "03.02.1991", email: "family@example.test", login: "" }),
  ]);
  assert.equal(result.conflict.length, 0);
  assert.equal(result.identical.every((entry) => entry.differences.every(({ field }) => field !== "login")), true);
});

test("ambiguous and duplicate initial identities never become new automatic records", async () => {
  const { compareClubDeskMembers, parseClubDeskCsv } = await modulePromise;
  const [record] = parseClubDeskCsv(csv([row({ email: "" })]));
  const ambiguous = compareClubDeskMembers([record], [
    person("p1", "", { email: "" }),
    person("p2", "", { email: "", city: "Linz" }),
  ]);
  assert.equal(ambiguous.conflict.length, 1);
  assert.equal(ambiguous.new.length, 0);
  assert.ok(ambiguous.conflict[0].issues.some((issue) => issue.code === "IDENTITY_CONFLICT"));

  const duplicateRecords = parseClubDeskCsv(csv([
    row({ id: "101", email: "" }),
    row({ id: "102", email: "" }),
  ]));
  const duplicate = compareClubDeskMembers(duplicateRecords, []);
  assert.equal(duplicate.conflict.length, 2);
  assert.equal(duplicate.new.length, 0);
  assert.ok(duplicate.conflict.every((entry) => entry.issues.some((issue) => issue.code === "IDENTITY_DUPLICATE")));
});
