const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const FRONTEND_ROOT = path.resolve(__dirname, "../../Frontend");

const authStub = `
export const ready = Promise.resolve();
export function getUser() { return { id: "admin-1", role: "admin" }; }
export function subscribeAuth(callback) {
  queueMicrotask(() => callback(getUser(), { status: "authenticated" }));
  return () => {};
}
`;

const dataStub = `
let snapshot = {
  success: true,
  issueCount: 1,
  affectedCount: 1,
  people: [{
    id: "p1",
    fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    values: {
      firstName: " Ada ", lastName: "Admin", birthDate: "02.01.1990", gender: "2",
      phone: "0043 664 1234567", email: "ada@example.test", login: "old.login", country: "Österreich",
      postalCode: "4060", city: "Piberbach", address: "Dorf 1", active: "1", role: "admin"
    },
    issues: [{ field: "firstName", code: "EDGE_WHITESPACE", message: "Rand-Leerraum", proposedValue: "Ada" }]
  }]
};
window.__normalizationWrites = [];
window.__normalizationFailure = false;
export function createEndpoint(endpoint) {
  return async (params = {}) => {
    if (endpoint === "adminPeopleNormalization") return { data: structuredClone(snapshot) };
    if (window.__normalizationFailure) {
      const error = new Error("Die Google-Sheets-Schnittstelle hat ihr Zugriffslimit erreicht. Bitte etwa eine Minute warten und danach erneut versuchen. (Referenz: quota-reference)");
      error.code = "SHEETS_RATE_LIMITED";
      error.supportId = "quota-reference";
      throw error;
    }
    window.__normalizationWrites.push(structuredClone(params));
    Object.assign(snapshot.people[0].values, params.changes);
    snapshot.people[0].issues = [];
    snapshot.people[0].fingerprint = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    snapshot.issueCount = 0;
    snapshot.affectedCount = 0;
    return { data: { success: true, personId: params.personId, fingerprint: snapshot.people[0].fingerprint } };
  };
}
export function getOperationId() { return "00000000-0000-4000-8000-000000000099"; }
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
    const filePath = path.resolve(FRONTEND_ROOT, relative || "personenNormalisieren.html");
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

test("Normalisierungsseite funktioniert responsiv und zeigt Quotenfehler mit einer Referenz", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 60000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/personenNormalisieren.html`, { waitUntil: "domcontentloaded" });
      await page.locator("#normalization-app").waitFor({ state: "visible" });
      await page.locator("#normalization-access").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#normalization-access").evaluate((element) => getComputedStyle(element).display), "none");
      assert.equal(await page.locator(".normalization-person").count(), 1);
      assert.equal(await page.locator("#normalization-affected-count").textContent(), "1");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

      await page.locator(".normalization-person summary").click();
      await page.getByRole("button", { name: "Vorschlag übernehmen" }).click();
      const login = page.locator('[data-field="login"]');
      assert.equal(await login.isVisible(), true);
      assert.equal(await login.inputValue(), "old.login");
      await login.fill("NEW.LOGIN");
      assert.equal(await page.locator("#normalization-change-count").textContent(), "2");
      await page.getByRole("button", { name: "Änderungen prüfen" }).click();
      await page.locator("#normalization-preview-modal").waitFor({ state: "visible" });
      assert.equal(await page.locator(".normalization-preview-row").count(), 2);
      assert.equal(await page.locator(".normalization-preview-value").nth(1).textContent(), "Ada");
      assert.equal(await page.locator(".normalization-preview-value").nth(3).textContent(), "new.login");
      const expectFailure = viewport.width === 1280;
      if (expectFailure) await page.evaluate(() => { window.__normalizationFailure = true; });
      await page.getByRole("button", { name: "Änderungen schreiben" }).click();
      await page.locator("#normalization-status").filter({ hasText: expectFailure ? "Zugriffslimit" : "erfolgreich" }).waitFor();
      const status = await page.locator("#normalization-status").textContent();
      if (expectFailure) assert.equal(status.match(/quota-reference/g)?.length, 1);
      const writes = await page.evaluate(() => window.__normalizationWrites);
      assert.equal(writes.length, expectFailure ? 0 : 1);
      if (!expectFailure) {
        assert.deepEqual(writes[0].changes, { firstName: "Ada", login: "new.login" });
        assert.equal(writes[0].personId, "p1");
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
