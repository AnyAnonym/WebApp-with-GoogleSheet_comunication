const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { assertBearerToken, getRequestIp, normalizeIp } = require("../security.js");

test("Request-IP vertraut Forwarded-For nur hinter dem lokalen Proxy", () => {
  assert.equal(getRequestIp({
    headers: { "x-forwarded-for": "203.0.113.42, 127.0.0.1" },
    socket: { remoteAddress: "::ffff:127.0.0.1" },
  }), "203.0.113.42");
  assert.equal(getRequestIp({
    headers: { "x-forwarded-for": "203.0.113.42" },
    socket: { remoteAddress: "198.51.100.20" },
  }), "198.51.100.20");
  assert.equal(getRequestIp({
    headers: { "x-forwarded-for": "not-an-ip" },
    socket: { remoteAddress: "127.0.0.1" },
  }), "127.0.0.1");
  assert.equal(normalizeIp("fe80::1%eth0"), "fe80::1");
  assert.equal(normalizeIp("2001:0db8:0000:0000:0000:0000:0000:0001"), "2001:db8::1");
  assert.equal(normalizeIp("2001:db8::1"), "2001:db8::1");
  assert.equal(normalizeIp("198.51.100.20%anything"), "unknown");
});

test("Reporting-Bearer-Token wird strikt und zeitkonstant verglichen", () => {
  const token = "a".repeat(43);
  assert.doesNotThrow(() => assertBearerToken({ headersDistinct: { authorization: [`Bearer ${token}`] } }, token));
  for (const authorization of [[], [`bearer ${token}`], [`Bearer ${"b".repeat(43)}`], [`Bearer ${token}`, `Bearer ${token}`]]) {
    assert.throws(() => assertBearerToken({ headersDistinct: { authorization } }, token), { code: "REPORTING_AUTH_REQUIRED" });
  }
});
