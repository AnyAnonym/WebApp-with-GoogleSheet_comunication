const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dashboardFile = path.resolve(
  __dirname,
  "../../Project/server-configs/observability/grafana/dashboards/epiber-score-history.json",
);

test("Scoreverlauf-Dashboard verwendet kontrollierte Loki-Felder und Filter", () => {
  const dashboard = JSON.parse(fs.readFileSync(dashboardFile, "utf8"));
  assert.equal(dashboard.uid, "epiber-score-history");
  assert.equal(dashboard.refresh, "10s");
  assert.deepEqual(dashboard.templating.list.map(({ name }) => name), ["deployment", "court"]);
  assert.equal(dashboard.templating.list[1].allValue, "1|2");

  const timeline = dashboard.panels.find(({ title }) => title === "Platz- und Scoreverlauf");
  assert.equal(timeline.type, "logs");
  assert.deepEqual(timeline.datasource, { type: "loki", uid: "loki" });
  assert.equal(timeline.options.sortOrder, "Descending");
  assert.equal(timeline.targets.length, 1);
  assert.deepEqual(timeline.targets[0].datasource, { type: "loki", uid: "loki" });
  const query = timeline.targets[0].expr;
  assert.match(query, /event=~\"score_logged\|court_state_snapshot\"/);
  assert.match(query, /court=~\"\$court\"/);
  for (const field of ["score", "matchId", "bewerb", "homePlayer", "guestPlayer", "sequence", "reason"]) {
    assert.match(query, new RegExp(`\\b${field}\\b`));
  }
  for (const forbidden of ["email", "phone", "telefon", "address", "geburt", "payload"]) {
    assert.equal(query.toLowerCase().includes(forbidden), false);
  }
});
