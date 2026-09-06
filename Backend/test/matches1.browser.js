const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const FRONTEND_ROOT = path.resolve(__dirname, "../../Frontend");

const dataClientStub = `
const responses = {
  matches1: { data: { success: true, values: [
    ["ID", "MatchDate", "MatchStart", "MatchEnde", "ForderungDate", "BewerbID", "BewerbRunde", "Spieler1ID", "Spieler2ID", "Spieler3ID", "Spieler4ID", "Ergebnis"],
    ["regular", "260904-1800", "260904-1807", "260904-1942", "260901-1200", "cup", "F", "p1", "", "p2", "", "6-4/6-3"],
    ["walkover", "260903-1800", "", "", "260831-1200", "cup", "HF-P1", "p1", "", "p2[wo]", "", ""],
    ["retirement-result", "260902-1800", "260902-2330", "260903-0100", "260830-1200", "cup", "HF-P2", "p1[ret]", "", "p2", "", "6-4/2-1"],
    ["retirement-empty", "260901-1800", "260901-1805", "", "", "cup", "VF-P1", "p1", "", "p2[ret]", "", ""],
  ] } },
  players: { data: { success: true, values: [
    ["ID", "Vorname", "Nachname", "Aktiv"],
    ["p1", "Anna", "Links", "1"],
    ["p2", "Berta", "Rechts", "1"],
  ] } },
  bewerbe: { data: { success: true, values: [
    ["ID", "Bezeichnung"],
    ["cup", "Vereinsmeisterschaft"],
  ] } },
};
export const createEndpoint = (name) => async () => structuredClone(responses[name]);
export const subscribeInvalidations = () => () => {};
`;

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/matches-test.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/CSS/styles.css"><link rel="stylesheet" href="/CSS/Matches1.css"></head><body><main><section><div id="matches1-controls"><div class="m1-category-bar"><button class="m1-cat-btn active" data-cat="played">Gespielt</button><button class="m1-cat-btn" data-cat="open">Offen</button><button class="m1-cat-btn" data-cat="all">Alle</button></div><button id="filterToggle"></button><div id="filterPanel" class="hidden"><input type="checkbox" id="filterCompleteWithoutDate"><input type="checkbox" id="filterBewerb"><select id="filterBewerbSelect" disabled></select><input type="checkbox" id="filterSpieler"><select id="filterSpielerSelect" disabled></select><input type="checkbox" id="filterDatum"><div id="datumRow" class="hidden"><input id="datumVon"><input id="datumBis"></div><input type="checkbox" id="filterMissing"></div></div><div id="matches1-count"></div><div id="matches1-container"></div></section></main><script type="module" src="/JS/Matches1-under-test.js"></script></body></html>`);
      return;
    }
    if (pathname === "/JS/Matches1-under-test.js") {
      const source = fs.readFileSync(path.join(FRONTEND_ROOT, "JS/Matches1.js"), "utf8")
        .replace('"./dataClient.js"', '"/test/dataClient.js"')
        .replace('"./loadingHelper.js"', '"/test/loadingHelper.js"')
        .replace('"./monitorReady.js"', '"/test/monitorReady.js"');
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(source);
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

test("Matches zeigen WO und RET nur als Namensbadge und rechts nur das Satzergebnis", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
    await page.goto(`http://127.0.0.1:${address.port}/matches-test.html`, { waitUntil: "domcontentloaded" });
    await page.locator(".m1-card").nth(3).waitFor({ state: "visible" });

    const cards = page.locator(".m1-card");
    assert.deepEqual(await cards.locator(".m1-result").allTextContents(), ["6-4/6-3", "", "6-4/2-1", ""]);
    assert.equal(await cards.nth(0).locator(".badge-wo, .badge-ret").count(), 0);
    assert.equal(await cards.nth(1).locator(".m1-team").nth(1).locator(".badge-wo").textContent(), "wo");
    assert.equal(await cards.nth(2).locator(".m1-team").nth(0).locator(".badge-ret").textContent(), "ret");
    assert.equal(await cards.nth(3).locator(".m1-team").nth(1).locator(".badge-ret").textContent(), "ret");
    assert.equal(await cards.locator(".m1-result").first().evaluate((result) => getComputedStyle(result).whiteSpace), "nowrap");
    assert.deepEqual(await cards.locator(".m1-timing").allTextContents(), [
      "(18:07 - 19:42 Uhr = 1 Stunde 35 Minuten)",
      "(23:30 - 01:00 Uhr = 1 Stunde 30 Minuten)",
    ]);
    assert.equal(await cards.nth(0).locator(".m1-date").textContent(), "04.09.2026 - 18:00 (18:07 - 19:42 Uhr = 1 Stunde 35 Minuten)");
    assert.equal(await cards.nth(3).locator(".m1-timing").count(), 0);
    const requestCenters = await cards.locator(".m1-forderung").evaluateAll((elements) => elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left + bounds.width / 2;
    }));
    assert.equal(requestCenters.length, 3);
    assert.equal(requestCenters.every((center) => Math.abs(center - requestCenters[0]) < 1), true);

    await page.setViewportSize({ width: 360, height: 700 });
    const dateBox = await cards.nth(0).locator(".m1-date").boundingBox();
    assert.ok(dateBox);
    assert.ok(dateBox.x >= 0 && dateBox.x + dateBox.width <= 360);
    assert.equal(await cards.nth(0).locator(".m1-timing").evaluate((timing) => getComputedStyle(timing).whiteSpace), "normal");
    const mobileMeta = await cards.nth(0).locator(".m1-meta").evaluate((meta) => {
      const date = meta.querySelector(".m1-date").getBoundingClientRect();
      const request = meta.querySelector(".m1-forderung").getBoundingClientRect();
      return { direction: getComputedStyle(meta).flexDirection, requestBelowDate: request.top >= date.bottom };
    });
    assert.deepEqual(mobileMeta, { direction: "column", requestBelowDate: true });
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
