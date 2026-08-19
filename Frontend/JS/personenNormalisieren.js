import { getUser, ready, subscribeAuth } from "./authClient.js";
import {
  createEndpoint,
  getOperationId,
  releaseOperationId,
  subscribeInvalidations,
} from "./dataClient.js";
import { diagnostic } from "./diagnostics.js";

const readNormalization = createEndpoint("adminPeopleNormalization");
const writeNormalization = createEndpoint("normalizePerson");
const FIELD_LABELS = Object.freeze({
  firstName: "Vorname",
  lastName: "Nachname",
  birthDate: "Geburtsdatum",
  gender: "Geschlecht",
  phone: "Telefon Mobil",
  email: "E-Mail / Login",
  country: "Land",
  postalCode: "PLZ",
  city: "Ort",
  address: "Adresse",
  active: "Aktiv",
  role: "Rolle",
});
const FIELD_ORDER = Object.keys(FIELD_LABELS);

let snapshot = null;
let authorized = false;
let busy = false;
let loadGeneration = 0;
let drafts = new Map();
let lastFocused = null;

function element(id) {
  return document.getElementById(id);
}

function setStatus(message = "", state = "") {
  const status = element("normalization-status");
  status.textContent = message;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

function errorMessage(error) {
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
  snapshot = null;
  drafts = new Map();
  busy = false;
  element("normalization-preview-modal").hidden = true;
  element("normalization-app").hidden = true;
  element("normalization-access").hidden = false;
  element("normalization-access-message").textContent = accessMessage(user, authState);
}

function setBusy(nextBusy) {
  busy = nextBusy;
  document.querySelectorAll("#normalization-app button, #normalization-app input, #normalization-app select, #normalization-preview-modal button").forEach((control) => {
    control.disabled = nextBusy || (control.id === "normalization-preview" && countChanges() === 0);
  });
}

function assertSnapshot(data) {
  if (data?.success !== true || !Array.isArray(data.people) || !Number.isInteger(data.issueCount) || !Number.isInteger(data.affectedCount)) {
    const error = new Error("Der Server hat unvollständige Normalisierungsdaten geliefert.");
    error.code = "INVALID_RESPONSE";
    throw error;
  }
  for (const person of data.people) {
    if (!person?.id || !person.values || !Array.isArray(person.issues) || !/^[0-9a-f]{64}$/i.test(person.fingerprint || "")) {
      const error = new Error("Der Server hat einen unvollständigen Personendatensatz geliefert.");
      error.code = "INVALID_RESPONSE";
      throw error;
    }
  }
  return data;
}

function personName(person) {
  const firstName = String(person.values.firstName || "").trim();
  const lastName = String(person.values.lastName || "").trim();
  return [firstName, lastName].filter(Boolean).join(" ") || `Person ${person.id}`;
}

function draftFor(person) {
  if (!drafts.has(person.id)) drafts.set(person.id, { ...person.values });
  return drafts.get(person.id);
}

function changesFor(person) {
  const draft = drafts.get(person.id);
  if (!draft) return {};
  return Object.fromEntries(FIELD_ORDER.flatMap((field) => (
    String(draft[field] ?? "") === String(person.values[field] ?? "") ? [] : [[field, String(draft[field] ?? "")]]
  )));
}

function changedPeople() {
  return (snapshot?.people || []).flatMap((person) => {
    const changes = changesFor(person);
    return Object.keys(changes).length ? [{ person, changes }] : [];
  });
}

function countChanges() {
  return changedPeople().reduce((sum, entry) => sum + Object.keys(entry.changes).length, 0);
}

function updateChangeSummary() {
  const count = countChanges();
  element("normalization-change-count").textContent = String(count);
  element("normalization-preview").disabled = busy || count === 0;
}

function makeOption(value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  return option;
}

function makeFieldControl(person, field) {
  const wrapper = document.createElement("label");
  wrapper.className = "normalization-field";
  const label = document.createElement("span");
  label.textContent = FIELD_LABELS[field];
  wrapper.append(label);

  let control;
  if (field === "active") {
    control = document.createElement("select");
    control.append(makeOption("1", "Aktiv (1)"), makeOption("", "Inaktiv (leer)"));
  } else if (field === "gender") {
    control = document.createElement("select");
    control.append(makeOption("", "Nicht gesetzt"), makeOption("1", "Männlich (1)"), makeOption("2", "Weiblich (2)"), makeOption("3", "Divers (3)"));
  } else if (field === "role") {
    control = document.createElement("select");
    control.append(
      makeOption("player", "Player"),
      makeOption("player A", "Player A"),
      makeOption("player B", "Player B"),
      makeOption("operator", "Operator"),
      makeOption("admin", "Admin"),
    );
  } else {
    control = document.createElement("input");
    control.type = field === "email" ? "text" : "text";
    control.autocomplete = "off";
    if (field === "birthDate") control.placeholder = "TT.MM.JJJJ";
    if (field === "phone") control.placeholder = "0043 664 1234567";
  }
  control.dataset.personId = person.id;
  control.dataset.field = field;
  control.value = String(draftFor(person)[field] ?? "");
  control.addEventListener("input", () => {
    draftFor(person)[field] = control.value;
    const changed = control.value !== String(person.values[field] ?? "");
    wrapper.dataset.modified = String(changed);
    control.closest(".normalization-person").dataset.changed = String(Object.keys(changesFor(person)).length > 0);
    updateChangeSummary();
  });
  wrapper.dataset.modified = String(control.value !== String(person.values[field] ?? ""));
  wrapper.append(control);

  const original = document.createElement("small");
  original.className = "normalization-original";
  const originalValue = String(person.values[field] ?? "");
  original.textContent = `Original: ${originalValue || "(leer)"}`;
  wrapper.append(original);
  return wrapper;
}

function applyProposal(person, issue) {
  if (!Object.hasOwn(issue, "proposedValue")) return;
  draftFor(person)[issue.field] = String(issue.proposedValue ?? "");
  const control = document.querySelector(`[data-person-id="${CSS.escape(person.id)}"][data-field="${CSS.escape(issue.field)}"]`);
  if (control) {
    control.value = draftFor(person)[issue.field];
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.focus();
  }
}

function renderProblems(person) {
  const container = document.createElement("div");
  container.className = "normalization-problems";
  for (const issue of person.issues) {
    const row = document.createElement("div");
    row.className = "normalization-problem";
    const text = document.createElement("div");
    const message = document.createElement("p");
    message.textContent = issue.message;
    const field = document.createElement("small");
    field.textContent = `${FIELD_LABELS[issue.field] || issue.field} · ${issue.code}`;
    text.append(message, field);
    row.append(text);
    if (Object.hasOwn(issue, "proposedValue")) {
      const button = document.createElement("button");
      button.className = "normalization-proposal-button";
      button.type = "button";
      button.textContent = "Vorschlag übernehmen";
      button.addEventListener("click", () => applyProposal(person, issue));
      row.append(button);
    }
    container.append(row);
  }
  return container;
}

function renderPerson(person) {
  const details = document.createElement("details");
  details.className = "normalization-person";
  details.dataset.changed = String(Object.keys(changesFor(person)).length > 0);
  const summary = document.createElement("summary");
  const identity = document.createElement("div");
  identity.className = "normalization-person-name";
  const name = document.createElement("strong");
  name.textContent = personName(person);
  const id = document.createElement("span");
  id.textContent = `ID ${person.id}`;
  identity.append(name, id);
  const badges = document.createElement("div");
  badges.className = "normalization-issues";
  if (!person.issues.length) {
    const badge = document.createElement("span");
    badge.className = "normalization-badge";
    badge.dataset.clean = "true";
    badge.textContent = "Keine Probleme";
    badges.append(badge);
  } else {
    for (const issue of person.issues.slice(0, 4)) {
      const badge = document.createElement("span");
      badge.className = "normalization-badge";
      badge.textContent = FIELD_LABELS[issue.field] || issue.field;
      badges.append(badge);
    }
    if (person.issues.length > 4) {
      const more = document.createElement("span");
      more.className = "normalization-badge";
      more.textContent = `+${person.issues.length - 4}`;
      badges.append(more);
    }
  }
  summary.append(identity, badges);
  const body = document.createElement("div");
  body.className = "normalization-person-body";
  if (person.issues.length) body.append(renderProblems(person));
  const fields = document.createElement("div");
  fields.className = "normalization-fields";
  for (const field of FIELD_ORDER) fields.append(makeFieldControl(person, field));
  body.append(fields);
  details.append(summary, body);
  return details;
}

function filteredPeople() {
  const search = element("normalization-search").value.trim().toLocaleLowerCase("de");
  const activeFilter = element("normalization-active-filter").value;
  const issueFilter = element("normalization-issue-filter").value;
  return (snapshot?.people || []).filter((person) => {
    const active = String(person.values.active || "").trim() === "1";
    if (activeFilter === "active" && !active) return false;
    if (activeFilter === "inactive" && active) return false;
    const changed = Object.keys(changesFor(person)).length > 0;
    if (issueFilter === "issues" && !person.issues.length) return false;
    if (issueFilter === "clean" && person.issues.length) return false;
    if (issueFilter === "changed" && !changed) return false;
    if (search && !`${person.id} ${personName(person)}`.toLocaleLowerCase("de").includes(search)) return false;
    return true;
  });
}

function render() {
  if (!snapshot) return;
  element("normalization-person-count").textContent = String(snapshot.people.length);
  element("normalization-affected-count").textContent = String(snapshot.affectedCount);
  element("normalization-issue-count").textContent = String(snapshot.issueCount);
  const list = element("normalization-list");
  const people = filteredPeople();
  list.replaceChildren(...people.map(renderPerson));
  element("normalization-empty").hidden = people.length > 0;
  updateChangeSummary();
}

async function loadData({ preserveDrafts = false } = {}) {
  if (!authorized || busy) return;
  const generation = ++loadGeneration;
  setStatus("Personendaten werden geprüft...", "loading");
  try {
    const response = await readNormalization();
    if (generation !== loadGeneration || !authorized) return;
    snapshot = assertSnapshot(response.data);
    if (!preserveDrafts) drafts = new Map();
    render();
    setStatus(`${snapshot.affectedCount} Personen mit ${snapshot.issueCount} Hinweisen geladen.`, "success");
  } catch (error) {
    if (generation !== loadGeneration || !authorized) return;
    setStatus(errorMessage(error), "error");
    diagnostic.error("people_normalization_load_failed", error);
  }
}

function previewValue(value) {
  return String(value ?? "") || "(leer)";
}

function openPreview() {
  const entries = changedPeople();
  if (!entries.length || busy) return;
  lastFocused = document.activeElement;
  const list = element("normalization-preview-list");
  list.replaceChildren(...entries.map(({ person, changes }) => {
    const section = document.createElement("section");
    section.className = "normalization-preview-person";
    const heading = document.createElement("h3");
    heading.textContent = `${personName(person)} · ID ${person.id}`;
    section.append(heading);
    for (const [field, value] of Object.entries(changes)) {
      const row = document.createElement("div");
      row.className = "normalization-preview-row";
      const label = document.createElement("strong");
      label.textContent = FIELD_LABELS[field] || field;
      const before = document.createElement("span");
      before.className = "normalization-preview-value";
      before.textContent = previewValue(person.values[field]);
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
  }));
  element("normalization-preview-modal").hidden = false;
  element("normalization-preview-close").focus();
}

function closePreview() {
  const modal = element("normalization-preview-modal");
  if (!modal || modal.hidden || busy) return;
  modal.hidden = true;
  if (lastFocused instanceof HTMLElement) lastFocused.focus();
  lastFocused = null;
}

async function submitChanges() {
  const entries = changedPeople();
  if (!entries.length || busy) return;
  setBusy(true);
  setStatus(`0 von ${entries.length} Personen geschrieben...`, "loading");
  let completed = 0;
  try {
    for (const { person, changes } of entries) {
      const operationKey = `normalizePerson:${person.id}`;
      let error = null;
      try {
        await writeNormalization({
          operationId: getOperationId(operationKey),
          personId: person.id,
          expectedFingerprint: person.fingerprint,
          changes,
        });
        drafts.delete(person.id);
        completed += 1;
        setStatus(`${completed} von ${entries.length} Personen geschrieben...`, "loading");
      } catch (writeError) {
        error = writeError;
        throw writeError;
      } finally {
        releaseOperationId(operationKey, error);
      }
    }
    drafts = new Map();
    element("normalization-preview-modal").hidden = true;
    setBusy(false);
    await loadData();
    setStatus(`${completed} Personen wurden erfolgreich aktualisiert.`, "success");
  } catch (error) {
    element("normalization-preview-modal").hidden = true;
    const message = `${completed} Personen wurden geschrieben. Danach: ${errorMessage(error)} Die Daten wurden neu geladen.`;
    diagnostic.error("people_normalization_write_failed", error, { count: completed });
    setBusy(false);
    await loadData({ preserveDrafts: true });
    setStatus(message, "error");
  }
}

function bindEvents() {
  element("normalization-reload").addEventListener("click", () => {
    drafts = new Map();
    loadData();
  });
  element("normalization-search").addEventListener("input", render);
  element("normalization-active-filter").addEventListener("change", render);
  element("normalization-issue-filter").addEventListener("change", render);
  element("normalization-preview").addEventListener("click", openPreview);
  element("normalization-preview-close").addEventListener("click", closePreview);
  element("normalization-preview-cancel").addEventListener("click", closePreview);
  element("normalization-submit").addEventListener("click", submitChanges);
  element("normalization-preview-modal").addEventListener("click", (event) => {
    if (event.target === element("normalization-preview-modal")) closePreview();
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
  element("normalization-access").hidden = true;
  element("normalization-app").hidden = false;
  if (firstAuthorization) loadData();
});

subscribeInvalidations(["players"], () => {
  if (authorized && !busy && countChanges() === 0) return loadData();
});

ready.catch((error) => {
  diagnostic.error("people_normalization_auth_failed", error);
});
