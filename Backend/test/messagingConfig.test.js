const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BACKEND_ROOT = path.resolve(__dirname, "..");
const SYSTEMD_ROOT = path.resolve(BACKEND_ROOT, "../Project/server-configs/systemd");

test("Messaging-SQLite verwendet ohne eigenen Pfad den Namen messaging.sqlite neben STATE_FILE", () => {
  const script = `
    process.env.STATE_FILE = "/var/lib/epiber-paj/state.sqlite";
    delete process.env.MESSAGING_FILE;
    process.stdout.write(require("./config.js").MESSAGING_FILE);
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: BACKEND_ROOT,
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "/var/lib/epiber-paj/messaging.sqlite");
});

test("alle systemd-Vorlagen konfigurieren messaging.sqlite im jeweiligen StateDirectory", () => {
  for (const system of ["piber", "paj", "pk"]) {
    const unit = fs.readFileSync(path.join(SYSTEMD_ROOT, `epiber-${system}.service`), "utf8");
    assert.match(unit, new RegExp(`MESSAGING_FILE=/var/lib/epiber-${system}/messaging\\.sqlite(?: |$)`), system);
  }
});

test("Messaging-Reporting verlangt bei Aktivierung Deployment und starken Base64url-Token", () => {
  const script = `require("./config.js").validateRuntimeConfig()`;
  const baseEnv = {
    ...process.env,
    SHEET_ID: "test",
    COURT_URL: "https://court.invalid/data.json",
    STATE_FILE: ":memory:",
    SCORELOG_FILE: ":memory:",
    AUDITLOG_FILE: ":memory:",
    MESSAGING_FILE: ":memory:",
    MESSAGING_REPORT_ENABLED: "true",
  };
  const invalid = spawnSync(process.execPath, ["-e", script], { cwd: BACKEND_ROOT, encoding: "utf8", env: baseEnv });
  assert.notEqual(invalid.status, 0);
  assert.doesNotMatch(invalid.stderr, /a{43}/);
  const valid = spawnSync(process.execPath, ["-e", script], {
    cwd: BACKEND_ROOT,
    encoding: "utf8",
    env: { ...baseEnv, MESSAGING_REPORT_DEPLOYMENT: "paj", EPIBER_OBSERVABILITY_API_TOKEN: "a".repeat(43) },
  });
  assert.equal(valid.status, 0, valid.stderr);
});

test("nur Live und PAJ aktivieren den internen Reportingvertrag", () => {
  for (const [system, deployment] of [["piber", "live"], ["paj", "paj"]]) {
    const unit = fs.readFileSync(path.join(SYSTEMD_ROOT, `epiber-${system}.service`), "utf8");
    assert.match(unit, /EnvironmentFile=-\/etc\/epiber-observability\/messaging-api\.env/);
    assert.equal(unit.includes("MESSAGING_REPORT_ENABLED=true"), false);
    assert.match(unit, new RegExp(`MESSAGING_REPORT_DEPLOYMENT=${deployment}(?: |$)`));
  }
  const pkUnit = fs.readFileSync(path.join(SYSTEMD_ROOT, "epiber-pk.service"), "utf8");
  assert.equal(pkUnit.includes("MESSAGING_REPORT_ENABLED"), false);
  assert.equal(pkUnit.includes("messaging-api.env"), false);
  const credentialTemplate = fs.readFileSync(path.join(SYSTEMD_ROOT, "../observability/grafana/messaging-api.env.example"), "utf8");
  assert.match(credentialTemplate, /^MESSAGING_REPORT_ENABLED=true$/m);
  const caddy = fs.readFileSync(path.join(SYSTEMD_ROOT, "../Caddyfile"), "utf8");
  assert.equal((caddy.match(/handle \/internal\/\*/g) || []).length, 3);
  assert.equal((caddy.match(/handle \/internal\/\* \{\s*respond 404/g) || []).length, 3);
});
