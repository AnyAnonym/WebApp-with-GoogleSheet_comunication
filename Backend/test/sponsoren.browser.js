const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const FRONTEND_ROOT = path.resolve(__dirname, "../../Frontend");

function contentType(filename) {
  if (filename.endsWith(".html")) return "text/html; charset=utf-8";
  if (filename.endsWith(".css")) return "text/css; charset=utf-8";
  if (filename.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filename.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/harness.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<!doctype html><html><head><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}</style></head><body><iframe src="/Sponsoren.html?monitor=1&_command=sponsor-test"></iframe><script>window.addEventListener("message", event => { window.monitorMessage = event.data; });</script></body></html>');
      return;
    }
    const filename = path.resolve(FRONTEND_ROOT, `.${pathname}`);
    if (!filename.startsWith(`${FRONTEND_ROOT}${path.sep}`) || !fs.existsSync(filename)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": contentType(filename) });
    fs.createReadStream(filename).pipe(response);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("Sponsorenbild wird unverzerrt im Vollbild geladen und meldet Monitor-Ready", async (t) => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
  await page.waitForFunction(() => window.monitorMessage?.status === "ready");
  const frame = page.frames().find((entry) => entry.url().includes("/Sponsoren.html"));
  const layout = await frame.locator("#sponsoren-image").evaluate((image) => ({
    objectFit: getComputedStyle(image).objectFit,
    width: image.getBoundingClientRect().width,
    height: image.getBoundingClientRect().height,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    overflow: getComputedStyle(document.body).overflow,
  }));
  assert.deepEqual(layout, {
    objectFit: "contain",
    width: 1024,
    height: 768,
    naturalWidth: 1280,
    naturalHeight: 720,
    overflow: "hidden",
  });
  assert.deepEqual(await page.evaluate(() => window.monitorMessage), {
    type: "epiber-monitor-ready",
    commandId: "sponsor-test",
    status: "ready",
  });
});

test("Bildladefehler wird dem Monitor gemeldet", async (t) => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const page = await browser.newPage();
  await page.route("**/sponsoren.jpeg", (route) => route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
  await page.waitForFunction(() => window.monitorMessage?.status === "failed");
  assert.equal(await page.evaluate(() => window.monitorMessage.errorCode), "SPONSOR_IMAGE_LOAD_FAILED");
});
