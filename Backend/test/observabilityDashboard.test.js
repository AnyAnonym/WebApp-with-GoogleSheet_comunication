const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dashboardFile = path.resolve(
  __dirname,
  "../../Project/server-configs/observability/grafana/dashboards/epiber-score-history.json",
);
const rankingDashboardFile = path.resolve(
  __dirname,
  "../../Project/server-configs/observability/grafana/dashboards/epiber-ranking-activity.json",
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

test("Ranglistenaktivitaeten trennen Forderungen von nicht angelegten Versuchen", () => {
  const dashboard = JSON.parse(fs.readFileSync(rankingDashboardFile, "utf8"));
  assert.equal(dashboard.uid, "epiber-ranking-activity");
  assert.equal(dashboard.time.from, "now-14d");
  assert.deepEqual(dashboard.templating.list.map(({ name }) => name), ["deployment", "bewerb"]);

  const successful = dashboard.panels.find(({ title }) => title === "Ausgesprochene Forderungen");
  assert.match(successful.targets[0].expr, /action=\"addMatch\"/);
  assert.match(successful.targets[0].expr, /result=\"success\"/);
  const unsuccessful = dashboard.panels.find(({ title }) => title === "Nicht angelegte Versuche");
  assert.match(unsuccessful.targets[0].expr, /result=\"failed\"/);
  assert.match(unsuccessful.description, /keine Ablehnung durch den Geforderten/);

  const audit = dashboard.panels.find(({ title }) => title === "Forderungs-Audit");
  assert.equal(audit.type, "logs");
  for (const field of ["actorName", "actorId", "targetName", "targetId", "bewerbId", "matchId", "result", "errorCode", "requestId"]) {
    assert.match(audit.targets[0].expr, new RegExp(`\\b${field}\\b`));
  }
  for (const forbidden of ["email", "phone", "telefon", "address", "geburt", "payload", "password", "token"]) {
    assert.equal(audit.targets[0].expr.toLowerCase().includes(forbidden), false);
  }
});
