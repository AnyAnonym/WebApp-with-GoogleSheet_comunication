import { canonicalizePersonValue } from "./personValues.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DATA_ROWS = 2000;

const REQUIRED_HEADERS = Object.freeze([
  "[Id]",
  "[Gruppen]",
  "Nachname",
  "Vorname",
  "Geburtsdatum",
  "Geschlecht",
  "Telefon Mobil",
  "E-Mail",
  "Land",
  "PLZ",
  "Ort",
  "Adresse",
]);

const VALUE_FIELDS = Object.freeze([
  "firstName",
  "lastName",
  "birthDate",
  "gender",
  "phone",
  "email",
  "login",
  "country",
  "postalCode",
  "city",
  "address",
  "active",
  "role",
]);

const HEADER_FIELDS = Object.freeze({
  Nachname: "lastName",
  Vorname: "firstName",
  Geburtsdatum: "birthDate",
  "Telefon Mobil": "phone",
  "E-Mail": "email",
  Land: "country",
  PLZ: "postalCode",
  Ort: "city",
  Adresse: "address",
});

export class MemberImportError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "MemberImportError";
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, details) {
  throw new MemberImportError(code, details);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  let fieldStarted = false;

  const finishField = () => {
    row.push(field);
    field = "";
    quoted = false;
    quoteClosed = false;
    fieldStarted = false;
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (text[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = false;
        quoteClosed = true;
      }
      continue;
    }

    if (quoteClosed) {
      if (character === ";") {
        finishField();
      } else if (character === "\n" || character === "\r") {
        if (character === "\r" && text[index + 1] === "\n") index++;
        finishRow();
      } else {
        fail("CSV_MALFORMED_QUOTING", { row: rows.length + 1 });
      }
      continue;
    }

    if (character === '"') {
      if (fieldStarted) fail("CSV_MALFORMED_QUOTING", { row: rows.length + 1 });
      quoted = true;
      fieldStarted = true;
    } else if (character === ";") {
      finishField();
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index++;
      finishRow();
    } else {
      field += character;
      fieldStarted = true;
    }
  }

  if (quoted) fail("CSV_MALFORMED_QUOTING", { row: rows.length + 1 });
  if (fieldStarted || quoteClosed || field || row.length) finishRow();
  return rows;
}

function groupRole(value) {
  const groups = new Set(String(value).split(/[,;|\r\n]+/).map((entry) => entry.trim()).filter(Boolean));
  const hasGroup = (name) => [...groups].some((group) => group === name || group.startsWith(`${name} (`));
  if (hasGroup("A-Mitglieder")) return "player A";
  if (hasGroup("B-Mitglieder")) return "player B";
  return "player";
}

function genderValue(value) {
  const gender = String(value).trim().toLocaleLowerCase("de");
  if (gender === "männlich") return "1";
  if (gender === "weiblich") return "2";
  return "";
}

function phoneValue(value) {
  const phone = String(value).trim();
  if (!phone) return { value: "", issue: null };
  const austrian = phone.match(/^\+43 +([1-9]\d*) +(\d(?:[\d ]*\d)?)$/);
  if (austrian) {
    return { value: `0043 ${austrian[1]} ${austrian[2].replace(/ +/g, " ")}`, issue: null };
  }
  if (/^0043 [1-9]\d* \d(?:[\d ]*\d)?$/.test(phone)) return { value: phone, issue: null };
  return {
    value: phone,
    issue: { field: "phone", code: "PHONE_COMPARISON_UNCLEAR" },
  };
}

function controlledValues(values) {
  return Object.fromEntries(VALUE_FIELDS.map((field) => [field, String(values?.[field] ?? "")]));
}

function controlledRecord(record) {
  return {
    externalId: String(record?.externalId ?? "").trim(),
    values: controlledValues(record?.values),
    issues: Array.isArray(record?.issues)
      ? record.issues.flatMap((issue) => {
        if (!issue || typeof issue.code !== "string") return [];
        return [{
          code: issue.code,
          ...(typeof issue.field === "string" ? { field: issue.field } : {}),
        }];
      })
      : [],
  };
}

function controlledPerson(person) {
  return {
    id: String(person?.id ?? ""),
    externalId: String(person?.externalId ?? "").trim(),
    values: controlledValues(person?.values),
    fingerprint: String(person?.fingerprint ?? ""),
  };
}

function normalizedIdentity(values) {
  const normalize = (value) => String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("de");
  const parts = [normalize(values.firstName), normalize(values.lastName), normalize(values.birthDate)];
  return parts.every(Boolean) ? parts.join("\u0000") : "";
}

function normalizedEmail(value) {
  return String(value ?? "").normalize("NFC").trim().toLocaleLowerCase("en-US");
}

function comparisonValue(field, value) {
  if (field === "email" || field === "login") return normalizedEmail(value);
  if (field === "phone") {
    const phone = String(value ?? "").trim();
    if (/^(?:\+|00)\d[\d ]*$/.test(phone)) return phone.replace(/^\+/, "00").replace(/\D/g, "");
  }
  return String(value ?? "");
}

function differencesFor(record, person) {
  const differences = [];
  for (const field of VALUE_FIELDS) {
    if (field === "login") continue;
    const imported = record.values[field];
    if (!imported) continue;
    if (field === "role" && ["admin", "operator"].includes(person.values.role.trim().toLowerCase())) continue;
    const before = person.values[field];
    if (comparisonValue(field, before) !== comparisonValue(field, imported)) {
      differences.push({ field, before, import: imported });
    }
  }
  return differences;
}

function comparisonEntry(category, record, person, options = {}) {
  return {
    category,
    import: record || null,
    person: person || null,
    differences: options.differences || [],
    match: options.match || null,
    requiresConfirmation: options.requiresConfirmation === true,
    issues: options.issues || [],
  };
}

export function parseClubDeskCsv(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer)) fail("CSV_INPUT_INVALID");
  if (arrayBuffer.byteLength > MAX_FILE_BYTES) fail("CSV_FILE_TOO_LARGE", { maxBytes: MAX_FILE_BYTES });

  const text = new TextDecoder("windows-1252").decode(arrayBuffer);
  const rows = parseCsv(text);
  if (!rows.length) fail("CSV_HEADER_MISSING");
  if (rows.length - 1 > MAX_DATA_ROWS) fail("CSV_TOO_MANY_ROWS", { maxRows: MAX_DATA_ROWS });

  const header = rows[0];
  const indexes = new Map();
  for (const name of REQUIRED_HEADERS) {
    const matches = header.flatMap((entry, index) => entry === name ? [index] : []);
    if (!matches.length) fail("CSV_REQUIRED_HEADER_MISSING", { header: name });
    if (matches.length > 1) fail("CSV_REQUIRED_HEADER_DUPLICATE", { header: name });
    indexes.set(name, matches[0]);
  }

  const externalIds = new Set();
  return rows.slice(1).map((row, offset) => {
    const rowNumber = offset + 2;
    if (row.length !== header.length) fail("CSV_COLUMN_COUNT_INVALID", { row: rowNumber });
    const externalId = String(row[indexes.get("[Id]")] ?? "").trim();
    if (!/^[1-9]\d*$/.test(externalId)) fail("CSV_ID_INVALID", { row: rowNumber, field: "externalId" });
    if (externalIds.has(externalId)) fail("CSV_ID_DUPLICATE", { row: rowNumber, field: "externalId" });
    externalIds.add(externalId);

    const values = Object.fromEntries(VALUE_FIELDS.map((field) => [field, ""]));
    for (const [headerName, field] of Object.entries(HEADER_FIELDS)) {
      values[field] = String(row[indexes.get(headerName)] ?? "").trim();
    }
    values.gender = genderValue(row[indexes.get("Geschlecht")] ?? "");
    values.role = groupRole(row[indexes.get("[Gruppen]")] ?? "");
    values.active = "1";
    const phone = phoneValue(values.phone);
    values.phone = phone.value;

    const issues = phone.issue ? [phone.issue] : [];
    for (const field of VALUE_FIELDS) {
      if (!values[field] || issues.some((issue) => issue.field === field)) continue;
      try {
        values[field] = canonicalizePersonValue(field, values[field]);
      } catch {
        issues.push({ field, code: "IMPORT_VALUE_INVALID" });
      }
    }
    return {
      externalId,
      values,
      issues,
    };
  });
}

export function compareClubDeskMembers(importRecords, serverPeople) {
  if (!Array.isArray(importRecords) || !Array.isArray(serverPeople)) fail("COMPARISON_INPUT_INVALID");
  const records = importRecords.map(controlledRecord);
  const people = serverPeople.map(controlledPerson);
  const result = { identical: [], changed: [], new: [], missing: [], unclear: [], conflict: [] };
  const handledPeople = new Set();

  const externalIndex = new Map();
  const identityIndex = new Map();
  const loginIndex = new Map();
  for (const person of people) {
    if (person.externalId) {
      if (!externalIndex.has(person.externalId)) externalIndex.set(person.externalId, []);
      externalIndex.get(person.externalId).push(person);
    } else {
      const identity = normalizedIdentity(person.values);
      if (identity) {
        if (!identityIndex.has(identity)) identityIndex.set(identity, []);
        identityIndex.get(identity).push(person);
      }
    }
    const login = normalizedEmail(person.values.login);
    if (login) {
      if (!loginIndex.has(login)) loginIndex.set(login, []);
      loginIndex.get(login).push(person);
    }
  }

  const importEmailCounts = new Map();
  const importExternalCounts = new Map();
  const importIdentityCounts = new Map();
  for (const record of records) {
    if (record.externalId) importExternalCounts.set(record.externalId, (importExternalCounts.get(record.externalId) || 0) + 1);
    const email = normalizedEmail(record.values.email);
    if (email) importEmailCounts.set(email, (importEmailCounts.get(email) || 0) + 1);
    const identity = normalizedIdentity(record.values);
    if (identity) importIdentityCounts.set(identity, (importIdentityCounts.get(identity) || 0) + 1);
  }

  for (const record of records) {
    const externalMatches = externalIndex.get(record.externalId) || [];
    const identityMatches = externalMatches.length
      ? []
      : (identityIndex.get(normalizedIdentity(record.values)) || []);
    const person = externalMatches.length === 1
      ? externalMatches[0]
      : (identityMatches.length === 1 ? identityMatches[0] : null);
    const match = externalMatches.length === 1 ? "externalId" : (person ? "proposed" : null);
    const issues = [...record.issues];

    if (record.externalId && importExternalCounts.get(record.externalId) > 1) {
      issues.push({ field: "externalId", code: "EXTERNAL_ID_DUPLICATE" });
    }
    if (externalMatches.length > 1) issues.push({ field: "externalId", code: "EXTERNAL_ID_CONFLICT" });
    const identity = normalizedIdentity(record.values);
    if (!externalMatches.length && identityMatches.length > 1) issues.push({ code: "IDENTITY_CONFLICT" });
    if (!externalMatches.length && identity && importIdentityCounts.get(identity) > 1) issues.push({ code: "IDENTITY_DUPLICATE" });
    if (issues.length) {
      for (const candidate of [...externalMatches, ...identityMatches]) handledPeople.add(candidate.id);
      result.conflict.push(comparisonEntry("conflict", record, person, { match, issues }));
      continue;
    }
    if (match === "proposed") {
      handledPeople.add(person.id);
      result.unclear.push(comparisonEntry("unclear", record, person, {
        match,
        requiresConfirmation: true,
        differences: differencesFor(record, person),
      }));
      continue;
    }
    if (!person) {
      const email = normalizedEmail(record.values.email);
      if (email && importEmailCounts.get(email) === 1 && !(loginIndex.get(email) || []).length) {
        record.values.login = record.values.email;
      }
      result.new.push(comparisonEntry("new", record, null));
      continue;
    }

    handledPeople.add(person.id);
    const differences = differencesFor(record, person);
    const category = differences.length ? "changed" : "identical";
    result[category].push(comparisonEntry(category, record, person, { match, differences }));
  }

  for (const duplicatePeople of externalIndex.values()) {
    if (duplicatePeople.length < 2) continue;
    for (const person of duplicatePeople) {
      if (handledPeople.has(person.id)) continue;
      handledPeople.add(person.id);
      result.conflict.push(comparisonEntry("conflict", null, person, {
        issues: [{ field: "externalId", code: "EXTERNAL_ID_CONFLICT" }],
      }));
    }
  }
  for (const person of people) {
    if (handledPeople.has(person.id)) continue;
    const role = person.values.role.trim().toLowerCase();
    const inactive = person.values.active.trim() !== "1";
    if (inactive || role === "admin" || role === "operator") {
      result.identical.push(comparisonEntry("identical", null, person));
    } else {
      result.missing.push(comparisonEntry("missing", null, person, {
        differences: [{ field: "active", before: person.values.active, import: "" }],
        requiresConfirmation: true,
      }));
    }
  }

  return result;
}

export { MAX_DATA_ROWS, MAX_FILE_BYTES, REQUIRED_HEADERS, VALUE_FIELDS };
