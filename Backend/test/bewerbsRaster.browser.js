const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const FRONTEND_ROOT = path.resolve(__dirname, "../../Frontend");

const authStub = `
let user = null;
const listeners = new Set();
export const ready = Promise.resolve();
export const getUser = () => user;
export function subscribeAuth(callback) {
  listeners.add(callback);
  queueMicrotask(() => callback(user));
  return () => listeners.delete(callback);
}
window.__setAuth = (role) => {
  user = role ? { id: role + "-1", role } : null;
  for (const callback of listeners) callback(user);
};
`;

const dataClientStub = `
const responses = {
  bewerbe: { data: { success: true, values: [["ID", "BewerbsartID", "Bezeichnung"], ["cup", "ko", "Doppelcup"]] } },
  bewerbsart: { data: { success: true, values: [["ID", "Rasterfunktion", "RoundRobin"], ["ko", "8", "1"]] } },
  players: { data: { success: true, values: [
    ["ID", "Vorname", "Nachname"],
    ["p1", "Anna", "Links"], ["p2", "Berta", "Rechts"],
    ["p3", "Clara", "Oben"], ["p4", "Dora", "Unten"],
    ["p5", "Eva", "Einzel"], ["p6", "Fina", "Gegnerin"],
  ] } },
  matches: { data: { success: true, values: [
    ["BewerbID", "Spieler1ID", "Spieler2ID", "Spieler3ID", "Spieler4ID", "BewerbRunde", "Ergebnis", "MatchDate"],
    ["cup", "p1", "p2", "p3 [ret]", "p4", "VF-P1", "6-4/2-1", "260901-1000"],
    ["cup", "p5", "", "BYE", "", "VF-P2", "", ""],
    ["cup", "p1", "p2", "p5", "", "HF-P1", "", ""],
    ["cup", "p3", "p4", "p6", "", "HF-P2", "", ""],
    ["cup", "p1", "p2", "p3", "p4", "F", "", ""],
    ["cup", "p1", "p2", "p3 [wo]", "p4", "G1-P1", "", "260902-1000"],
  ] } },
};
export const createEndpoint = (name) => async () => structuredClone(responses[name]);
export const subscribeInvalidations = () => () => {};
`;

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/raster-test.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/CSS/styles.css"></head><body class="bracket-page"><main><h2 id="bracketHeading"></h2><div id="bracketInfo"></div><div id="bracketContainer"></div></main><script>window.__profileCalls=[];window.openProfileModal=(options)=>window.__profileCalls.push(options);</script><script type="module" src="/JS/bewerbsRaster-under-test.js"></script></body></html>');
      return;
    }
    if (pathname === "/JS/bewerbsRaster-under-test.js") {
      const source = fs.readFileSync(path.join(FRONTEND_ROOT, "JS/bewerbsRaster.js"), "utf8")
        .replace('"./dataClient.js"', '"/test/dataClient.js"')
        .replace('"./authClient.js"', '"/test/authClient.js"')
        .replace('"./loadingHelper.js"', '"/test/loadingHelper.js"')
        .replace('"./monitorReady.js"', '"/test/monitorReady.js"');
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(source);
      return;
    }
    if (pathname === "/JS/RoundRobin.js") {
      const source = fs.readFileSync(path.join(FRONTEND_ROOT, "JS/RoundRobin.js"), "utf8")
        .replace('"./dataClient.js"', '"/test/dataClient.js"')
        .replace('"./authClient.js"', '"/test/authClient.js"')
        .replace('"./loadingHelper.js"', '"/test/loadingHelper.js"')
        .replace('"./monitorReady.js"', '"/test/monitorReady.js"');
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
    const filePath = path.resolve(FRONTEND_ROOT, pathname.replace(/^\/+/, ""));
    if (!filePath.startsWith(`${FRONTEND_ROOT}${path.sep}`) || !fs.existsSync(filePath)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": filePath.endsWith(".css") ? "text/css" : "application/octet-stream" });
    response.end(fs.readFileSync(filePath));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("KO-Doppelnamen werden erst nach Login getrennt und zugaenglich anklickbar", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${address.port}/raster-test.html?id=cup`, { waitUntil: "domcontentloaded" });
    await page.locator(".bracket").waitFor();
    assert.deepEqual(await page.locator(".bracket-round-header").allTextContents(), ["Viertelfinale", "Halbfinale", "Finale"]);
    assert.equal(await page.locator("button.bracket-player-name").count(), 0);
    assert.match(await page.locator('.bracket-match[data-round-index="0"] .bracket-player').first().innerText(), /Anna Links\s*\/\s*Berta Rechts/);
    assert.equal(await page.locator('.bracket-match[data-round-index="0"] .bracket-completion').textContent({ timeout: 2000 }), "Aufgabe durch Clara Oben / Dora Unten: 6-4/2-1");

    await page.getByRole("button", { name: "Gruppe" }).click();
    await page.locator(".rr-player-name").first().waitFor({ timeout: 3000 });
    assert.equal(await page.locator(".rr-pairing-result").textContent({ timeout: 2000 }), "Walkover durch Clara Oben / Dora Unten");
    assert.equal(await page.locator("button.rr-player").count(), 0);
    await page.evaluate(() => window.__setAuth("player"));
    await page.locator("button.rr-player").first().waitFor({ timeout: 3000 });
    assert.equal(await page.locator("button.rr-player").count() > 1, true);
    await page.evaluate(() => window.__setAuth(null));
    await page.waitForFunction(() => document.querySelectorAll("button.rr-player").length === 0, null, { timeout: 3000 });
    await page.getByRole("button", { name: "Raster" }).click();
    await page.locator(".bracket").waitFor({ timeout: 3000 });

    await page.evaluate(() => window.__setAuth("player"));
    const firstTeam = page.locator('.bracket-match[data-round-index="0"] .bracket-player').first();
    await firstTeam.locator("button.bracket-player-name").first().waitFor({ timeout: 3000 });
    assert.equal(await firstTeam.locator("button.bracket-player-name").count(), 2);
    await firstTeam.locator("button.bracket-player-name").nth(1).click();
    assert.deepEqual(await page.evaluate(() => window.__profileCalls), [{ playerId: "p2" }]);
    await firstTeam.locator("button.bracket-player-name").first().focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => window.__profileCalls), [{ playerId: "p2" }, { playerId: "p1" }]);
    const layout = await firstTeam.evaluate((slot) => {
      const buttons = [...slot.querySelectorAll("button.bracket-player-name")].map((button) => button.getBoundingClientRect());
      const result = slot.querySelector(".player-result")?.getBoundingClientRect();
      return { buttonHeights: buttons.map(({ height }) => height), namesRight: buttons.at(-1).right, resultLeft: result.left };
    });
    assert.equal(layout.buttonHeights.every((height) => height >= 24), true);
    assert.equal(layout.namesRight <= layout.resultLeft, true);

    await page.evaluate(() => window.__setAuth(null));
    await page.waitForFunction(() => document.querySelectorAll("button.bracket-player-name").length === 0, null, { timeout: 3000 });
    assert.equal(await page.locator("button.bracket-player-name").count(), 0);
    assert.equal(await page.locator('.bracket-player-name[data-player-id="p1"]').count(), 0);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
