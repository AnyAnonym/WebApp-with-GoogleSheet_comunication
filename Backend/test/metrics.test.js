const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const metrics = require("../metrics.js");

test("Prometheusmetriken begrenzen Labels und rendern kumulative Histogramme", () => {
  metrics.resetForTests();
  metrics.recordHttpRequest({ method: "GET", route: "/api/session", result: "success", durationMs: 25, responseBytes: 120 });
  metrics.recordHttpRequest({ method: "TRACE", route: "/person/p1", result: "failed", durationMs: 6000, responseBytes: 10 });
  metrics.recordWsRequest({ endpoint: "players", knownEndpoint: true, result: "success", durationMs: 10 });
  metrics.recordWsRequest({ endpoint: "person-p1", knownEndpoint: false, result: "rejected", durationMs: 20 });
  metrics.recordSheetPoll({ table: "players", result: "recovered", durationMs: 30 });
  metrics.recordSheetPoll({ table: "person-p1", result: "failed", durationMs: 40 });
  metrics.recordFrontendEvents("accepted", 2);

  const output = metrics.render({
    appVersion: "test-version",
    processStartedAt: Date.now() - 1000,
    activeHttpRequests: 1,
    readiness: {
      ready: false,
      components: { initialized: true },
      data: { tables: { players: { current: true, ageMs: 500, consecutiveErrors: 0 } } },
      court: { source: { stale: false, ageMs: 1000 } },
      scoreLog: { open: true, ready: true, lastSequenceByCourt: { "1": 2, "2": 0 } },
      auditLog: { open: true, ready: true, count: 3 },
    },
    ws: { connections: { user: 1 }, activeRequests: 0 },
    sheetPoller: { running: true, isPolling: false },
    court: { running: false, courtActive: { "1": false, "2": false }, consecutiveFailures: 0, pushCount: 0 },
    state: { open: true, ready: true },
    sheets: { activeWrites: 0, queues: 0, pendingMetadataIntents: 0 },
  });

  assert.match(output, /epiber_http_requests_total\{method="GET",result="success",route="\/api\/session"\} 1/);
  assert.match(output, /# TYPE epiber_http_requests_total counter/);
  assert.match(output, /# TYPE epiber_http_request_duration_seconds histogram/);
  assert.match(output, /epiber_http_requests_total\{method="OTHER",result="failed",route="not_found"\} 1/);
  assert.match(output, /epiber_ws_requests_total\{endpoint="unknown",result="rejected"\} 1/);
  assert.match(output, /epiber_sheet_polls_total\{result="failed",table="unknown"\} 1/);
  assert.match(output, /epiber_http_request_duration_seconds_bucket\{le="\+Inf",method="GET",route="\/api\/session"\} 1/);
  assert.equal(output.includes("person-p1"), false);
  assert.equal(output.endsWith("\n"), true);
  assert.equal(output.endsWith("\n\n"), false);
});

test("Prometheusmetriken ignorieren ungueltige Beobachtungen", () => {
  metrics.resetForTests();
  metrics.recordFrontendEvents("accepted", -1);
  metrics.recordHttpRequest({ method: "GET", route: "/version", result: "success", durationMs: Number.NaN, responseBytes: -10 });
  const output = metrics.render({});
  assert.equal(output.includes("epiber_frontend_events_total"), false);
  assert.match(output, /epiber_http_response_bytes_total\{route="\/version"\} 0/);
});
