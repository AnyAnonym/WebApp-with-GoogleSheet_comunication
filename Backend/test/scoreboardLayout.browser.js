const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium } = require("playwright-core");

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const SCOREBOARD_URL = process.env.SCOREBOARD_TEST_URL || "https://epiber.at:8081/scoreboard.html";
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 664 },
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
        await page.evaluate(() => {
          for (const id of ["p1-name-h", "p1-name-g", "p2-name-h", "p2-name-g"]) {
            const element = document.getElementById(id);
            element.classList.remove("platz-cell-double");
            element.textContent = "Maximilian Mustermann";
          }
          document.getElementById("platz1").classList.remove("court-has-double");
          document.getElementById("platz2").classList.remove("court-has-double");
          window.dispatchEvent(new Event("resize"));
        });
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
          const contentInsideCourts = ["1", "2"].every((courtKey) => {
            const court = document.getElementById(`platz${courtKey}`);
            const courtRect = court.getBoundingClientRect();
            const content = [
              document.getElementById(`p${courtKey}-name-h`),
              document.getElementById(`p${courtKey}-name-g`),
              ...court.querySelectorAll(".platz-row .platz-scores"),
            ];
            return content.every((element) => {
              const rect = element.getBoundingClientRect();
              return rect.top >= courtRect.top - 1 && rect.bottom <= courtRect.bottom + 1;
            });
          });
          const maxHeaderTopGap = Math.max(...["1", "2"].map((courtKey) => {
            const courtRect = document.getElementById(`platz${courtKey}`).getBoundingClientRect();
            const headerRect = document.querySelector(`#platz${courtKey} > .platz-header`).getBoundingClientRect();
            return headerRect.top - courtRect.top;
          }));
          const maxScoreFontSize = Math.max(...[...document.querySelectorAll(".platz-row .platz-scores .platz-cell")]
            .map((element) => parseFloat(getComputedStyle(element).fontSize)));
          const maxRowGap = Math.max(...[...document.querySelectorAll(".platz-row")]
            .map((element) => parseFloat(getComputedStyle(element).rowGap)));
          const maxScoreBottomMargin = Math.max(...[...document.querySelectorAll(".platz-row .platz-scores")]
            .map((element) => parseFloat(getComputedStyle(element).marginBottom)));
          return {
            fontSizes,
            minFontSize: Math.min(...fontSizes),
            widthsFit,
            maxCourtOverflow: Math.max(...courtOverflows),
            contentInsideCourts,
            maxHeaderTopGap,
            maxScoreFontSize,
            maxRowGap,
            maxScoreBottomMargin,
          };
        });

        const shortPortrait = viewport.width <= 390 && viewport.height <= 667;
        const minimumReadableSize = viewport.width === 320 && viewport.height === 568
          ? 1
          : viewport.width > 1000 ? 24 : 20;
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
        assert.equal(
          metrics.contentInsideCourts,
          true,
          `${viewport.width}x${viewport.height}: Name oder Score liegt ausserhalb des Courts`,
        );
        if (shortPortrait) {
          assert.equal(
            metrics.maxHeaderTopGap <= 6,
            true,
            `${viewport.width}x${viewport.height}: Platzlabel hat ${metrics.maxHeaderTopGap}px Abstand zum oberen Rand`,
          );
          assert.equal(metrics.maxScoreFontSize >= 35 && metrics.maxScoreFontSize <= 36, true, `${viewport.width}x${viewport.height}: Einzel-Scoreziffern sind ${metrics.maxScoreFontSize}px gross`);
          assert.equal(metrics.maxRowGap <= 3, true, `${viewport.width}x${viewport.height}: Abstand Name zu Score ist ${metrics.maxRowGap}px`);
          assert.equal(metrics.maxScoreBottomMargin <= 3, true, `${viewport.width}x${viewport.height}: Abstand unter Score ist ${metrics.maxScoreBottomMargin}px`);
        }

        if (shortPortrait) {
          await page.evaluate(() => {
            const names = ["Maximilian Mustermann", "Alexander Beispiel"];
            for (const id of ["p1-name-h", "p1-name-g", "p2-name-h", "p2-name-g"]) {
              const element = document.getElementById(id);
              element.classList.add("platz-cell-double");
              element.replaceChildren(...names.map((name) => {
                const line = document.createElement("div");
                line.textContent = name;
                return line;
              }));
            }
            document.getElementById("platz1").classList.add("court-has-double");
            document.getElementById("platz2").classList.add("court-has-double");
            window.dispatchEvent(new Event("resize"));
          });
          await page.waitForTimeout(100);
          const doubleMetrics = await page.evaluate(() => {
            const courtsFit = ["1", "2"].every((courtKey) => {
              const court = document.getElementById(`platz${courtKey}`);
              const courtRect = court.getBoundingClientRect();
              const names = [document.getElementById(`p${courtKey}-name-h`), document.getElementById(`p${courtKey}-name-g`)];
              const content = [...names, ...court.querySelectorAll(".platz-row .platz-scores")];
              return court.scrollHeight - court.clientHeight <= 2
                && content.every((element) => {
                  const rect = element.getBoundingClientRect();
                  return rect.top >= courtRect.top - 1 && rect.bottom <= courtRect.bottom + 1;
                })
                && names.every((element) => {
                  const labelRect = element.getBoundingClientRect();
                  return [...element.children].every((line) => {
                    const rect = line.getBoundingClientRect();
                    return rect.top >= labelRect.top - 1 && rect.bottom <= labelRect.bottom + 1;
                  });
                });
            });
            const minFontSize = Math.min(...["p1-name-h", "p1-name-g", "p2-name-h", "p2-name-g"]
              .map((id) => parseFloat(getComputedStyle(document.getElementById(id)).fontSize)));
            const maxScoreFontSize = Math.max(...[...document.querySelectorAll(".platz-row .platz-scores .platz-cell")]
              .map((element) => parseFloat(getComputedStyle(element).fontSize)));
            return { courtsFit, minFontSize, maxScoreFontSize };
          });
          assert.equal(doubleMetrics.courtsFit, true, `${viewport.width}x${viewport.height}: Doppelname wird vertikal abgeschnitten`);
          assert.equal(doubleMetrics.minFontSize > 1, true, `${viewport.width}x${viewport.height}: Doppelname wurde unnoetig auf das technische Minimum reduziert`);
          assert.equal(doubleMetrics.maxScoreFontSize <= 29, true, `${viewport.width}x${viewport.height}: Doppel-Scoreziffern sind ${doubleMetrics.maxScoreFontSize}px gross`);
        }

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
        const emptyHeightsValid = shortPortrait
          ? emptyMetrics.heightPairs.every(({ nameHeight }) => nameHeight > 0)
          : emptyMetrics.heightPairs.every(({ nameHeight, scoreHeight }) => nameHeight >= scoreHeight);
        assert.equal(
          emptyHeightsValid,
          true,
          `${viewport.width}x${viewport.height}: Leeres Namensfeld hat eine ungueltige Hoehe`,
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

test("Scoreboard skaliert Namen nach einer echten Viewport-Aenderung neu", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const measure = () => page.evaluate(() => {
    const names = ["p1-name-h", "p1-name-g", "p2-name-h", "p2-name-g"].map((id) => document.getElementById(id));
    const courts = ["platz1", "platz2"].map((id) => document.getElementById(id));
    return {
      minFontSize: Math.min(...names.map((element) => parseFloat(getComputedStyle(element).fontSize))),
      maxOverflow: Math.max(...courts.map((court) => court.scrollHeight - court.clientHeight)),
      contentInside: courts.every((court) => {
        const courtRect = court.getBoundingClientRect();
        return [...court.querySelectorAll(".platz-cell.label, .platz-row .platz-scores")].every((element) => {
          const rect = element.getBoundingClientRect();
          return rect.top >= courtRect.top - 1 && rect.bottom <= courtRect.bottom + 1;
        });
      }),
    };
  });
  try {
    await page.goto(SCOREBOARD_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.locator("#scoreboard-content.loaded").waitFor({ state: "visible", timeout: 15000 });
    await page.evaluate(() => {
      for (const id of ["p1-name-h", "p1-name-g", "p2-name-h", "p2-name-g"]) {
        const element = document.getElementById(id);
        element.classList.remove("platz-cell-double");
        element.textContent = "Maximilian Mustermann";
      }
      document.getElementById("platz1").classList.remove("court-has-double");
      document.getElementById("platz2").classList.remove("court-has-double");
      window.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(100);
    const initial = await measure();

    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForTimeout(100);
    const compact = await measure();
    assert.equal(compact.maxOverflow <= 2, true, `320x568 nach Resize: Court-Ueberlauf ${compact.maxOverflow}px`);
    assert.equal(compact.contentInside, true, "320x568 nach Resize: Inhalt liegt ausserhalb des Courts");
    assert.equal(compact.minFontSize < initial.minFontSize, true, "Kurzer Viewport hat die Namen nicht verkleinert");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    const restored = await measure();
    assert.equal(restored.maxOverflow <= 2, true, `390x844 nach Resize: Court-Ueberlauf ${restored.maxOverflow}px`);
    assert.equal(restored.contentInside, true, "390x844 nach Resize: Inhalt liegt ausserhalb des Courts");
    assert.equal(restored.minFontSize >= initial.minFontSize - 1, true, "Groesserer Viewport hat die Namensgroesse nicht wiederhergestellt");
  } finally {
    await context.close();
    await browser.close();
  }
});
