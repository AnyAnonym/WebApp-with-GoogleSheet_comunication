const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Walkovertext nennt Gewinner und vollstaendige Verliererseite einheitlich", async () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../Frontend/JS/matchCompletionText.js"), "utf8");
  const { formatWalkoverResult } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  assert.equal(formatWalkoverResult("Stefan Strauß", "Reinhard Haider"), "Stefan Strauß gewinnt durch W.O. von Reinhard Haider.");
  assert.equal(formatWalkoverResult("Anna Links / Berta Rechts", "Clara Oben / Dora Unten"), "Anna Links / Berta Rechts gewinnt durch W.O. von Clara Oben / Dora Unten.");
  assert.equal(formatWalkoverResult("", "Reinhard Haider"), "");
});
