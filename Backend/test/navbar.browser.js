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
const loginError = new URLSearchParams(window.location.search).get("loginError");
const user = role ? { id: role + "-1", role, login: role + "-login", email: role + "@example.test" } : null;
export const ready = Promise.resolve(user);
export const createPasswordReset = async () => ({ resetToken: "token" });
export const login = async () => {
  if (!loginError) return user;
  const error = new Error(loginError === "LOGIN_RATE_LIMIT" ? "Zu viele Anmeldeversuche" : "Login fehlgeschlagen");
  error.code = loginError;
  if (loginError === "LOGIN_RATE_LIMIT") error.details = { retryAfterMs: 610000 };
  throw error;
};
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
export const subscribeInvalidations = () => () => {};
const rankings = [
  { competitionId: "r1", competitionName: "Herren", rank: 1, status: "active", canChallenge: true, canWithdraw: true },
  { competitionId: "r2", competitionName: "Damen Doppel Lang", rank: 2, status: "active", canChallenge: false, canWithdraw: false, openChallenge: { opponentName: "Test Gegner", challengedAt: "260829-1200", matchDate: "260905-1600" } },
  { competitionId: "r3", competitionName: "Senioren 45 Plus", rank: 3, status: "active", canChallenge: false },
  { competitionId: "r4", competitionName: "Mixed Sommer", rank: 4, status: "active", canChallenge: false },
  { competitionId: "r5", competitionName: "Wintercup", rank: 0, status: "withdrawn", canChallenge: false, withdrawal: { withdrawnAt: "260829-1230", reason: "Verletzt" } },
];
export function createEndpoint(name) {
  return async () => {
    const role = new URLSearchParams(window.location.search).get("role");
    const withdrawn = new URLSearchParams(window.location.search).get("withdrawn") === "1";
    const newcomer = new URLSearchParams(window.location.search).get("newcomer") === "1";
    const ineligible = new URLSearchParams(window.location.search).get("ineligible") === "1";
    const inactivePlayer = new URLSearchParams(window.location.search).get("inactivePlayer") === "1";
    const blockedTarget = new URLSearchParams(window.location.search).get("blockedTarget") === "1";
    if (name === "rlPlatzierung") return { data: { success: true, values: [
      ["BewerbID", "PersonID", "Rang"],
      ...Array.from({ length: 28 }, (_, index) => ["2", withdrawn || newcomer || ineligible ? "p" + (index + 1) : (index === 0 ? "player-1" : "p" + (index + 1)), String(index + 1)]),
      ...(withdrawn ? [["2", "player-1", "0"]] : []),
    ] } };
    if (name === "players") return { data: { success: true, values: [
      ["ID", "Vorname", "Nachname", "Aktiv"],
      ...Array.from({ length: 28 }, (_, index) => [withdrawn || newcomer || ineligible ? "p" + (index + 1) : (index === 0 ? "player-1" : "p" + (index + 1)), "Spieler" + (index + 1), "Mobil" + (index + 1), inactivePlayer && index === 27 ? "0" : "1"]),
    ] } };
    if (name === "preMatches") return { data: { success: true, values: [[
      "BewerbID", "Ergebnis", "Spieler1ID", "Spieler2ID", "Spieler3ID", "Spieler4ID",
    ]] } };
    if (name === "readMatchRestrictions") return { data: {
      success: true, complete: true, schonzeit: [],
      sperrzeit: blockedTarget ? [{ id: "p1", until: "2099-01-01T00:00:00.000Z" }] : [],
    } };
    if (name === "bewerbe") return { data: { success: true, values: [["ID", "Bezeichnung"], ["2", "Mobile Rangliste"]] } };
    if (name === "rankingChallengeState") return { data: { success: true,
      mode: ineligible ? "ineligible" : (newcomer ? "newcomer" : (withdrawn ? "returning" : "ranked")),
      rank: newcomer || withdrawn || ineligible ? null : 1,
      returnFromRank: withdrawn ? 4 : null,
    } };
    if (name === "withdrawnRankingPlayers") return { data: { success: true, competitionName: "Wintercup", players: [
      {
        personId: "p1", name: "Own Player", withdrawnAt: "260829-1230", previousRank: 4, reason: "Verletzt",
        returnChallenge: { challengedAt: "260830-1400", opponentName: "Test Gegner", opponentRank: 6 },
      },
      { personId: "p2", name: "Other Player", withdrawnAt: "260828-1100", previousRank: 7, reason: "Pause", returnChallenge: null },
    ] } };
    if (name === "myProfile") return { data: { success: true, profile: {
       id: role + "-1", firstName: "Own", lastName: "Player", login: role + "-login",
       email: "contact@example.test", phone: "", birthDate: "", rankings: withdrawn ? [{
         competitionId: "2", competitionName: "Mobile Rangliste", rank: 0, status: "withdrawn",
         withdrawal: { withdrawnAt: "260829-1200", previousRank: 4, reason: "Pause" },
       }] : rankings,
     } } };
    if (name === "publicProfile") return { data: { success: true, profile: {
      id: "p2", firstName: "Foreign", lastName: "Player",
       ...(role === "admin" ? { login: "foreign-login", passwordSetupAllowed: false } : {}),
       email: "directory@example.test", phone: "", birthDate: "", rankings: newcomer ? [{
         competitionId: "2", competitionName: "Mobile Rangliste", rank: 2, status: "active", canChallenge: true,
       }] : rankings,
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
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/CSS/styles.css"></head><body><script type="module" src="/JS/modals-under-test.js"></script></body></html>');
      return;
    }
    if (pathname === "/ranking-test.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/CSS/styles.css"></head><body><main><section id="rankingSection" class="full-width-section"><h2>Rangliste</h2><div id="rankingContainer" class="pyramid"></div></section></main><script type="module" src="/JS/modals-under-test.js"></script><script type="module" src="/JS/rangliste-under-test.js"></script></body></html>');
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
    if (pathname === "/JS/rangliste-under-test.js") {
      const source = fs.readFileSync(path.join(FRONTEND_ROOT, "JS/rangliste.js"), "utf8")
        .replace('"./dataClient.js"', '"/test/dataClient.js"')
        .replace('"./authClient.js"', '"/test/authClient.js"')
        .replace('"./monitorReady.js"', '"/test/monitorReady.js"')
        .replace('"./diagnostics.js"', '"/test/diagnostics.js"')
        .replace('"./rankingMatchState.js"', '"/JS/rankingMatchState.js"');
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
      response.end("export const diagnostic = { info() {}, warn() {}, error() {} };\n");
      return;
    }
    if (pathname === "/test/monitorReady.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end("export const signalMonitorReady = () => {}; export const signalMonitorFailed = () => {};\n");
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
        const serviceLink = page.locator('.mobile-nav-links a[href="servicebereich.html"]');
        assert.equal(await players.isVisible(), expected.playersVisible, `${expected.role || "anonymous"}: Spielerlink`);
        assert.equal(await serviceLink.isVisible(), expected.adminVisible, `${expected.role || "anonymous"}: Servicebereich`);
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

test("Loginfehler bleiben im mobilen Dialog sichtbar und nennen die Sperrdauer", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const cases = [
      { code: "LOGIN_FAILED", message: "Login oder Passwort ist ungültig." },
      { code: "LOGIN_RATE_LIMIT", message: "Zu viele Anmeldeversuche. Bitte in 11 Minuten erneut versuchen." },
    ];
    for (const expected of cases) {
      const context = await browser.newContext({ viewport: { width: 390, height: 600 } });
      const page = await context.newPage();
      try {
        await page.goto(`http://127.0.0.1:${address.port}/modals-test.html?loginError=${expected.code}`, { waitUntil: "domcontentloaded" });
        await page.evaluate(() => window.openLoginModal());
        await page.locator("#login").fill("mobile.login");
        await page.locator("#password").fill("wrong-password");
        await page.getByRole("button", { name: "Anmelden", exact: true }).click();

        const status = page.locator("#loginStatus");
        await status.waitFor({ state: "visible" });
        assert.equal(await status.textContent(), expected.message);
        assert.equal(await page.locator("#toastContainer .toast").count(), 0);
        const layout = await status.evaluate((element) => {
          const statusRect = element.getBoundingClientRect();
          const dialogRect = element.closest(".modal-content").getBoundingClientRect();
          return {
            statusTop: statusRect.top,
            statusBottom: statusRect.bottom,
            dialogTop: dialogRect.top,
            dialogBottom: dialogRect.bottom,
          };
        });
        assert.equal(layout.statusTop >= layout.dialogTop, true);
        assert.equal(layout.statusBottom <= layout.dialogBottom, true);

        if (expected.code === "LOGIN_FAILED") {
          await page.waitForTimeout(3200);
          assert.equal(await status.isVisible(), true);
          assert.equal(await status.textContent(), expected.message);
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
    const playerPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
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
    assert.deepEqual(await playerPage.locator("#profileTabs [role=tab]").allTextContents(), [
      "System", "Herren", "Damen Doppel Lang", "Senioren 45 Plus", "Mixed Sommer", "Wintercup",
    ]);
    assert.deepEqual(await playerPage.locator("#profileTabs [role=tab]").evaluateAll((tabs) => tabs.map((tab) => tab.tabIndex)), [0, 0, 0, 0, 0, 0]);
    await playerPage.getByRole("tab", { name: "Herren", exact: true }).click();
    assert.match(await playerPage.locator("#profileRankingPanel0").textContent(), /Ranglistenposition:\s*1/);
    const withdrawButton = playerPage.getByRole("button", { name: "Raushängen" });
    assert.equal(await withdrawButton.isDisabled(), false);
    await withdrawButton.click();
    assert.doesNotMatch(await playerPage.locator("#withdrawModal").textContent(), /Position wird freigegeben|Schonzeit|Sperrzeit/);
    assert.equal(await playerPage.getByRole("button", { name: "Verbindlich raushängen" }).isVisible(), true);
    await playerPage.locator("#withdrawModal .close").click();
    await playerPage.getByRole("tab", { name: "Wintercup" }).click();
    assert.doesNotMatch(await playerPage.locator("#profileRankingPanel4").textContent(), /Ranglistenposition:\s*0/);
    assert.match(await playerPage.locator("#profileRankingPanel4").textContent(), /Rausgehängt am:\s*29\.08\.2026, 12:30 Uhr/);
    assert.match(await playerPage.locator("#profileRankingPanel4").textContent(), /Grund:\s*Verletzt/);
    const ownTabMetrics = await playerPage.locator("#profileTabs").evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    assert.equal(ownTabMetrics.scrollWidth > ownTabMetrics.clientWidth, true);
    await playerPage.getByRole("tab", { name: "System" }).click();
    await playerPage.getByRole("button", { name: "Passwort ändern" }).click();
    assert.equal(await playerPage.locator("#changePasswordUsername").inputValue(), "player-login");

    await playerPage.evaluate(() => window.openProfileModal({ playerId: "p2" }));
    await playerPage.locator("#profileModal").waitFor({ state: "visible" });
    assert.doesNotMatch(await playerPage.locator("#profileText").textContent(), /Login:/);
    assert.match(await playerPage.locator("#profileText").textContent(), /E-Mail: directory@example\.test/);
    await playerPage.getByRole("tab", { name: "Herren", exact: true }).click();
    assert.match(await playerPage.locator("#profileRankingPanel0").textContent(), /Ranglistenposition:\s*1/);
    assert.equal(await playerPage.getByRole("button", { name: "Fordern" }).isVisible(), true);
    await playerPage.getByRole("tab", { name: "Damen Doppel Lang", exact: true }).click();
    assert.match(
      await playerPage.locator("#profileRankingPanel1").textContent(),
      /Offene Forderung:\s*Test Gegner · Forderung vom 29\.08\.2026, 12:00 Uhr · fixierter Spieltermin am 05\.09\.2026, 16:00 Uhr/,
    );
    assert.doesNotMatch(await playerPage.locator("#profileRankingPanel1").textContent(), /Keine Aktion verfügbar/i);
    await playerPage.keyboard.press("Escape");
    assert.equal(await playerPage.locator("#profileModal").isHidden(), true);
    await playerPage.evaluate(() => window.openWithdrawnRankingPlayers("r5"));
    await playerPage.locator("#withdrawnPlayersModal").waitFor({ state: "visible" });
    assert.equal(await playerPage.locator("#withdrawnPlayersTitle").innerText(), "Rausgehängt aus\nWintercup");
    const withdrawnEntries = playerPage.locator("#withdrawnPlayersBody .withdrawn-player");
    assert.equal(await withdrawnEntries.count(), 2);
    assert.deepEqual(await withdrawnEntries.nth(0).locator(":scope > *").allTextContents(), [
      "Own Player",
      "Datum: 29.08.2026, 12:30 Uhr",
      "Position: 4",
      "Grund: Verletzt",
      "Eingefordert am 30.08.2026, 14:00 Uhr gegen Test Gegner (Position 6)",
    ]);
    assert.deepEqual(await withdrawnEntries.nth(1).locator(":scope > *").allTextContents(), [
      "Other Player",
      "Datum: 28.08.2026, 11:00 Uhr",
      "Position: 7",
      "Grund: Pause",
    ]);
    assert.deepEqual(await withdrawnEntries.nth(0).locator(":scope > span, :scope > p").evaluateAll((lines) => (
      lines.map((line) => {
        const style = getComputedStyle(line);
        return { color: style.color, fontSize: style.fontSize };
      })
    )), Array.from({ length: 4 }, () => ({ color: "rgb(85, 85, 85)", fontSize: "14.4px" })));
    await playerPage.keyboard.press("Escape");
    await playerPage.close();

    const adminPage = await browser.newPage({ viewport: { width: 320, height: 240 } });
    await adminPage.goto(`http://127.0.0.1:${address.port}/modals-test.html?role=admin`, { waitUntil: "domcontentloaded" });
    await adminPage.evaluate(() => window.openProfileModal({ playerId: "p2" }));
    await adminPage.locator("#profileModal").waitFor({ state: "visible" });
    assert.match(await adminPage.locator("#profileText").textContent(), /Login: foreign-login/);
    assert.equal(await adminPage.getByRole("tab", { name: "Admin" }).isVisible(), true);
    await adminPage.getByRole("tab", { name: "Admin" }).click();
    assert.equal(await adminPage.getByRole("button", { name: "Reset-Code erstellen" }).isVisible(), true);
    const layout = await adminPage.locator("#profileModal .profile-dialog").evaluate((dialog) => {
      const rect = dialog.getBoundingClientRect();
      const body = dialog.querySelector(".profile-body");
      return {
        top: rect.top,
        bottom: window.innerHeight - rect.bottom,
        bodyScrollable: body.scrollHeight > body.clientHeight,
        pageLocked: getComputedStyle(document.body).overflow === "hidden",
      };
    });
    assert.equal(layout.top >= 19, true);
    assert.equal(layout.bottom >= 19, true);
    assert.equal(layout.bodyScrollable, true);
    assert.equal(layout.pageLocked, true);
    await adminPage.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Mobiles Ranglistenprofil bleibt nach horizontalem Scrollen im sichtbaren Viewport", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${address.port}/ranking-test.html?role=player&id=2`, { waitUntil: "domcontentloaded" });
    await page.locator("#rankingContainer .box").nth(27).waitFor({ state: "visible" });

    const ranking = await page.locator("#rankingContainer").evaluate((scrollport) => {
      scrollport.scrollLeft = scrollport.scrollWidth - scrollport.clientWidth;
      return {
        clientWidth: scrollport.clientWidth,
        scrollWidth: scrollport.scrollWidth,
        scrollLeft: scrollport.scrollLeft,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        pageScrollX: window.scrollX,
      };
    });
    assert.equal(ranking.scrollWidth > ranking.clientWidth, true);
    assert.equal(ranking.scrollLeft > 0, true);
    assert.equal(ranking.documentWidth, ranking.viewportWidth);
    assert.equal(ranking.pageScrollX, 0);

    await page.locator("#rankingContainer .box").nth(27).click();
    await page.locator("#profileModal").waitFor({ state: "visible" });
    const overlay = await page.locator("#profileModal").evaluate((modal) => {
      const modalRect = modal.getBoundingClientRect();
      const dialogRect = modal.querySelector(".profile-dialog").getBoundingClientRect();
      const viewportLeft = window.visualViewport?.offsetLeft || 0;
      const viewportWidth = window.visualViewport?.width || window.innerWidth;
      document.scrollingElement.scrollLeft = 100;
      return {
        modalLeft: modalRect.left,
        modalRight: modalRect.right,
        dialogLeft: dialogRect.left,
        dialogRight: dialogRect.right,
        dialogCenter: dialogRect.left + (dialogRect.width / 2),
        viewportLeft,
        viewportRight: viewportLeft + viewportWidth,
        viewportCenter: viewportLeft + (viewportWidth / 2),
        pageScrollX: window.scrollX,
        rankingScrollLeft: document.getElementById("rankingContainer").scrollLeft,
        pageLocked: getComputedStyle(document.body).overflow === "hidden",
      };
    });
    assert.equal(overlay.modalLeft, overlay.viewportLeft);
    assert.equal(overlay.modalRight, overlay.viewportRight);
    assert.equal(overlay.dialogLeft >= overlay.viewportLeft + 11, true);
    assert.equal(overlay.dialogRight <= overlay.viewportRight - 11, true);
    assert.equal(Math.abs(overlay.dialogCenter - overlay.viewportCenter) <= 1, true);
    assert.equal(overlay.pageScrollX, 0);
    assert.equal(overlay.rankingScrollLeft, ranking.scrollLeft);
    assert.equal(overlay.pageLocked, true);

    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#rankingContainer").evaluate((scrollport) => scrollport.scrollLeft), ranking.scrollLeft);
    await page.close();

    const returnPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await returnPage.goto(`http://127.0.0.1:${address.port}/ranking-test.html?role=player&id=2&withdrawn=1`, { waitUntil: "domcontentloaded" });
    await returnPage.locator("#rankingContainer .box.challengeable").first().waitFor({ state: "visible" });
    const returnTargets = await returnPage.locator("#rankingContainer .box").evaluateAll((boxes) => boxes.map((box) => ({
      rank: Number(box.querySelector(".box-rank-bg")?.textContent),
      challengeable: box.classList.contains("challengeable"),
    })).filter(({ rank }) => Number.isInteger(rank)));
    assert.equal(returnTargets.filter(({ challengeable }) => challengeable).length, 25);
    assert.equal(returnTargets.every(({ rank, challengeable }) => challengeable === (rank >= 4)), true);
    await returnPage.close();

    const newcomerPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await newcomerPage.goto(`http://127.0.0.1:${address.port}/ranking-test.html?role=player&id=2&newcomer=1&blockedTarget=1`, { waitUntil: "domcontentloaded" });
    await newcomerPage.locator("#rankingContainer .box.challengeable").first().waitFor({ state: "visible" });
    const legendSections = await newcomerPage.locator("#rankingLegend").evaluate((legend) => {
      const headings = [...legend.querySelectorAll(".legend-subheading")];
      return Object.fromEntries(headings.map((heading) => [
        heading.textContent,
        heading.nextElementSibling?.textContent || "",
      ]));
    });
    assert.doesNotMatch(legendSections.Kästchen, /Forderbar/);
    assert.match(legendSections.Rahmen, /Forderbar/);
    assert.equal(await newcomerPage.locator("#rankingContainer .box.challengeable").count(), 28);
    const blockedTarget = newcomerPage.locator("#rankingContainer .box.challengeable.sperrzeit");
    assert.equal(await blockedTarget.count(), 1);
    assert.deepEqual(await blockedTarget.evaluate((box) => {
      const style = getComputedStyle(box);
      return { backgroundColor: style.backgroundColor, borderColor: style.borderColor, cursor: style.cursor };
    }), {
      backgroundColor: "rgb(220, 199, 232)",
      borderColor: "rgb(25, 135, 84)",
      cursor: "grab",
    });
    await blockedTarget.click();
    await newcomerPage.getByRole("tab", { name: "Mobile Rangliste" }).click();
    await newcomerPage.getByRole("button", { name: "Fordern" }).waitFor({ state: "visible" });
    await newcomerPage.close();

    const inactivePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await inactivePage.goto(`http://127.0.0.1:${address.port}/ranking-test.html?role=player&id=2&newcomer=1&inactivePlayer=1`, { waitUntil: "domcontentloaded" });
    await inactivePage.locator("#rankingContainer .box.challengeable").first().waitFor({ state: "visible" });
    assert.equal(await inactivePage.locator("#rankingContainer .box.challengeable").count(), 27);
    await inactivePage.close();

    const ineligiblePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await ineligiblePage.goto(`http://127.0.0.1:${address.port}/ranking-test.html?role=player&id=2&ineligible=1`, { waitUntil: "domcontentloaded" });
    await ineligiblePage.locator("#rankingContainer .box").first().waitFor({ state: "visible" });
    assert.equal(await ineligiblePage.locator("#rankingContainer .box.challengeable").count(), 0);
    await ineligiblePage.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
