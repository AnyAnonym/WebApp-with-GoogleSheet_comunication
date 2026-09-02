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
