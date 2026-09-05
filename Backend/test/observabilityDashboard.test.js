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
const matchResultsDashboardFile = path.resolve(
  __dirname,
  "../../Project/server-configs/observability/grafana/dashboards/epiber-match-results.json",
);
const messagingDashboardFile = path.resolve(
  __dirname,
  "../../Project/server-configs/observability/grafana/dashboards/epiber-messaging.json",
);
const observabilityRoot = path.resolve(__dirname, "../../Project/server-configs/observability");

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

test("Matchergebnis-Dashboard begrenzt Auditqueries auf kontrollierte Felder", () => {
  const dashboard = JSON.parse(fs.readFileSync(matchResultsDashboardFile, "utf8"));
  assert.equal(dashboard.uid, "epiber-match-results");
  assert.equal(dashboard.title, "ePiber Matchergebnisse");
  assert.equal(dashboard.time.from, "now-14d");
  assert.equal(dashboard.refresh, "10s");
  assert.deepEqual(dashboard.templating.list.map(({ name }) => name), ["deployment", "competitionId"]);
  assert.equal(dashboard.templating.list[0].query, "live,paj");
  assert.equal(dashboard.templating.list[1].type, "textbox");
  assert.equal(dashboard.templating.list[1].query, ".*");

  const requiredActions = "setMatchResult|adminCorrectRankingResult|adminSetMatchEnd|adminClearMatchResult";
  const auditTargets = dashboard.panels.flatMap(({ targets = [] }) => targets)
    .filter(({ expr = "" }) => expr.includes('event="audit_recorded"'));
  assert.equal(auditTargets.length, 6);
  for (const { expr } of auditTargets) {
    assert.match(expr, new RegExp(`action=~"${requiredActions}"`));
    assert.match(expr, /competitionId=~"\$competitionId"/);
    const selector = expr.slice(0, expr.indexOf("}") + 1);
    for (const id of ["matchId", "competitionId", "koTargetMatchId", "actorId", "requestId"]) {
      assert.equal(selector.includes(id), false, `${id} darf kein Loki-Label sein`);
    }
  }

  const expectedSuccessPanels = new Map([
    ["Erfolgreiche Ergebniseintraege", "result"],
    ["Ergebniskorrekturen", "result_corrected"],
    ["Ergebnisruecknahmen", "result_cleared"],
    ["MatchEnd-Korrekturen", "match_end_corrected"],
  ]);
  for (const [title, changeType] of expectedSuccessPanels) {
    const query = dashboard.panels.find((panel) => panel.title === title).targets[0].expr;
    assert.match(query, /result="success"/);
    assert.match(query, new RegExp(`changeType="${changeType}"`));
  }

  const outcomes = dashboard.panels.find(({ title }) => title === "Fehlgeschlagene und unklare Ausgaenge");
  assert.match(outcomes.targets[0].expr, /sum by \(action, result, errorCode\)/);
  assert.match(outcomes.targets[0].expr, /result=~"failed\|unknown"/);

  const audit = dashboard.panels.find(({ title }) => title === "Matchergebnis-Audit");
  assert.equal(audit.type, "logs");
  const controlledFields = [
    "matchId", "competitionId", "changeType", "completionType", "source", "shiftedCount",
    "koTargetMatchId", "koTargetStatus", "actorName", "actorId", "result", "errorCode", "requestId",
  ];
  const keepFields = audit.targets[0].expr.match(/\| keep ([^|]+) \| line_format/)[1]
    .split(",").map((field) => field.trim());
  assert.deepEqual(keepFields, controlledFields);

  const technical = dashboard.panels.find(({ title }) => title === "Technische WS-Fehler");
  assert.match(technical.targets[0].expr, /event="ws_request_completed"/);
  assert.match(technical.targets[0].expr, new RegExp(`endpoint=~"${requiredActions}"`));
  assert.match(technical.targets[0].expr, /result=~"rejected\|failed"/);

  const serialized = JSON.stringify(dashboard).toLowerCase();
  for (const forbidden of ["reason", "rawresult", "resultvalue", "payload", "contact", "email", "phone", "telefon", "password", "token"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} darf nicht im Dashboard vorkommen`);
  }
});

test("Messaging-Dashboard nutzt nur gepinnte interne Infinity-Abfragen", () => {
  const dashboard = JSON.parse(fs.readFileSync(messagingDashboardFile, "utf8"));
  assert.equal(dashboard.uid, "epiber-messaging");
  assert.equal(dashboard.timezone, "Europe/Vienna");
  assert.equal(dashboard.time.from, "now-30d");
  assert.equal(dashboard.refresh, "5m");
  assert.deepEqual(dashboard.templating.list.map(({ name }) => name), ["deployment"]);
  assert.equal(dashboard.templating.list[0].query, "Live : http://127.0.0.1:8080, PAJ : http://127.0.0.1:8083");
  const targets = dashboard.panels.flatMap(({ targets = [] }) => targets);
  assert.equal(targets.length, 6);
  for (const target of targets) {
    assert.deepEqual(target.datasource, { type: "yesoreyeram-infinity-datasource", uid: "epiber-messaging" });
    assert.equal(target.type, "json");
    assert.equal(target.source, "url");
    assert.equal(target.parser, "backend");
    assert.equal(target.url_options.method, "GET");
    assert.equal(target.url, "$deployment/internal/messaging-report?from=${__from}&to=${__to}");
    assert.equal(Object.hasOwn(target, "headers"), false);
  }
  const trend = dashboard.panels.find(({ title }) => title === "Persoenliche Meldungen pro Tag");
  assert.deepEqual(trend.targets[0].columns.map(({ selector }) => selector), ["time", "total", "results", "challenges", "dateChanges"]);
  assert.equal(trend.fieldConfig.defaults.custom.stacking.mode, "none");
  const details = dashboard.panels.find(({ title }) => title === "Meldungsdetails");
  for (const field of ["subject", "body", "summary", "detail", "result", "actorName", "acknowledgedAt", "deliveries"]) {
    assert.equal(details.targets[0].columns.some(({ selector }) => selector === field), true, field);
  }
});

test("Infinity-Provisionierung pinnt Plugin und haelt das Credential ausserhalb des Repositories", () => {
  const datasource = fs.readFileSync(path.join(observabilityRoot, "grafana/provisioning/datasources/epiber.yml"), "utf8");
  assert.match(datasource, /type: yesoreyeram-infinity-datasource/);
  assert.match(datasource, /bearerToken: \$EPIBER_OBSERVABILITY_API_TOKEN/);
  assert.match(datasource, /unsecuredQueryHandling: deny/);
  assert.match(datasource, /http:\/\/127\.0\.0\.1:8080/);
  assert.match(datasource, /http:\/\/127\.0\.0\.1:8083/);
  const installer = fs.readFileSync(path.join(observabilityRoot, "install-observability.sh"), "utf8");
  assert.match(installer, /INFINITY_PLUGIN_VERSION=4\.0\.0/);
  assert.match(installer, /plugins install "\$INFINITY_PLUGIN_ID" "\$INFINITY_PLUGIN_VERSION"/);
  assert.equal(installer.includes("--insecure"), false);
  const template = fs.readFileSync(path.join(observabilityRoot, "grafana/messaging-api.env.example"), "utf8");
  assert.match(template, /EPIBER_OBSERVABILITY_API_TOKEN=CHANGE_ME/);
  assert.equal(/[A-Za-z0-9_-]{43}/.test(template.split("=").at(-1).trim()), false);
});
