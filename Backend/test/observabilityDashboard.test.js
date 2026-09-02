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
const resourcesDashboardFile = path.resolve(
  __dirname,
  "../../Project/server-configs/observability/grafana/dashboards/epiber-resources.json",
);
const peopleNormalizationDashboardFile = path.resolve(
  __dirname,
  "../../Project/server-configs/observability/grafana/dashboards/epiber-people-normalization.json",
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

test("Hostressourcen zeigen aktuelle Werte mit passenden Einheiten", () => {
  const dashboard = JSON.parse(fs.readFileSync(resourcesDashboardFile, "utf8"));
  assert.equal(dashboard.uid, "epiber-resources");
  assert.equal(dashboard.version, 2);

  const expectedUnits = new Map([
    ["CPU-Auslastung", "percent"],
    ["Verfuegbarer RAM", "bytes"],
    ["Freier Speicher", "bytes"],
    ["Freie Inodes", "short"],
    ["Netzwerkdurchsatz", "Bps"],
  ]);
  for (const panel of dashboard.panels) {
    assert.deepEqual(panel.options.legend, {
      calcs: ["lastNotNull"],
      displayMode: "table",
      placement: "bottom",
      showLegend: true,
    });
    if (expectedUnits.has(panel.title)) {
      assert.equal(panel.fieldConfig.defaults.unit, expectedUnits.get(panel.title));
    }
  }

  const ram = dashboard.panels.find(({ title }) => title === "Verfuegbarer RAM");
  assert.equal(ram.targets[0].legendFormat, "RAM verfuegbar");
  const services = dashboard.panels.find(({ title }) => title === "ePiber-Dienstzustand");
  assert.equal(services.fieldConfig.defaults.mappings[0].options["1"].text, "Aktiv");
});

test("Personennormalisierung zeigt aktive Mitglieder nach Playerklassifikation", () => {
  const dashboard = JSON.parse(fs.readFileSync(peopleNormalizationDashboardFile, "utf8"));
  assert.equal(dashboard.uid, "epiber-people-normalization");
  assert.equal(dashboard.version, 2);

  const expectedPanels = new Map([
    ["Aktive Mitglieder", null],
    ["Aktive Player A", "player_a"],
    ["Aktive Player B", "player_b"],
    ["Aktive nur Player", "player"],
  ]);
  for (const [title, classification] of expectedPanels) {
    const panel = dashboard.panels.find((entry) => entry.title === title);
    assert.equal(panel.type, "stat");
    assert.equal(panel.gridPos.y, 5);
    assert.match(panel.targets[0].expr, /epiber_people_normalization_active_members/);
    assert.match(panel.targets[0].expr, /epiber_people_normalization_current/);
    if (classification) assert.match(panel.targets[0].expr, new RegExp(`classification="${classification}"`));
    else {
      assert.match(panel.targets[0].expr, /^sum by \(deployment\)/);
      assert.match(panel.targets[0].expr, /classification=~"player\|player_a\|player_b"/);
    }
  }
});
