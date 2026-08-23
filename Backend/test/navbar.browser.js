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
const user = role ? { id: role + "-1", role, login: role + "-login", email: role + "@example.test" } : null;
export const ready = Promise.resolve(user);
export const createPasswordReset = async () => ({ resetToken: "token" });
export const login = async () => user;
export const logout = async () => {};
export const changePassword = async () => ({ success: true });
export const getUser = () => user;
export const isAuthenticated = () => Boolean(user);
export const refreshSession = async () => user;
export const resetPassword = async () => ({ success: true });
export const setPasswordSetupAllowed = async () => ({ success: true });
export const setPasswordForPerson = async () => ({ success: true });
export const setupPassword = async () => ({ success: true });
export function subscribeAuth(callback) {
  queueMicrotask(() => callback(user, { status: user ? "authenticated" : "anonymous" }));
  return () => {};
}
`;

const dataClientStub = `
export const getOperationId = () => "operation";
export const releaseOperationId = () => {};
export function createEndpoint(name) {
  return async () => {
    const role = new URLSearchParams(window.location.search).get("role");
    if (name === "myProfile") return { data: { success: true, profile: {
      id: role + "-1", firstName: "Own", lastName: "Player", login: role + "-login",
      email: "contact@example.test", phone: "", birthDate: "",
    } } };
    if (name === "publicProfile") return { data: { success: true, profile: {
      id: "p2", firstName: "Foreign", lastName: "Player",
      ...(role === "admin" ? { login: "foreign-login" } : {}),
      email: "directory@example.test", phone: "", birthDate: "",
    } } };
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
    if (pathname === "/modals-test.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<!doctype html><html><body><script type="module" src="/JS/modals-under-test.js"></script></body></html>');
      return;
    }
    if (pathname === "/JS/modals-under-test.js") {
      const source = fs.readFileSync(path.join(FRONTEND_ROOT, "JS/modals.js"), "utf8")
        .replace('"./dataClient.js"', '"/test/dataClient.js"')
        .replace('"./authClient.js"', '"/test/authClient.js"')
        .replace('"./diagnostics.js"', '"/test/diagnostics.js"')
        .replace('"./profileModalState.js"', '"/test/profileModalState.js"');
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
    if (pathname === "/test/profileModalState.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end("export const clearProfileModalContent = () => {};\n");
      return;
    }
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

test("Login- und Profilmodale trennen Login von Kontakt-E-Mail", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const playerPage = await browser.newPage();
    await playerPage.goto(`http://127.0.0.1:${address.port}/modals-test.html?role=player`, { waitUntil: "domcontentloaded" });

    const loginInput = playerPage.locator("#login");
    assert.equal(await loginInput.getAttribute("type"), "text");
    assert.equal(await loginInput.getAttribute("autocomplete"), "username");
    assert.equal(await loginInput.getAttribute("inputmode"), null);
    assert.equal(await playerPage.locator('label[for="login"]').textContent(), "Login:");
    assert.equal(await playerPage.locator("#setupLogin").getAttribute("type"), "text");
    assert.equal(await playerPage.locator("#setupLogin").getAttribute("inputmode"), null);

    await playerPage.evaluate(() => window.openProfileModal());
    await playerPage.locator("#profileModal").waitFor({ state: "visible" });
    assert.match(await playerPage.locator("#profileText").textContent(), /Login: player-login/);
    assert.match(await playerPage.locator("#profileText").textContent(), /E-Mail: contact@example\.test/);
    await playerPage.getByRole("button", { name: "Passwort ändern" }).click();
    assert.equal(await playerPage.locator("#changePasswordUsername").inputValue(), "player-login");

    await playerPage.evaluate(() => window.openProfileModal({ playerId: "p2" }));
    await playerPage.locator("#profileModal").waitFor({ state: "visible" });
    assert.doesNotMatch(await playerPage.locator("#profileText").textContent(), /Login:/);
    assert.match(await playerPage.locator("#profileText").textContent(), /E-Mail: directory@example\.test/);
    await playerPage.close();

    const adminPage = await browser.newPage();
    await adminPage.goto(`http://127.0.0.1:${address.port}/modals-test.html?role=admin`, { waitUntil: "domcontentloaded" });
    await adminPage.evaluate(() => window.openProfileModal({ playerId: "p2" }));
    await adminPage.locator("#profileModal").waitFor({ state: "visible" });
    assert.match(await adminPage.locator("#profileText").textContent(), /Login: foreign-login/);
    await adminPage.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
