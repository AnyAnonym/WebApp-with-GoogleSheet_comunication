const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const FRONTEND_ROOT = path.resolve(__dirname, "../../Frontend");

const authStub = `
let user;
let status = "loading";
const listeners = new Set();
const authenticatedUser = { id: "player-1", role: "player", login: "player" };
const params = new URLSearchParams(location.search);
function resolveAuth(resolve) {
  user = params.get("anonymous") === "1" ? null : authenticatedUser;
  status = user ? "authenticated" : "anonymous";
  for (const listener of listeners) listener(user, { status, error: null });
  resolve(user);
}
export const ready = new Promise((resolve) => {
  if (params.get("manualAuth") === "1") window.__resolveAuth = () => resolveAuth(resolve);
  else setTimeout(() => resolveAuth(resolve), Number(params.get("authDelay") || 0));
});
export function subscribeAuth(callback) {
  listeners.add(callback);
  callback(user, { status, error: null });
  return () => listeners.delete(callback);
}
window.__loseSession = () => {
  user = null;
  status = "anonymous";
  for (const listener of listeners) listener(user, { status, error: null });
};
`;

const dataClientStub = `
window.__historyCalls = [];
export const subscribeInvalidations = () => () => {};
export function createEndpoint(name) {
  return async (params = {}) => {
    if (name === "bewerbe") return { data: { success: true, values: [
      ["ID", "BewerbsartID", "Bezeichnung", "EntryStart", "EntryDeadline", "Bewerbsbeginn", "Bewerbsende", "SortOrder"],
      ["2", "2", "Rangliste <img src=x onerror=alert(1)>", "", "", "20250101", "", "1"],
      ["3", "3", "Sommercup", "", "", "20250101", "", "2"],
    ] } };
    if (name === "bewerbsart") return { data: { success: true, values: [
      ["ID", "EntryListAvailable", "Bezeichnung", "RoundRobin"],
      ["2", "0", "Rangliste", "0"],
      ["3", "0", "KO", "0"],
    ] } };
    if (name === "competitionHistory") {
      window.__historyCalls.push({ ...params });
      if (new URLSearchParams(location.search).get("historyError") === "1") throw new Error("private failure");
      if (new URLSearchParams(location.search).get("historyEmpty") === "1") return { data: { success: true, events: [], nextCursor: null } };
      if (!params.bewerbId && params.cursor === "global-page-2") return { data: {
        success: true,
        history: [{ occurredAt: "2026-07-01T08:00:00.000Z", competitionName: "Wintercup", roundName: "Achtelfinale", summary: "Angelegt", actorName: "Test User" }],
        nextCursor: null,
      } };
      if (!params.bewerbId) return { data: {
        success: true,
        events: [
          { occurredAt: "2026-08-02T10:00:00.000Z", competitionName: "Sommercup", roundName: "Viertelfinale", type: "ranking_challenge_deleted", summary: "Zweite Änderung", result: "6-3/6-4", actorName: "Neu Spieler", detail: "Grund: Doppelte Forderung" },
          { occurredAt: "2026-08-01T09:00:00.000Z", competitionName: "Rangliste", summary: "Erste Änderung", actorName: "Alt Spieler" },
        ],
        nextCursor: "global-page-2",
      } };
      if (params.cursor === "page-2") return { data: {
        success: true,
        history: [{ occurredAt: "2026-07-01T08:00:00.000Z", roundName: "Achtelfinale", summary: "Angelegt", actorName: "Test User" }],
        nextCursor: null,
      } };
      return { data: {
        success: true,
        events: [
          { occurredAt: "2026-08-02T10:00:00.000Z", roundName: "Viertelfinale", type: "ranking_challenge_deleted", summary: "Zweite Änderung", result: "6-3/6-4", actorName: "Neu Spieler", detail: "Grund: Doppelte Forderung" },
          { occurredAt: "2026-08-01T09:00:00.000Z", roundName: "1. Gruppe", summary: "<img src=x onerror=alert(1)>", actorName: "Alt Spieler", detail: "Ebenfalls nicht anzeigen" },
        ],
        nextCursor: "page-2",
      } };
    }
    return { data: { success: true } };
  };
}
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
    if (pathname === "/JS/bewerbeList.js") {
      const source = fs.readFileSync(path.join(FRONTEND_ROOT, "JS/bewerbeList.js"), "utf8")
        .replace('"./dataClient.js"', '"/test/dataClient.js"')
        .replace('"./authClient.js"', '"/test/authClient.js"')
        .replace('"./loadingHelper.js"', '"/test/loadingHelper.js"')
        .replace('"./monitorReady.js"', '"/test/monitorReady.js"')
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
    if (pathname === "/test/loadingHelper.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end("export const callWithRetry = (fn) => fn(); export const showLoadingOverlay = () => {}; export const hideLoadingOverlay = () => {}; export const showErrorOverlay = () => {};\n");
      return;
    }
    if (pathname === "/test/monitorReady.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end("export const signalMonitorReady = () => {}; export const signalMonitorFailed = () => {};\n");
      return;
    }
    if (pathname === "/test/diagnostics.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end("window.__diagnostics = []; export const diagnostic = { error: (...args) => window.__diagnostics.push(args) };\n");
      return;
    }
    if (["/JS/modals.js", "/JS/navbar.js", "/JS/global.js", "/JS/clock.js", "/JS/footer.js"].includes(pathname)) {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end();
      return;
    }
    const relative = pathname.replace(/^\/+/, "");
    const filePath = path.resolve(FRONTEND_ROOT, relative || "Bewerbe.html");
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

test("Bewerbshistorie bleibt authentifiziert, sicher, paginiert und zugaenglich", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
    await page.goto(`http://127.0.0.1:${address.port}/Bewerbe.html?manualAuth=1`, { waitUntil: "domcontentloaded" });
    await page.locator(".bewerb-card").first().waitFor({ state: "visible" });
    assert.equal(await page.locator(".bewerb-grid").first().evaluate((grid) => getComputedStyle(grid).display), "block");
    assert.equal(await page.locator(".bewerb-card").first().getAttribute("role"), null);
    assert.equal(await page.locator(".bewerb-card").first().getAttribute("tabindex"), null);
    assert.equal(await page.locator(".bewerb-card").first().getByRole("link").getAttribute("href"), "rangliste.html?id=2");
    assert.equal(await page.getByRole("button", { name: /Historie von/ }).first().isHidden(), true);
    assert.equal(await page.getByRole("button", { name: "Historie aller Bewerbe öffnen" }).isHidden(), true);
    await page.evaluate(() => window.__resolveAuth());
    await page.getByRole("button", { name: /Historie von/ }).first().waitFor({ state: "visible" });
    const globalHistoryButton = page.getByRole("button", { name: "Historie aller Bewerbe öffnen" });
    await globalHistoryButton.waitFor({ state: "visible" });
    assert.equal(await globalHistoryButton.locator("svg").count(), 1);
    assert.equal(await globalHistoryButton.locator("svg").getAttribute("data-icon"), "megaphone");
    const pageHeadingGap = await page.locator(".bewerbe-page-heading").evaluate((row) => {
      const heading = row.querySelector("h2").getBoundingClientRect();
      const buttonElement = row.querySelector("button");
      const button = buttonElement.getBoundingClientRect();
      return {
        horizontal: button.left - heading.right,
        vertical: Math.abs((button.top + button.height / 2) - (heading.top + heading.height / 2)),
        outsideCards: !document.getElementById("bewerbe-container").contains(buttonElement),
      };
    });
    assert.equal(pageHeadingGap.horizontal >= 0 && pageHeadingGap.horizontal <= 8, true);
    assert.equal(pageHeadingGap.vertical <= 1, true);
    assert.equal(pageHeadingGap.outsideCards, true);

    const originalUrl = page.url();
    await globalHistoryButton.click();
    const modal = page.getByRole("dialog");
    await modal.waitFor({ state: "visible" });
    assert.equal(await modal.locator("#competition-history-title").innerText(), "Historie");
    assert.equal(await modal.locator("#competition-history-competition-name").innerText(), "Alle Bewerbe");
    assert.deepEqual(await page.evaluate(() => window.__historyCalls), [{}]);
    assert.deepEqual(await modal.locator(".competition-history-entry-competition").allTextContents(), ["Sommercup - Viertelfinale", "Rangliste"]);
    assert.deepEqual(await modal.locator(".competition-history-entry").first().locator(":scope > *").allTextContents(), [
      await modal.locator(".competition-history-entry").first().locator("time").innerText(),
      "Sommercup - Viertelfinale",
      "Zweite Änderung",
      "Grund: Doppelte Forderung",
      "Ergebnis: 6-3/6-4",
      "Durch: Neu Spieler",
    ]);
    const expectedHistoryStyles = [
      { color: "rgb(0, 0, 0)", fontSize: "14.4px", fontWeight: "400" },
      { color: "rgb(0, 0, 0)", fontSize: "14.4px", fontWeight: "400" },
      { color: "rgb(0, 0, 0)", fontSize: "14.4px", fontWeight: "700" },
      { color: "rgb(0, 0, 0)", fontSize: "14.4px", fontWeight: "400" },
      { color: "rgb(0, 0, 0)", fontSize: "14.4px", fontWeight: "400" },
      { color: "rgb(0, 0, 0)", fontSize: "14.4px", fontWeight: "400" },
    ];
    const historyStyles = () => modal.locator(".competition-history-entry").first().locator(":scope > *").evaluateAll((lines) => lines.map((line) => {
      const style = getComputedStyle(line);
      return { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight };
    }));
    assert.deepEqual(await historyStyles(), expectedHistoryStyles);
    await page.setViewportSize({ width: 1024, height: 720 });
    assert.deepEqual(await historyStyles(), expectedHistoryStyles);
    await page.setViewportSize({ width: 390, height: 640 });
    const scrollMetrics = await modal.locator("#competition-history-list").evaluate((list) => {
      const template = list.firstElementChild;
      for (let index = 0; index < 20; index++) list.appendChild(template.cloneNode(true));
      list.scrollTop = list.scrollHeight;
      const dialog = list.closest(".competition-history-dialog").getBoundingClientRect();
      return {
        clientHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
        scrollTop: list.scrollTop,
        dialogBottom: dialog.bottom,
        viewportHeight: innerHeight,
      };
    });
    assert.equal(scrollMetrics.scrollHeight > scrollMetrics.clientHeight, true);
    assert.equal(scrollMetrics.scrollTop > 0, true);
    assert.equal(scrollMetrics.dialogBottom <= scrollMetrics.viewportHeight, true);
    await page.getByRole("button", { name: "Weitere Einträge laden" }).click();
    assert.deepEqual(await page.evaluate(() => window.__historyCalls), [{}, { cursor: "global-page-2" }]);
    assert.deepEqual(await modal.locator(".competition-history-entry-competition").allTextContents(), ["Sommercup - Viertelfinale", "Rangliste", "Wintercup - Achtelfinale"]);
    await page.keyboard.press("Escape");
    assert.equal(await globalHistoryButton.evaluate((button) => document.activeElement === button), true);

    const historyButton = page.getByRole("button", { name: /Historie von/ }).first();
    assert.equal(await historyButton.innerText(), "");
    assert.equal(await historyButton.locator("svg").count(), 1);
    assert.equal(await historyButton.locator("svg").getAttribute("data-icon"), "megaphone");
    const headingGap = await page.locator(".bewerb-card").first().evaluate((card) => {
      const heading = card.querySelector("h3").getBoundingClientRect();
      const button = card.querySelector(".competition-history-button").getBoundingClientRect();
      return { horizontal: button.left - heading.right, vertical: Math.abs((button.top + button.height / 2) - (heading.top + heading.height / 2)) };
    });
    assert.equal(headingGap.horizontal >= 0 && headingGap.horizontal <= 8, true);
    assert.equal(headingGap.vertical <= 1, true);
    await historyButton.click();
    await modal.waitFor({ state: "visible" });
    assert.equal(await modal.locator("#competition-history-title").innerText(), "Historie");
    assert.equal(await modal.locator("#competition-history-competition-name").innerText(), "Rangliste <img src=x onerror=alert(1)>");
    assert.equal(await modal.locator(".competition-history-heading").evaluate((heading) => getComputedStyle(heading).textAlign), "center");
    assert.equal(await modal.locator("#competition-history-title").evaluate((title) => title.getBoundingClientRect().bottom <= document.getElementById("competition-history-competition-name").getBoundingClientRect().top), true);
    assert.equal(page.url(), originalUrl);
    assert.deepEqual(await page.evaluate(() => window.__historyCalls), [
      {},
      { cursor: "global-page-2" },
      { bewerbId: "2" },
    ]);
    assert.equal(await modal.locator("img").count(), 0);
    assert.deepEqual(await modal.locator(".competition-history-entry-title").allTextContents(), [
      "Zweite Änderung",
      "<img src=x onerror=alert(1)>",
    ]);
    assert.deepEqual(await modal.locator("#competition-history-list").evaluate((list) => ({ tag: list.tagName, style: getComputedStyle(list).listStyleType, overflow: getComputedStyle(list).overflowY })), {
      tag: "UL",
      style: "none",
      overflow: "auto",
    });
    assert.deepEqual(await modal.locator(".competition-history-entry").first().locator(":scope > *").allTextContents(), [
      await modal.locator(".competition-history-entry").first().locator("time").innerText(),
      "Viertelfinale",
      "Zweite Änderung",
      "Grund: Doppelte Forderung",
      "Ergebnis: 6-3/6-4",
      "Durch: Neu Spieler",
    ]);
    assert.deepEqual(await modal.locator(".competition-history-entry").nth(1).locator(":scope > *").allTextContents(), [
      await modal.locator(".competition-history-entry").nth(1).locator("time").innerText(),
      "1. Gruppe",
      "<img src=x onerror=alert(1)>",
      "Durch: Alt Spieler",
    ]);
    assert.equal((await modal.textContent()).includes("Grund: Doppelte Forderung"), true);
    assert.equal((await modal.textContent()).includes("Ebenfalls nicht anzeigen"), false);
    assert.equal(await page.locator("#competition-history-close").evaluate((button) => document.activeElement === button), true);

    await page.getByRole("button", { name: "Weitere Einträge laden" }).click();
    assert.deepEqual(await page.evaluate(() => window.__historyCalls), [
      {},
      { cursor: "global-page-2" },
      { bewerbId: "2" },
      { bewerbId: "2", cursor: "page-2" },
    ]);
    assert.deepEqual(await modal.locator(".competition-history-entry-title").allTextContents(), [
      "Zweite Änderung",
      "<img src=x onerror=alert(1)>",
      "Angelegt",
    ]);
    const bounds = await modal.locator(".competition-history-dialog").evaluate((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight };
    });
    assert.equal(bounds.left >= 0 && bounds.right <= bounds.width, true);
    assert.equal(bounds.top >= 0 && bounds.bottom <= bounds.height, true);

    await page.keyboard.press("Escape");
    assert.equal(await modal.isHidden(), true);
    assert.equal(await historyButton.evaluate((button) => document.activeElement === button), true);

    await globalHistoryButton.click();
    await modal.waitFor({ state: "visible" });
    await page.evaluate(() => window.__loseSession());
    assert.equal(await modal.isHidden(), true);
    assert.equal(await historyButton.isHidden(), true);
    assert.equal(await globalHistoryButton.isHidden(), true);
    assert.equal(await page.locator("#competition-history-list").textContent(), "");
    await page.close();

    const errorPage = await browser.newPage();
    await errorPage.goto(`http://127.0.0.1:${address.port}/Bewerbe.html?historyError=1`, { waitUntil: "domcontentloaded" });
    await errorPage.getByRole("button", { name: /Historie von/ }).first().click();
    await errorPage.getByText("Historie konnte nicht geladen werden. Bitte erneut versuchen.").waitFor({ state: "visible" });
    assert.deepEqual(await errorPage.evaluate(() => window.__diagnostics.map((entry) => entry[0])), ["competition_history_load_failed"]);
    await errorPage.getByRole("button", { name: "Erneut versuchen" }).click();
    assert.equal((await errorPage.evaluate(() => window.__historyCalls)).length, 2);
    await errorPage.close();

    const emptyPage = await browser.newPage();
    await emptyPage.goto(`http://127.0.0.1:${address.port}/Bewerbe.html?historyEmpty=1`, { waitUntil: "domcontentloaded" });
    await emptyPage.getByRole("button", { name: /Historie von/ }).first().click();
    await emptyPage.getByText("Keine Historieneinträge vorhanden.").waitFor({ state: "visible" });
    assert.equal(await emptyPage.locator(".competition-history-entry").count(), 0);
    await emptyPage.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
