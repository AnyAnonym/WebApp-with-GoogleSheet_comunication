const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { createLogger } = require("../logger.js");

test("Logger schreibt strukturierte Pflichtfelder und filtert Level", () => {
  const lines = [];
  const logger = createLogger({
    level: "info",
    service: "test-service",
    instance: "paj",
    appVersion: "1.2.3",
    now: () => new Date("2026-08-06T12:00:00.000Z"),
    write: (_level, line) => lines.push(line),
  });
  assert.equal(logger.log("debug", "hidden_event"), false);
  assert.equal(logger.log("info", "visible_event", { level: "forged", version: "forged", count: 2 }), true);
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.deepEqual(event, {
    timestamp: "2026-08-06T12:00:00.000Z",
    level: "info",
    service: "test-service",
    instance: "paj",
    version: "1.2.3",
    event: "visible_event",
    count: 2,
  });
});

test("Logger redigiert Geheimnisse rekursiv und serialisiert Fehler begrenzt", () => {
  const lines = [];
  const logger = createLogger({ level: "debug", write: (_level, line) => lines.push(line) });
  const fields = {
    passwordHash: "secret-hash",
    nested: { monitor_token: "token-value", email: "person@example.test" },
    array: [{ Authorization: "Bearer abc" }],
    error: Object.assign(new Error("Kontakt person@example.test"), { code: "FAILED", details: { token: "hidden" } }),
  };
  logger.log("error", "redaction_test", fields);
  const event = JSON.parse(lines[0]);
  assert.equal(event.passwordHash, "[REDACTED]");
  assert.equal(event.nested.monitor_token, "[REDACTED]");
  assert.equal(event.nested.email, "[REDACTED]");
  assert.equal(event.array[0].Authorization, "[REDACTED]");
  assert.equal(event.error.code, "FAILED");
  assert.match(event.error.message, /\[REDACTED\]/);
  assert.equal(event.error.details, undefined);
  assert.equal(fields.passwordHash, "secret-hash");
});

test("Logger behandelt Zyklen und BigInt ohne die Anwendung zu werfen", () => {
  const lines = [];
  const logger = createLogger({ write: (_level, line) => lines.push(line) });
  const value = { count: 5n };
  value.self = value;
  assert.doesNotThrow(() => logger.log("info", "cycle_test", value));
  const event = JSON.parse(lines[0]);
  assert.equal(event.count, "5");
  assert.equal(event.self, "[CIRCULAR]");
});

test("Logger redigiert Schluesselvarianten, Zuweisungen und geheime URL-Parameter", () => {
  const lines = [];
  const logger = createLogger({ level: "debug", write: (_level, line) => lines.push(line) });
  logger.log("error", "extended_redaction_test", {
    accessToken: "secret-access",
    nestedApiKey: "secret-key",
    message: "password=hunter2 token:abc cookie=sessionid client_secret=client-value refresh_token=refresh-value session_id=session-value",
    url: "https://example.test/path?token=raw-secret&reset_token=reset-value&safe=1",
    error: new Error("api_key=secret-value Bearer abc+/def=="),
  });
  const serialized = lines[0];
  assert.equal(serialized.includes("secret-access"), false);
  assert.equal(serialized.includes("secret-key"), false);
  assert.equal(serialized.includes("hunter2"), false);
  assert.equal(serialized.includes("raw-secret"), false);
  assert.equal(serialized.includes("secret-value"), false);
  assert.equal(serialized.includes("client-value"), false);
  assert.equal(serialized.includes("refresh-value"), false);
  assert.equal(serialized.includes("session-value"), false);
  assert.equal(serialized.includes("reset-value"), false);
  assert.equal(serialized.includes("abc+/def=="), false);
});

test("Logger macht synchrone Schreibfehler als Rueckgabewert sichtbar", () => {
  const logger = createLogger({ write: () => { throw new Error("stream failed"); } });
  assert.equal(logger.log("info", "write_failure_test"), false);
});
