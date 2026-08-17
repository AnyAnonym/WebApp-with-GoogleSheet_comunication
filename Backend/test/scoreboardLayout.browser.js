const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium } = require("playwright-core");

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const SCOREBOARD_URL = process.env.SCOREBOARD_TEST_URL || "https://epiber.at:8081/scoreboard.html";
const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 1000, height: 768 },
  { width: 1001, height: 768 },
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
];

test("Scoreboard-Namen bleiben an mobilen und Desktop-Breakpoints lesbar und im Layout", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 60000,
}, async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const results = [];
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      try {
        await page.goto(SCOREBOARD_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.locator("#scoreboard-content.loaded").waitFor({ state: "visible", timeout: 15000 });
        await page.evaluate(() => document.fonts?.ready);
        await page.waitForTimeout(100);

        const metrics = await page.evaluate(() => {
          const names = ["p1-name-h", "p1-name-g", "p2-name-h", "p2-name-g"]
            .map((id) => document.getElementById(id));
          const widthsFit = names.every((element) => {
            if (!element) return false;
            const style = getComputedStyle(element);
            const availableWidth = element.clientWidth
              - parseFloat(style.paddingLeft)
              - parseFloat(style.paddingRight)
              - 4;
            const lines = element.classList.contains("platz-cell-double") ? [...element.children] : [element];
            return lines.every((line) => {
              const range = document.createRange();
              range.selectNodeContents(line);
              return range.getBoundingClientRect().width <= availableWidth + 1;
            });
          });
          const fontSizes = names.map((element) => parseFloat(getComputedStyle(element).fontSize));
          const courtOverflows = ["platz1", "platz2"].map((id) => {
            const court = document.getElementById(id);
            return Math.max(0, court.scrollHeight - court.clientHeight);
          });
          return {
            fontSizes,
            minFontSize: Math.min(...fontSizes),
            widthsFit,
            maxCourtOverflow: Math.max(...courtOverflows),
          };
        });

        const minimumReadableSize = viewport.width > 1000 ? 24 : 20;
        assert.equal(metrics.widthsFit, true, `${viewport.width}x${viewport.height}: Name ist horizontal abgeschnitten`);
        assert.equal(
          metrics.minFontSize >= minimumReadableSize,
          true,
          `${viewport.width}x${viewport.height}: kleinste Namensschrift ${metrics.minFontSize}px`,
        );
        assert.equal(
          metrics.maxCourtOverflow <= 2,
          true,
          `${viewport.width}x${viewport.height}: Court-Ueberlauf ${metrics.maxCourtOverflow}px`,
        );

        await page.evaluate(() => {
          for (const id of ["p1-name-h", "p1-name-g", "p2-name-h", "p2-name-g"]) {
            const element = document.getElementById(id);
            element.replaceChildren();
            element.classList.remove("platz-cell-double");
          }
          window.dispatchEvent(new Event("resize"));
        });
        await page.waitForTimeout(100);
        const emptyMetrics = await page.evaluate(() => {
          const heightPairs = ["1", "2"].flatMap((court) => {
            const scoreHeight = Math.max(...[...document.querySelectorAll(`#platz${court} .platz-row .platz-scores .platz-cell`)]
              .map((element) => element.offsetHeight));
            return ["h", "g"].map((side) => ({
              nameHeight: document.getElementById(`p${court}-name-${side}`).offsetHeight,
              scoreHeight,
            }));
          });
          const courtOverflows = ["platz1", "platz2"].map((id) => {
            const court = document.getElementById(id);
            return Math.max(0, court.scrollHeight - court.clientHeight);
          });
          return { heightPairs, maxCourtOverflow: Math.max(...courtOverflows) };
        });
        assert.equal(
          emptyMetrics.heightPairs.every(({ nameHeight, scoreHeight }) => nameHeight >= scoreHeight),
          true,
          `${viewport.width}x${viewport.height}: Leeres Namensfeld ist niedriger als die Scorezellen`,
        );
        assert.equal(
          emptyMetrics.maxCourtOverflow <= 2,
          true,
          `${viewport.width}x${viewport.height}: Leerer Court-Ueberlauf ${emptyMetrics.maxCourtOverflow}px`,
        );
        results.push({ ...viewport, ...metrics });
      } catch (error) {
        await page.screenshot({
          path: `/tmp/opencode/scoreboard-layout-${viewport.width}x${viewport.height}.png`,
          fullPage: true,
        }).catch(() => {});
        throw error;
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const mobileEdge = results.find(({ width }) => width === 1000);
  const desktopEdge = results.find(({ width }) => width === 1001);
  assert.equal(
    desktopEdge.minFontSize >= mobileEdge.minFontSize - 1,
    true,
    `Breakpoint verkleinert Namen von ${mobileEdge.minFontSize}px auf ${desktopEdge.minFontSize}px`,
  );
});
