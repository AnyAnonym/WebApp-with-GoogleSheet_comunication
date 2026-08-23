import { ready, subscribeAuth } from "./authClient.js";
import {
  createEndpoint,
  getOperationId,
  releaseOperationId,
  subscribeInvalidations,
} from "./dataClient.js";
import { diagnostic } from "./diagnostics.js";
import { compareClubDeskMembers, MAX_FILE_BYTES, parseClubDeskCsv, VALUE_FIELDS } from "./memberImport.js";
import { canonicalizePersonChanges } from "./personValues.js";

const readReconciliation = createEndpoint("adminMemberReconciliation");
const writeReconciliation = createEndpoint("reconcilePerson");
const FIELD_LABELS = Object.freeze({
  externalId: "CD-ID",
  firstName: "Vorname",
  lastName: "Nachname",
  birthDate: "Geburtsdatum",
  gender: "Geschlecht",
  phone: "Telefon Mobil",
  email: "Kontakt E-Mail",
  login: "Login",
  country: "Land",
  postalCode: "PLZ",
  city: "Ort",
  address: "Adresse",
  active: "Aktiv",
  role: "Rolle",
});
const CATEGORY_LABELS = Object.freeze({
  changed: "Geändert",
  new: "Neu",
  missing: "Weggefallen",
  unclear: "Zuordnung bestätigen",
  conflict: "Konflikt",
  identical: "Identisch",
});
const ISSUE_LABELS = Object.freeze({
  PHONE_COMPARISON_UNCLEAR: "Telefonnummer kann nicht sicher in das Zielformat überführt werden.",
  EXTERNAL_ID_DUPLICATE: "CD-ID kommt im Import mehrfach vor.",
  EXTERNAL_ID_CONFLICT: "CD-ID ist im Bestand nicht eindeutig.",
  IMPORT_VALUE_INVALID: "Importwert entspricht nicht dem festgelegten ePiber-Zielformat.",
  IDENTITY_CONFLICT: "Name und Geburtsdatum passen zu mehreren bestehenden Personen.",
  IDENTITY_DUPLICATE: "Name und Geburtsdatum kommen im Import mehrfach vor.",
});
const CSV_ERROR_LABELS = Object.freeze({
  CSV_INPUT_INVALID: "Die Datei konnte nicht gelesen werden.",
  CSV_FILE_TOO_LARGE: "Die Datei ist größer als 5 MiB.",
  CSV_TOO_MANY_ROWS: "Die Datei enthält mehr als 2000 Datensätze.",
  CSV_HEADER_MISSING: "Die CSV besitzt keine Kopfzeile.",
  CSV_REQUIRED_HEADER_MISSING: "Eine benötigte ClubDesk-Spalte fehlt.",
  CSV_REQUIRED_HEADER_DUPLICATE: "Eine benötigte ClubDesk-Spalte ist doppelt vorhanden.",
  CSV_COLUMN_COUNT_INVALID: "Eine CSV-Zeile besitzt nicht dieselbe Spaltenzahl wie die Kopfzeile.",
  CSV_ID_INVALID: "Eine ClubDesk-ID fehlt oder ist nicht numerisch.",
  CSV_ID_DUPLICATE: "Eine ClubDesk-ID kommt mehrfach vor.",
  CSV_MALFORMED_QUOTING: "Die CSV enthält eine fehlerhafte Anführungszeichen-Struktur.",
});

let snapshot = null;
let importRecords = null;
let comparison = null;
let selections = new Map();
let authorized = false;
let busy = false;
let loadGeneration = 0;
let fileGeneration = 0;
let lastFocused = null;

function element(id) {
  return document.getElementById(id);
}

function setStatus(message = "", state = "") {
  const status = element("reconciliation-status");
  status.textContent = message;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

function errorMessage(error) {
  if (CSV_ERROR_LABELS[error?.code]) {
    const detail = error.header ? ` (${error.header})` : error.row ? ` (Zeile ${error.row})` : "";
    return `${CSV_ERROR_LABELS[error.code]}${detail}`;
  }
  const message = typeof error?.message === "string" && error.message ? error.message : "Der Vorgang ist fehlgeschlagen.";
  return error?.supportId && !message.includes(error.supportId) ? `${message} (Referenz: ${error.supportId})` : message;
}

function accessMessage(user, authState) {
  if (authState.status === "loading") return "Sitzung wird geprüft...";
  if (authState.status === "unavailable") return "Die Anmeldung ist derzeit nicht erreichbar. Bitte später erneut versuchen.";
  if (!user) return "Bitte anmelden. Diese Seite ist ausschließlich für Administratoren verfügbar.";
  return "Ihr Konto besitzt keine Administratorrechte für diese Seite.";
}

function showAccess(user, authState) {
  authorized = false;
  loadGeneration += 1;
  fileGeneration += 1;
  snapshot = null;
  importRecords = null;
  comparison = null;
  selections = new Map();
  busy = false;
  element("reconciliation-preview-modal").hidden = true;
  element("reconciliation-preview-list").replaceChildren();
  element("reconciliation-list").replaceChildren();
  element("reconciliation-results").hidden = true;
  element("reconciliation-file").value = "";
  element("reconciliation-file-meta").textContent = "Noch keine Datei ausgewählt.";
  element("reconciliation-app").hidden = true;
  element("reconciliation-access").hidden = false;
  element("reconciliation-access-message").textContent = accessMessage(user, authState);
}

function setBusy(nextBusy) {
  busy = nextBusy;
  document.querySelectorAll("#reconciliation-app button, #reconciliation-app input, #reconciliation-app select, #reconciliation-preview-modal button").forEach((control) => {
    control.disabled = nextBusy
      || control.dataset.locked === "true"
      || (control.id === "reconciliation-preview" && actionRequests().length === 0);
  });
}

function assertSnapshot(data) {
  if (data?.success !== true || !Array.isArray(data.people)) throw new Error("Der Server hat unvollständige Abgleichsdaten geliefert.");
  for (const person of data.people) {
    if (!person?.id || typeof person.externalId !== "string" || !person.values || !/^[0-9a-f]{64}$/i.test(person.fingerprint || "")) {
      throw new Error("Der Server hat einen unvollständigen Personendatensatz geliefert.");
    }
  }
  return data;
}

function entryKey(entry) {
  return entry.import ? `import:${entry.import.externalId}` : `person:${entry.person.id}`;
}

function entrySignature(entry) {
  return [entry.category, entry.match || "", entry.person?.id || "", entry.person?.fingerprint || "", entry.import?.externalId || "", entry.import?.values.login || ""].join("|");
}

function selectionSignature(entry) {
  return entrySignature(entry);
}

function personName(values, fallback = "Unbekannte Person") {
  return [values?.firstName, values?.lastName].map((value) => String(value || "").trim()).filter(Boolean).join(" ") || fallback;
}

function entryName(entry) {
  return personName(entry.import?.values || entry.person?.values, entry.person ? `Person ${entry.person.id}` : "Neues Mitglied");
}

function allEntries() {
  if (!comparison) return [];
  return Object.keys(CATEGORY_LABELS).flatMap((category) => comparison[category].map((entry) => entry));
}

function recompute({ resetSelections = true } = {}) {
  if (!snapshot || !importRecords) return;
  comparison = compareClubDeskMembers(importRecords, snapshot.people);
  if (resetSelections) selections = new Map();
  else {
    const currentEntries = new Map(allEntries().map((entry) => [entryKey(entry), entry]));
    for (const [key, selection] of selections) {
      const entry = currentEntries.get(key);
      if (!entry || selection.signature !== selectionSignature(entry)) selections.delete(key);
    }
  }
  element("reconciliation-results").hidden = false;
  render();
}

function selectedFields(entry) {
  return selections.get(entryKey(entry))?.fields || new Set();
}

function defaultCreateFields(entry) {
  return new Set(VALUE_FIELDS.filter((field) => entry.import.values[field] !== "" || ["lastName", "role", "active"].includes(field)));
}

function setEntryEnabled(entry, enabled) {
  const key = entryKey(entry);
  if (!enabled) selections.delete(key);
  else if (entry.category === "new") selections.set(key, { enabled: true, fields: defaultCreateFields(entry), signature: selectionSignature(entry) });
  else if (entry.category === "unclear") selections.set(key, { enabled: true, fields: new Set(), signature: selectionSignature(entry) });
  else if (entry.category === "missing") selections.set(key, { enabled: true, fields: new Set(["active"]), signature: selectionSignature(entry) });
  render();
}

function setFieldSelected(entry, field, selected) {
  const key = entryKey(entry);
  const current = selections.get(key) || { enabled: true, fields: new Set(), signature: selectionSignature(entry) };
  if (selected) current.fields.add(field);
  else current.fields.delete(field);
  if (entry.category === "changed" && current.fields.size === 0) selections.delete(key);
  else selections.set(key, current);
  updateActionSummary();
}

function canonicalFields(entry, fields) {
  const raw = Object.fromEntries([...fields].map((field) => [field, entry.import.values[field]]));
  return canonicalizePersonChanges(raw, { allowEmpty: entry.category === "unclear" });
}

function actionRequests() {
  if (!comparison) return [];
  const requests = [];
  for (const entry of allEntries()) {
    const selection = selections.get(entryKey(entry));
    if (!selection?.enabled) continue;
    if (selection.signature !== selectionSignature(entry)) continue;
    if (entry.category === "missing") {
      requests.push({ entry, request: { action: "deactivate", personId: entry.person.id, expectedFingerprint: entry.person.fingerprint } });
      continue;
    }
    if (entry.category === "new") {
      const values = canonicalFields(entry, selection.fields);
      requests.push({ entry, request: { action: "create", externalId: entry.import.externalId, values } });
      continue;
    }
    if (["changed", "unclear"].includes(entry.category)) {
      const changes = canonicalFields(entry, selection.fields);
      if (entry.category === "changed" && !Object.keys(changes).length) continue;
      requests.push({
        entry,
        request: {
          action: "update",
          personId: entry.person.id,
          expectedFingerprint: entry.person.fingerprint,
          externalId: entry.import.externalId,
          changes,
        },
      });
    }
  }
  return requests;
}

function updateActionSummary() {
  let requests = [];
  try {
    requests = actionRequests();
    setStatus(importRecords ? `${importRecords.length} Importdatensätze wurden lokal verglichen.` : "", importRecords ? "success" : "");
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }
  element("reconciliation-action-count").textContent = String(requests.length);
  element("reconciliation-preview").disabled = busy || requests.length === 0;
}

function makeCheckbox(checked, onChange, label) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => onChange(input.checked));
  return input;
}

function renderDifferences(entry, container) {
  const fields = document.createElement("div");
  fields.className = "reconciliation-fields";
  const selected = selectedFields(entry);
  for (const difference of entry.differences) {
    const row = document.createElement("label");
    row.className = "reconciliation-field";
    const checkbox = makeCheckbox(selected.has(difference.field), (checked) => setFieldSelected(entry, difference.field, checked), `${FIELD_LABELS[difference.field]} übernehmen`);
    if (entry.category === "new" && ["lastName", "role", "active"].includes(difference.field)) checkbox.dataset.locked = "true";
    if (entry.category === "unclear" && !selections.has(entryKey(entry))) checkbox.dataset.locked = "true";
    checkbox.disabled = checkbox.dataset.locked === "true";
    const label = document.createElement("strong");
    label.textContent = FIELD_LABELS[difference.field] || difference.field;
    const before = document.createElement("span");
    before.className = "reconciliation-field-value";
    before.textContent = difference.before || "(leer)";
    const arrow = document.createElement("span");
    arrow.className = "reconciliation-field-arrow";
    arrow.textContent = "→";
    const imported = document.createElement("span");
    imported.className = "reconciliation-field-value";
    imported.textContent = difference.import || "(leer)";
    row.append(checkbox, label, before, arrow, imported);
    fields.append(row);
  }
  container.append(fields);
}

function removeConflictingField(entry, field) {
  const source = importRecords.find((record) => record.externalId === entry.import.externalId);
  if (!source || !VALUE_FIELDS.includes(field)) return;
  source.values[field] = "";
  source.issues = source.issues.filter((issue) => issue.field !== field);
  recompute();
  setStatus(`${FIELD_LABELS[field]} wird für CD-ID ${source.externalId} in diesem Lauf ausgelassen.`, "success");
}

function renderIssues(entry, container) {
  const issues = document.createElement("div");
  issues.className = "reconciliation-issues";
  for (const issue of entry.issues) {
    const text = document.createElement("p");
    text.textContent = ISSUE_LABELS[issue.code] || issue.code;
    issues.append(text);
    if (entry.import && VALUE_FIELDS.includes(issue.field)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "normalization-secondary-button reconciliation-ignore-button";
      button.textContent = `${FIELD_LABELS[issue.field]} für diesen Lauf auslassen`;
      button.addEventListener("click", () => removeConflictingField(entry, issue.field));
      issues.append(button);
    }
  }
  container.append(issues);
}

function renderCard(entry) {
  const details = document.createElement("details");
  details.className = "reconciliation-card";
  details.dataset.category = entry.category;
  const summary = document.createElement("summary");
  const identity = document.createElement("div");
  identity.className = "reconciliation-identity";
  const name = document.createElement("strong");
  name.textContent = entryName(entry);
  const ids = document.createElement("span");
  ids.textContent = [entry.person ? `ID ${entry.person.id}` : "Neue interne ID", entry.import ? `CD-ID ${entry.import.externalId}` : "Nicht im Export"].join(" · ");
  identity.append(name, ids);
  const category = document.createElement("span");
  category.className = "reconciliation-category-label";
  category.textContent = CATEGORY_LABELS[entry.category];
  summary.append(identity, category);
  const body = document.createElement("div");
  body.className = "reconciliation-card-body";

  if (entry.category === "new") {
    const toggle = document.createElement("label");
    toggle.className = "reconciliation-action-toggle";
    toggle.append(makeCheckbox(selections.has(entryKey(entry)), (checked) => setEntryEnabled(entry, checked), "Neues Mitglied anlegen"), document.createTextNode("Mitglied mit neuer interner ID anlegen"));
    body.append(toggle);
    if (selections.has(entryKey(entry))) {
      const differences = VALUE_FIELDS.filter((field) => entry.import.values[field] !== "" || ["lastName", "role", "active"].includes(field))
        .map((field) => ({ field, before: "", import: entry.import.values[field] }));
      renderDifferences({ ...entry, differences }, body);
    }
  } else if (entry.category === "missing") {
    const toggle = document.createElement("label");
    toggle.className = "reconciliation-action-toggle";
    toggle.append(makeCheckbox(selections.has(entryKey(entry)), (checked) => setEntryEnabled(entry, checked), "Person deaktivieren"), document.createTextNode("Person durch Leeren von Aktiv deaktivieren"));
    body.append(toggle);
  } else if (entry.category === "unclear") {
    const toggle = document.createElement("label");
    toggle.className = "reconciliation-action-toggle";
    toggle.append(makeCheckbox(selections.has(entryKey(entry)), (checked) => setEntryEnabled(entry, checked), "Zuordnung bestätigen"), document.createTextNode("Diese Person eindeutig zuordnen und CD-ID speichern"));
    body.append(toggle);
    renderDifferences(entry, body);
  } else if (entry.category === "changed") {
    renderDifferences(entry, body);
  } else if (entry.category === "conflict") {
    renderIssues(entry, body);
  } else {
    const text = document.createElement("p");
    text.textContent = entry.import ? "Keine fachliche Änderung erkannt." : "Keine Aktion erforderlich.";
    body.append(text);
  }
  details.append(summary, body);
  return details;
}

function filteredEntries() {
  const category = element("reconciliation-category").value;
  const search = element("reconciliation-search").value.trim().toLocaleLowerCase("de");
  return allEntries().filter((entry) => {
    if (category === "actionable" && !["changed", "new", "missing", "unclear", "conflict"].includes(entry.category)) return false;
    if (!["all", "actionable"].includes(category) && entry.category !== category) return false;
    const haystack = `${entryName(entry)} ${entry.person?.id || ""} ${entry.import?.externalId || entry.person?.externalId || ""}`.toLocaleLowerCase("de");
    return !search || haystack.includes(search);
  });
}

function render() {
  if (!comparison) return;
  for (const category of Object.keys(CATEGORY_LABELS)) {
    element(`reconciliation-count-${category}`).textContent = String(comparison[category].length);
  }
  const entries = filteredEntries();
  element("reconciliation-list").replaceChildren(...entries.map(renderCard));
  element("reconciliation-empty").hidden = entries.length > 0;
  updateActionSummary();
}

async function loadData({ preserveSelections = false } = {}) {
  if (!authorized || busy) return;
  const generation = ++loadGeneration;
  setStatus("Aktueller Personenbestand wird geladen...", "loading");
  try {
    const response = await readReconciliation();
    if (generation !== loadGeneration || !authorized) return;
    snapshot = assertSnapshot(response.data);
    if (!preserveSelections) selections = new Map();
    if (importRecords) recompute({ resetSelections: !preserveSelections });
    else setStatus(`${snapshot.people.length} Personen für den Abgleich geladen.`, "success");
  } catch (error) {
    if (generation !== loadGeneration || !authorized) return;
    setStatus(errorMessage(error), "error");
    diagnostic.error("member_reconciliation_load_failed", error);
  }
}

async function loadFile(file) {
  if (!file || busy) return;
  const generation = ++fileGeneration;
  setStatus("CSV wird ausschließlich lokal gelesen und geprüft...", "loading");
  try {
    if (file.size > MAX_FILE_BYTES) {
      const error = new Error("CSV_FILE_TOO_LARGE");
      error.code = "CSV_FILE_TOO_LARGE";
      throw error;
    }
    const content = await file.arrayBuffer();
    if (generation !== fileGeneration || !authorized) return;
    importRecords = parseClubDeskCsv(content);
    element("reconciliation-file-meta").textContent = `${file.name} · ${importRecords.length} Datensätze · ${(file.size / 1024).toFixed(1)} KiB`;
    recompute();
  } catch (error) {
    if (generation !== fileGeneration || !authorized) return;
    importRecords = null;
    comparison = null;
    selections = new Map();
    element("reconciliation-results").hidden = true;
    element("reconciliation-file-meta").textContent = "Datei wurde nicht übernommen.";
    setStatus(errorMessage(error), "error");
    diagnostic.error("member_reconciliation_parse_failed", error);
  }
}

function previewValue(value) {
  return String(value ?? "") || "(leer)";
}

function openPreview() {
  let requests;
  try {
    requests = actionRequests();
  } catch (error) {
    setStatus(errorMessage(error), "error");
    return;
  }
  if (!requests.length || busy) return;
  lastFocused = document.activeElement;
  const sections = requests.map(({ entry, request }) => {
    const section = document.createElement("section");
    section.className = "normalization-preview-person";
    const heading = document.createElement("h3");
    const actionLabel = request.action === "create" ? "Neu anlegen" : request.action === "deactivate" ? "Deaktivieren" : "Verknüpfen / aktualisieren";
    heading.textContent = `${entryName(entry)} · ${actionLabel}`;
    section.append(heading);
    const changes = request.action === "create" ? { externalId: request.externalId, ...request.values }
      : request.action === "deactivate" ? { active: "" }
        : { ...(entry.person.externalId ? {} : { externalId: request.externalId }), ...request.changes };
    for (const [field, value] of Object.entries(changes)) {
      const row = document.createElement("div");
      row.className = "normalization-preview-row";
      const label = document.createElement("strong");
      label.textContent = FIELD_LABELS[field] || field;
      const before = document.createElement("span");
      before.className = "normalization-preview-value";
      before.textContent = previewValue(entry.person?.values?.[field] ?? (field === "externalId" ? entry.person?.externalId : ""));
      const arrow = document.createElement("span");
      arrow.className = "normalization-preview-arrow";
      arrow.textContent = "→";
      const after = document.createElement("span");
      after.className = "normalization-preview-value";
      after.textContent = previewValue(value);
      row.append(label, before, arrow, after);
      section.append(row);
    }
    return section;
  });
  element("reconciliation-preview-list").replaceChildren(...sections);
  element("reconciliation-preview-modal").hidden = false;
  element("reconciliation-preview-close").focus();
}

function closePreview() {
  const modal = element("reconciliation-preview-modal");
  if (modal.hidden || busy) return;
  modal.hidden = true;
  if (lastFocused instanceof HTMLElement) lastFocused.focus();
  lastFocused = null;
}

async function submitActions() {
  let requests;
  try {
    requests = actionRequests();
  } catch (error) {
    closePreview();
    setStatus(errorMessage(error), "error");
    return;
  }
  if (!requests.length || busy) return;
  setBusy(true);
  setStatus(`0 von ${requests.length} Personenaktionen ausgeführt...`, "loading");
  let completed = 0;
  try {
    for (const { entry, request } of requests) {
      const operationKey = `reconcilePerson:${request.action}:${request.personId || request.externalId}`;
      let error = null;
      try {
        await writeReconciliation({ operationId: getOperationId(operationKey), ...request });
        selections.delete(entryKey(entry));
        completed++;
        setStatus(`${completed} von ${requests.length} Personenaktionen ausgeführt...`, "loading");
      } catch (writeError) {
        error = writeError;
        throw writeError;
      } finally {
        releaseOperationId(operationKey, error);
      }
    }
    element("reconciliation-preview-modal").hidden = true;
    setBusy(false);
    await loadData();
    setStatus(`${completed} Personenaktionen wurden erfolgreich ausgeführt.`, "success");
  } catch (error) {
    element("reconciliation-preview-modal").hidden = true;
    const message = `${completed} Personenaktionen wurden ausgeführt. Danach: ${errorMessage(error)} Der aktuelle Bestand wurde neu geladen.`;
    diagnostic.error("member_reconciliation_write_failed", error, { count: completed });
    setBusy(false);
    await loadData({ preserveSelections: true });
    setStatus(message, "error");
  }
}

function bindEvents() {
  element("reconciliation-file").addEventListener("change", (event) => loadFile(event.target.files?.[0]));
  element("reconciliation-reload").addEventListener("click", () => loadData({ preserveSelections: true }));
  element("reconciliation-search").addEventListener("input", render);
  element("reconciliation-category").addEventListener("change", render);
  document.querySelectorAll(".reconciliation-summary button").forEach((button) => button.addEventListener("click", () => {
    element("reconciliation-category").value = button.dataset.category;
    render();
  }));
  element("reconciliation-preview").addEventListener("click", openPreview);
  element("reconciliation-preview-close").addEventListener("click", closePreview);
  element("reconciliation-preview-cancel").addEventListener("click", closePreview);
  element("reconciliation-submit").addEventListener("click", submitActions);
  element("reconciliation-preview-modal").addEventListener("click", (event) => {
    if (event.target === element("reconciliation-preview-modal")) closePreview();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePreview();
  });
}

bindEvents();
subscribeAuth((user, authState) => {
  if (!user || user.role !== "admin" || authState.status !== "authenticated") {
    showAccess(user, authState);
    return;
  }
  const firstAuthorization = !authorized;
  authorized = true;
  element("reconciliation-access").hidden = true;
  element("reconciliation-app").hidden = false;
  if (firstAuthorization) loadData();
});

subscribeInvalidations(["players"], () => {
  if (authorized && !busy && selections.size === 0) return loadData();
});

ready.catch((error) => diagnostic.error("member_reconciliation_auth_failed", error));
