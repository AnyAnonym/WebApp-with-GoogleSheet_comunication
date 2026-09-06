const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const FRONTEND_ROOT = path.resolve(__dirname, "../../Frontend");

const dataClientStub = `
const snapshot = {
  success: true,
  playersValues: [
    ["ID", "Vorname", "Nachname"],
    ["p1", "Anna", "Links"],
    ["p2", "Berta", "Rechts"],
  ],
  bewerbValues: [["ID", "Bezeichnung"], ["cup", "Vereinsmeisterschaft"]],
  matchesValues: [
    ["ID", "MatchDate", "BewerbID", "BewerbRunde", "Spieler1ID", "Spieler2ID", "Spieler3ID", "Spieler4ID", "Ergebnis"],
    ["regular", "260904-1800", "cup", "F", "p1", "", "p2", "", "6-4/6-3"],
    ["walkover", "260903-1800", "cup", "HF-P1", "p1", "", "p2[wo]", "", ""],
    ["retirement-result", "260902-1800", "cup", "HF-P2", "p1[ret]", "", "p2", "", "6-4/2-1"],
    ["retirement-empty", "260901-1800", "cup", "VF-P1", "p1", "", "p2[ret]", "", ""],
  ],
  courts: { "1": {}, "2": {} },
  scores: { revision: 1, source: {}, courts: [] },
  revisions: { players: 1, bewerbe: 1, matchtyp: 1, matches1: 1 },
};
export const createEndpoint = () => async () => ({ data: structuredClone(snapshot) });
export const subscribe = () => () => {};
export const onConnectionState = (callback) => { callback({ state: "connected", connected: true }); return () => {}; };
export const onResync = () => () => {};
`;

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/scoreboard-test.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(fs.readFileSync(path.join(FRONTEND_ROOT, "scoreboard.html"), "utf8"));
      return;
    }
    if (pathname === "/JS/scoreboardPolling.js") {
      const source = fs.readFileSync(path.join(FRONTEND_ROOT, "JS/scoreboardPolling.js"), "utf8")
        .replace('"./dataClient.js"', '"/test/dataClient.js"')
        .replace('"./monitorReady.js"', '"/test/monitorReady.js"')
        .replace('"./diagnostics.js"', '"/test/diagnostics.js"')
        .replace('"./scoreboardSizing.js"', '"/test/scoreboardSizing.js"');
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(source);
      return;
    }
    if (pathname === "/test/dataClient.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(dataClientStub);
      return;
    }
    if (pathname === "/test/monitorReady.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end("export const signalMonitorReady = () => {}; export const signalMonitorFailed = () => {};\n");
      return;
    }
    if (pathname === "/test/diagnostics.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end("export const diagnostic = { debug() {}, info() {}, warn() {}, error() {} };\n");
      return;
    }
    if (pathname === "/test/scoreboardSizing.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end("export const largestPlayerNameSize = () => 16;\n");
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

test("Scoreboard zeigt WO und RET nur als Namensbadge und rechts nur das Satzergebnis", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => pageErrors.push(`${request.url()}: ${request.failure()?.errorText || "request failed"}`));
    await page.goto(`http://127.0.0.1:${address.port}/scoreboard-test.html`, { waitUntil: "commit", timeout: 5000 });
    await page.locator("#scoreboard-content.loaded").waitFor({ state: "visible", timeout: 5000 }).catch(() => {
      assert.fail(`Scoreboard wurde nicht geladen: ${pageErrors.join("; ") || "kein Browserfehler gemeldet"}`);
    });

    const entries = page.locator("#letzte .archived-entry");
    assert.equal(await entries.count(), 4);
    assert.deepEqual(await entries.locator(".ae-result").allTextContents(), ["6-4/6-3", "", "6-4/2-1", ""]);
    assert.equal(await entries.nth(0).locator(".badge").count(), 0);
    assert.equal(await entries.nth(1).locator(".badge").textContent(), "wo");
    assert.equal(await entries.nth(2).locator(".badge").textContent(), "ret");
    assert.equal(await entries.nth(3).locator(".badge").textContent(), "ret");
    assert.equal(await entries.locator(".ae-result").first().evaluate((result) => getComputedStyle(result).whiteSpace), "nowrap");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
