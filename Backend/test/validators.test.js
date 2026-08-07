const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { canonicalizeMonitorPath, emailValue } = require("../validators.js");
const { columnName } = require("../tableUtils.js");

const dataStore = {
  get(name) {
    if (name !== "bewerbe") return [];
    return [["ID"], ["2"], ["cup-1"]];
  },
};

test("Monitorpfade werden kanonisiert", () => {
  assert.equal(canonicalizeMonitorPath("scoreboard.html", dataStore), "/scoreboard.html");
  assert.equal(canonicalizeMonitorPath("/rangliste.html?id=2", dataStore), "/rangliste.html?id=2");
  assert.equal(canonicalizeMonitorPath("/RoundRobin.html?paarungslayout=2&id=cup-1", dataStore), "/RoundRobin.html?id=cup-1&paarungslayout=2");
});

test("Fremde, traversierende und unbekannte Monitorpfade werden abgelehnt", () => {
  for (const value of [
    "https://evil.example/scoreboard.html",
    "//evil.example/scoreboard.html",
    "/../scoreboard.html",
    "/navigator.html",
    "/scoreboard.html?x=1",
    "/RoundRobin.html?id=missing",
  ]) {
    assert.throws(() => canonicalizeMonitorPath(value, dataStore));
  }
});

test("Spaltennamen funktionieren auch hinter Z", () => {
  assert.equal(columnName(0), "A");
  assert.equal(columnName(25), "Z");
  assert.equal(columnName(26), "AA");
  assert.equal(columnName(51), "AZ");
  assert.equal(columnName(52), "BA");
});

test("E-Mail-Validierung begrenzt persistierbare Werte und akzeptiert IDN-Domains", () => {
  assert.equal(emailValue(" User+Audit@Example.Test "), "user+audit@example.test");
  assert.equal(emailValue("Üser@München.example"), "üser@xn--mnchen-3ya.example");
  assert.equal(emailValue("Üser@xn--mnchen-3ya.example"), "üser@xn--mnchen-3ya.example");
  assert.throws(() => emailValue(`${"a".repeat(65)}@example.test`), { code: "VALIDATION_ERROR" });
  assert.throws(() => emailValue("<script>@example.test"), { code: "VALIDATION_ERROR" });
  assert.throws(() => emailValue("a..b@example.test"), { code: "VALIDATION_ERROR" });
  const expandingDomain = `${Array(6).fill("ü".repeat(30)).join(".")}.example`;
  assert.throws(() => emailValue(`${"a".repeat(40)}@${expandingDomain}`), { code: "VALIDATION_ERROR" });
});
