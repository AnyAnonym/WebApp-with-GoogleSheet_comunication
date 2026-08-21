const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const FRONTEND_ROOT = path.resolve(__dirname, "../../Frontend");

const authStub = `
const role = new URLSearchParams(window.location.search).get("role");
const user = role ? { id: role + "-1", role } : null;
export const ready = Promise.resolve(user);
export function subscribeAuth(callback) {
  queueMicrotask(() => callback(user, { status: user ? "authenticated" : "anonymous" }));
  return () => {};
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
    if (pathname === "/JS/authClient.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(authStub);
      return;
    }
    if (["/JS/staticReady.js", "/JS/modals.js", "/JS/global.js", "/JS/clock.js", "/JS/footer.js"].includes(pathname)) {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end();
      return;
    }
    const relative = pathname.replace(/^\/+/, "");
    const filePath = path.resolve(FRONTEND_ROOT, relative || "index.html");
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

test("Mobile Navigation zeigt rollenabhaengige Links nur berechtigten Benutzern", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const cases = [
      { role: "", playersVisible: false, adminVisible: false },
      { role: "player", playersVisible: true, adminVisible: false },
      { role: "admin", playersVisible: true, adminVisible: true },
    ];
    for (const expected of cases) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      try {
        await page.goto(`http://127.0.0.1:${address.port}/index.html?role=${expected.role}`, { waitUntil: "domcontentloaded" });
        await page.locator("#hamburgerBtn").click();
        await page.locator("#mobileNavModal").waitFor({ state: "visible" });

        const players = page.locator('.mobile-nav-links [data-auth="required"]');
        const adminLinks = page.locator('.mobile-nav-links [data-role="admin"]');
        assert.equal(await players.isVisible(), expected.playersVisible, `${expected.role || "anonymous"}: Spielerlink`);
        for (const link of await adminLinks.all()) {
          assert.equal(await link.isVisible(), expected.adminVisible, `${expected.role || "anonymous"}: ${await link.textContent()}`);
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
