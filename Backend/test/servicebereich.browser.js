const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const FRONTEND_ROOT = path.resolve(__dirname, "../../Frontend");

const authStub = `
let user = { id: "admin-1", role: "admin", login: "admin" };
let listener = null;
export const ready = Promise.resolve(user);
export function subscribeAuth(callback) {
  listener = callback;
  queueMicrotask(() => callback(user, { status: "authenticated" }));
  return () => {};
}
window.__loseServiceAuth = () => {
  user = null;
  listener?.(null, { status: "anonymous" });
};
`;

const dataClientStub = `
let refreshCount = 0;
let statusCount = 0;
let resolveRefresh = null;
const status = {
  success: true,
  lastSuccessfulRefreshAt: "2026-08-28T10:00:00.000Z",
  dataAgeMs: 65000,
  inProgress: null,
  lastControlledFailure: {
    at: "2026-08-28T09:00:00.000Z",
    message: "Kontrolliert <img src=x onerror=alert(1)>",
    supportId: "support-safe-1",
  },
};
export function createEndpoint(name) {
  if (name === "sheetDataStatus") return async () => { statusCount += 1; return { data: status }; };
  if (name === "refreshSheetData") return async (params) => {
    refreshCount += 1;
    window.__lastRefreshParams = params;
    return new Promise((resolve) => { resolveRefresh = resolve; });
  };
  throw new Error("unexpected endpoint " + name);
}
export const getOperationId = () => "00000000-0000-4000-8000-000000000001";
export const releaseOperationId = () => {};
window.__serviceRefreshCount = () => refreshCount;
window.__serviceStatusCount = () => statusCount;
window.__resolveServiceRefresh = () => resolveRefresh?.({ data: { success: true } });
`;

function contentType(filename) {
  if (filename.endsWith(".html")) return "text/html; charset=utf-8";
  if (filename.endsWith(".css")) return "text/css; charset=utf-8";
  return "text/javascript; charset=utf-8";
}

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/JS/servicebereich.js") {
      const source = fs.readFileSync(path.join(FRONTEND_ROOT, "JS/servicebereich.js"), "utf8")
        .replace('"./authClient.js"', '"/test/authClient.js"')
        .replace('"./dataClient.js"', '"/test/dataClient.js"')
        .replace('"./diagnostics.js"', '"/test/diagnostics.js"');
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(source);
      return;
    }
    if (pathname === "/test/authClient.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(authStub);
      return;
    }
    if (pathname === "/test/dataClient.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(dataClientStub);
      return;
    }
    if (pathname === "/test/diagnostics.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end("export const diagnostic = { error() {} };\n");
      return;
    }
    if (["/JS/navbar.js", "/JS/modals.js", "/JS/global.js", "/JS/footer.js"].includes(pathname)) {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end();
      return;
    }
    const relative = pathname.replace(/^\/+/, "") || "servicebereich.html";
    const filename = path.resolve(FRONTEND_ROOT, relative);
    if (!filename.startsWith(`${FRONTEND_ROOT}${path.sep}`) || !fs.existsSync(filename)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": contentType(filename) });
    response.end(fs.readFileSync(filename));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("Servicebereich rendert kontrolliert und sperrt Refresh bei Authverlust", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/servicebereich.html`, { waitUntil: "domcontentloaded" });
    const button = page.getByRole("button", { name: "Daten aktualisieren", exact: true });
    await button.waitFor({ state: "visible" });
    await page.locator("#service-state-badge").filter({ hasText: "Bereit" }).waitFor();

    assert.equal(await page.locator("#service-failure img").count(), 0);
    assert.match(await page.locator("#service-failure-message").textContent(), /<img src=x/);
    assert.equal(await page.locator("#service-failure-support").textContent(), "Support-ID: support-safe-1");

    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await page.waitForFunction(() => window.__serviceStatusCount() === 2);

    await button.dblclick();
    assert.equal(await page.evaluate(() => window.__serviceRefreshCount()), 1);
    assert.equal(await button.isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.__lastRefreshParams), {
      operationId: "00000000-0000-4000-8000-000000000001",
    });

    await page.evaluate(() => window.__loseServiceAuth());
    await page.evaluate(() => window.__resolveServiceRefresh());
    await page.locator("#service-access").waitFor({ state: "visible" });
    assert.equal(await page.locator("#service-app").isHidden(), true);
    assert.doesNotMatch(await page.locator("#service-feedback").textContent(), /erfolgreich aktualisiert/);
    await page.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
