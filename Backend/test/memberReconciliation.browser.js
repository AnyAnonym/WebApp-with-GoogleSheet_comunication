const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const FRONTEND_ROOT = path.resolve(__dirname, "../../Frontend");
const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);

const authStub = `
export const ready = Promise.resolve();
let listener = null;
window.__setReconciliationAuth = (user, state) => listener?.(user, state);
export function subscribeAuth(callback) {
  listener = callback;
  queueMicrotask(() => callback({ id: "1", role: "admin" }, { status: "authenticated" }));
  return () => {};
}
`;

const dataStub = `
const emptyValues = () => ({
  firstName: "", lastName: "", birthDate: "", gender: "", phone: "", email: "", login: "",
  country: "", postalCode: "", city: "", address: "", active: "", role: "player"
});
let snapshot = {
  success: true,
  people: [
    { id: "1", externalId: "101", fingerprint: "${FINGERPRINT_A}", values: { ...emptyValues(), firstName: "Anna", lastName: "Muster", birthDate: "02.01.1990", gender: "2", phone: "0043 664 1234567", email: "anna@example.test", login: "anna-login@example.test", country: "Österreich", postalCode: "4060", city: "Piberbach", address: "Dorf 1", active: "1", role: "player A" } },
    { id: "2", externalId: "", fingerprint: "${FINGERPRINT_A}", values: { ...emptyValues(), firstName: "Berta", lastName: "Beispiel", birthDate: "03.02.1991", gender: "2", phone: "0043 664 2222222", email: "berta@example.test", country: "Österreich", postalCode: "4060", city: "Piberbach", address: "Dorf 2", active: "1", role: "player B" } },
    { id: "3", externalId: "103", fingerprint: "${FINGERPRINT_A}", values: { ...emptyValues(), firstName: "Claus", lastName: "Alt", birthDate: "04.03.1992", active: "1", role: "player" } }
  ]
};
window.__reconciliationWrites = [];
window.__reconciliationAttempts = 0;
window.__reconciliationFailureAfter = null;
window.__changeReconciliationPerson = (id, changes = {}) => {
  const person = snapshot.people.find((entry) => entry.id === id);
  Object.assign(person, changes);
};
window.__changeReconciliationValues = (id, changes = {}) => {
  const person = snapshot.people.find((entry) => entry.id === id);
  Object.assign(person.values, changes);
};
export function createEndpoint(endpoint) {
  return async (params = {}) => {
    if (endpoint === "adminMemberReconciliation") return { data: structuredClone(snapshot) };
    const attempt = window.__reconciliationAttempts++;
    if (window.__reconciliationFailureAfter !== null && attempt >= window.__reconciliationFailureAfter) {
      const error = new Error("Personendaten wurden zwischenzeitlich geändert. (Referenz: conflict-reference)");
      error.code = "PERSON_CONFLICT";
      error.supportId = "conflict-reference";
      throw error;
    }
    window.__reconciliationWrites.push(structuredClone(params));
    if (params.action === "create") {
      snapshot.people.push({ id: String(snapshot.people.length + 1), externalId: params.externalId, fingerprint: "${FINGERPRINT_B}", values: { ...emptyValues(), ...params.values } });
    } else {
      const person = snapshot.people.find((entry) => entry.id === params.personId);
      if (params.action === "deactivate") person.values.active = "";
      else {
        person.externalId = params.externalId;
        Object.assign(person.values, params.changes);
      }
      person.fingerprint = "${FINGERPRINT_B}";
    }
    return { data: { success: true, action: params.action, personId: params.personId || "4", fingerprint: "${FINGERPRINT_B}" } };
  };
}
export function getOperationId() { return crypto.randomUUID(); }
export function releaseOperationId() {}
export function subscribeInvalidations() { return () => {}; }
`;

const diagnosticsStub = `
export const diagnostic = { debug() {}, info() {}, warn() {}, error() {} };
`;

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const stubs = {
      "/JS/authClient.js": authStub,
      "/JS/dataClient.js": dataStub,
      "/JS/diagnostics.js": diagnosticsStub,
      "/JS/navbar.js": "",
      "/JS/modals.js": "",
      "/JS/global.js": "",
      "/JS/footer.js": "",
    };
    if (Object.hasOwn(stubs, pathname)) {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(stubs[pathname]);
      return;
    }
    const relative = pathname.replace(/^\/+/, "");
    const filePath = path.resolve(FRONTEND_ROOT, relative || "mitgliederAbgleichen.html");
    if (!filePath.startsWith(`${FRONTEND_ROOT}${path.sep}`) || !fs.existsSync(filePath)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": contentType(filePath) });
    response.end(fs.readFileSync(filePath));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function csvBuffer() {
  const rows = [
    ["[Id]", "[Gruppen]", "Nachname", "Vorname", "Geburtsdatum", "Geschlecht", "Telefon Mobil", "E-Mail", "Land", "PLZ", "Ort", "Adresse"],
    ["101", "A-Mitglieder", "Muster", "Anna", "02.01.1990", "weiblich", "+43 664 1234567", "ANNA@example.test", "Österreich", "4060", "Neuer Ort", "Dorf 1"],
    ["102", "B-Mitglieder", "Beispiel", "Berta", "03.02.1991", "weiblich", "+43 664 2222222", "berta@example.test", "Österreich", "4060", "Linz", "Dorf 2"],
    ["104", "A-Mitglieder", "Neu", "Dora", "05.04.1993", "weiblich", "+43 664 4444444", "DORA@example.test", "Österreich", "4060", "Piberbach", "Dorf 4"],
  ];
  return Buffer.from(rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(";")).join("\r\n"), "latin1");
}

function familyCsvBuffer() {
  const rows = [
    ["[Id]", "[Gruppen]", "Nachname", "Vorname", "Geburtsdatum", "Geschlecht", "Telefon Mobil", "E-Mail", "Land", "PLZ", "Ort", "Adresse"],
    ["201", "A-Mitglieder", "Familie", "Dora", "05.04.1993", "weiblich", "+43 664 4444444", "family@example.test", "Österreich", "4060", "Piberbach", "Dorf 4"],
    ["202", "B-Mitglieder", "Familie", "Emil", "06.05.1994", "männlich", "+43 664 5555555", "FAMILY@example.test", "Österreich", "4060", "Piberbach", "Dorf 4"],
  ];
  return Buffer.from(rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(";")).join("\r\n"), "latin1");
}

async function selectFourActions(page) {
  await page.locator('.reconciliation-card[data-category="changed"] summary').click();
  await page.getByRole("checkbox", { name: "Ort übernehmen" }).check();
  await page.locator('.reconciliation-card[data-category="new"] summary').click();
  await page.getByRole("checkbox", { name: "Neues Mitglied anlegen" }).click();
  await page.locator('.reconciliation-card[data-category="missing"] summary').click();
  await page.getByRole("checkbox", { name: "Person deaktivieren" }).click();
  const unclear = page.locator('.reconciliation-card[data-category="unclear"]');
  await unclear.locator("summary").click();
  assert.equal(await unclear.getByRole("checkbox", { name: "Ort übernehmen" }).isDisabled(), true);
  await unclear.getByRole("checkbox", { name: "Zuordnung bestätigen" }).click();
}

test("Mitgliederabgleich verarbeitet CSV responsiv und schreibt nur bestätigte exakte Aktionen", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 60000,
}, async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const address = server.address();
      await page.goto(`http://127.0.0.1:${address.port}/mitgliederAbgleichen.html`, { waitUntil: "domcontentloaded" });
      await page.locator("#reconciliation-app").waitFor({ state: "visible" });
      await page.locator("#reconciliation-file").setInputFiles({ name: "members.csv", mimeType: "text/csv", buffer: csvBuffer() });
      await page.locator("#reconciliation-results").waitFor({ state: "visible" });
      assert.equal(await page.locator("#reconciliation-count-changed").textContent(), "1");
      assert.equal(await page.locator("#reconciliation-count-new").textContent(), "1");
      assert.equal(await page.locator("#reconciliation-count-missing").textContent(), "1");
      assert.equal(await page.locator("#reconciliation-count-unclear").textContent(), "1");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

      await selectFourActions(page);
      assert.equal(await page.locator("#reconciliation-action-count").textContent(), "4");
      await page.getByRole("button", { name: "Auswahl prüfen" }).click();
      await page.locator("#reconciliation-preview-modal").waitFor({ state: "visible" });
      assert.equal(await page.locator(".normalization-preview-person").count(), 4);
      assert.equal(await page.locator("#reconciliation-preview-list").textContent().then((text) => text.includes("dora@example.test")), true);
      await page.getByRole("button", { name: "Aktionen ausführen" }).click();
      await page.locator("#reconciliation-status").filter({ hasText: "erfolgreich" }).waitFor();
      const writes = await page.evaluate(() => window.__reconciliationWrites);
      assert.deepEqual(writes.map((entry) => entry.action).sort(), ["create", "deactivate", "update", "update"]);
      assert.equal(writes.find((entry) => entry.action === "create").values.email, "dora@example.test");
      assert.equal(writes.find((entry) => entry.action === "create").values.login, "dora@example.test");
      assert.deepEqual(writes.find((entry) => entry.personId === "1").changes, { city: "Neuer Ort" });
      await page.evaluate(() => window.__setReconciliationAuth(null, { status: "anonymous" }));
      await page.locator("#reconciliation-access").waitFor({ state: "visible" });
      assert.equal(await page.locator("#reconciliation-list").textContent(), "");
      assert.equal(await page.locator("#reconciliation-preview-list").textContent(), "");
      assert.equal(await page.locator("#reconciliation-results").isHidden(), true);
      assert.equal(await page.locator("#reconciliation-file").inputValue(), "");
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Familien-E-Mail legt neue Personen ohne Login und ohne Zusatzbestaetigung an", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 60000,
}, async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const address = server.address();
      await page.goto(`http://127.0.0.1:${address.port}/mitgliederAbgleichen.html`, { waitUntil: "domcontentloaded" });
      await page.locator("#reconciliation-app").waitFor({ state: "visible" });
      await page.locator("#reconciliation-file").setInputFiles({ name: "family.csv", mimeType: "text/csv", buffer: familyCsvBuffer() });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
      const newCards = page.locator('.reconciliation-card[data-category="new"]');
      for (let index = 0; index < 2; index++) {
        await newCards.nth(index).locator("summary").click();
        await newCards.nth(index).getByRole("checkbox", { name: "Neues Mitglied anlegen" }).click();
      }
      assert.equal(await page.getByRole("button", { name: "Auswahl prüfen" }).isEnabled(), true);
      await page.getByRole("button", { name: "Auswahl prüfen" }).click();
      await page.locator("#reconciliation-preview-modal").waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Aktionen ausführen" }).click();
      await page.locator("#reconciliation-status").filter({ hasText: "erfolgreich" }).waitFor();
      const creates = (await page.evaluate(() => window.__reconciliationWrites)).filter((write) => write.action === "create" && ["201", "202"].includes(write.externalId));
      assert.equal(creates.length, 2);
      assert.equal(creates.every((write) => !Object.hasOwn(write.values, "login")), true);
      await page.evaluate(() => window.__setReconciliationAuth(null, { status: "anonymous" }));
      await page.locator("#reconciliation-access").waitFor({ state: "visible" });
      assert.equal(await page.locator("#reconciliation-file").inputValue(), "");
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Mitgliederabgleich stoppt nach Teilerfolg und erhält verbleibende Auswahl", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 60000,
}, async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const page = await context.newPage();
    const address = server.address();
    await page.goto(`http://127.0.0.1:${address.port}/mitgliederAbgleichen.html`, { waitUntil: "domcontentloaded" });
    await page.locator("#reconciliation-app").waitFor({ state: "visible" });
    await page.locator("#reconciliation-file").setInputFiles({ name: "members.csv", mimeType: "text/csv", buffer: csvBuffer() });
    await page.locator("#reconciliation-results").waitFor({ state: "visible" });
    await page.locator('.reconciliation-card[data-category="changed"] summary').click();
    await page.getByRole("checkbox", { name: "Ort übernehmen" }).check();
    await page.locator('.reconciliation-card[data-category="missing"] summary').click();
    await page.getByRole("checkbox", { name: "Person deaktivieren" }).click();
    await page.evaluate(() => { window.__reconciliationFailureAfter = 1; });
    await page.getByRole("button", { name: "Auswahl prüfen" }).click();
    await page.getByRole("button", { name: "Aktionen ausführen" }).click();
    await page.locator("#reconciliation-status").filter({ hasText: "1 Personenaktionen wurden ausgeführt" }).waitFor();
    assert.equal((await page.locator("#reconciliation-status").textContent()).match(/conflict-reference/g)?.length, 1);
    assert.equal(await page.locator("#reconciliation-action-count").textContent(), "1");
    assert.equal((await page.evaluate(() => window.__reconciliationWrites)).length, 1);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Mitgliederabgleich verwirft bestaetigte Zuordnungen und ueberholte Loginvorschlaege", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 60000,
}, async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const page = await context.newPage();
    const address = server.address();
    await page.goto(`http://127.0.0.1:${address.port}/mitgliederAbgleichen.html`, { waitUntil: "domcontentloaded" });
    await page.locator("#reconciliation-app").waitFor({ state: "visible" });
    await page.locator("#reconciliation-file").setInputFiles({ name: "members.csv", mimeType: "text/csv", buffer: csvBuffer() });
    const unclear = page.locator('.reconciliation-card[data-category="unclear"]');
    await unclear.locator("summary").click();
    await unclear.getByRole("checkbox", { name: "Zuordnung bestätigen" }).click();
    const newCard = page.locator('.reconciliation-card[data-category="new"]');
    await newCard.locator("summary").click();
    await newCard.getByRole("checkbox", { name: "Neues Mitglied anlegen" }).click();
    assert.equal(await page.locator("#reconciliation-action-count").textContent(), "2");
    await page.evaluate(() => window.__changeReconciliationPerson("2", { fingerprint: "c".repeat(64) }));
    await page.evaluate(() => {
      window.__changeReconciliationPerson("1", { fingerprint: "d".repeat(64) });
      window.__changeReconciliationValues("1", { login: "dora@example.test" });
    });
    await page.getByRole("button", { name: "Bestand neu laden" }).click();
    await page.locator("#reconciliation-status").filter({ hasText: "lokal verglichen" }).waitFor();
    assert.equal(await page.locator("#reconciliation-action-count").textContent(), "0");
    const refreshedNewCard = page.locator('.reconciliation-card[data-category="new"]');
    await refreshedNewCard.locator("summary").click();
    assert.equal(await refreshedNewCard.getByRole("checkbox", { name: "Neues Mitglied anlegen" }).isChecked(), false);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Mitgliederabgleich verwirft eine laufende Dateilesung nach Autorisierungsverlust", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 60000,
}, async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const page = await context.newPage();
    const address = server.address();
    await page.goto(`http://127.0.0.1:${address.port}/mitgliederAbgleichen.html`, { waitUntil: "domcontentloaded" });
    await page.locator("#reconciliation-app").waitFor({ state: "visible" });
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function delayedArrayBuffer() {
        return new Promise((resolve, reject) => setTimeout(() => original.call(this).then(resolve, reject), 100));
      };
    });
    await page.locator("#reconciliation-file").setInputFiles({ name: "members.csv", mimeType: "text/csv", buffer: csvBuffer() });
    await page.evaluate(() => window.__setReconciliationAuth(null, { status: "anonymous" }));
    await page.waitForTimeout(150);
    assert.equal(await page.locator("#reconciliation-list").textContent(), "");
    assert.equal(await page.locator("#reconciliation-results").isHidden(), true);
    await page.evaluate(() => window.__setReconciliationAuth({ id: "1", role: "admin" }, { status: "authenticated" }));
    await page.locator("#reconciliation-app").waitFor({ state: "visible" });
    assert.equal(await page.locator("#reconciliation-results").isHidden(), true);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
