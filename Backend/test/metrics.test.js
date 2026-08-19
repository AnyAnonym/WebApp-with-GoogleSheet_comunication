const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const metrics = require("../metrics.js");

test("Prometheusmetriken begrenzen Labels und rendern kumulative Histogramme", () => {
  metrics.resetForTests();
  metrics.recordHttpRequest({ method: "GET", route: "/api/session", result: "success", durationMs: 25, responseBytes: 120 });
  metrics.recordHttpRequest({ method: "GET", route: "/api/admin/grafana-auth", result: "success", durationMs: 5, responseBytes: 16 });
  metrics.recordHttpRequest({ method: "TRACE", route: "/person/p1", result: "failed", durationMs: 6000, responseBytes: 10 });
  metrics.recordWsRequest({ endpoint: "players", knownEndpoint: true, result: "success", durationMs: 10 });
  metrics.recordWsRequest({ endpoint: "person-p1", knownEndpoint: false, result: "rejected", durationMs: 20 });
  metrics.recordSheetPoll({ table: "players", result: "recovered", durationMs: 30 });
  metrics.recordSheetPoll({ table: "person-p1", result: "failed", durationMs: 40 });
  metrics.recordSheetApiAttempt({ method: "values_batch_get", purpose: "poll", kind: "initial" });
  metrics.recordSheetApiAttempt({ method: "values_batch_get", purpose: "poll", kind: "retry" });
  metrics.recordSheetApiRequest({ method: "values_batch_get", purpose: "poll", result: "success", durationMs: 50 });
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
    sheets: { activeWrites: 0, queues: 0, pendingMetadataIntents: 0, scheduledRefreshes: 1, readCoordinator: { retryAfterMs: 2500 } },
    peopleNormalization: {
      current: true,
      peopleCount: 42,
      affectedCount: 7,
      issueCount: 9,
      issueCounts: { EMAIL_DUPLICATE: 2, PHONE_FORMAT_INVALID: 3 },
    },
  });

  assert.match(output, /epiber_http_requests_total\{method="GET",result="success",route="\/api\/session"\} 1/);
  assert.match(output, /epiber_http_requests_total\{method="GET",result="success",route="\/api\/admin\/grafana-auth"\} 1/);
  assert.match(output, /# TYPE epiber_http_requests_total counter/);
  assert.match(output, /# TYPE epiber_http_request_duration_seconds histogram/);
  assert.match(output, /epiber_http_requests_total\{method="OTHER",result="failed",route="not_found"\} 1/);
  assert.match(output, /epiber_ws_requests_total\{endpoint="unknown",result="rejected"\} 1/);
  assert.match(output, /epiber_sheet_polls_total\{result="failed",table="unknown"\} 1/);
  assert.match(output, /epiber_sheet_api_attempts_total\{kind="initial",method="values_batch_get",purpose="poll"\} 1/);
  assert.match(output, /epiber_sheet_api_attempts_total\{kind="retry",method="values_batch_get",purpose="poll"\} 1/);
  assert.match(output, /epiber_sheet_api_requests_total\{method="values_batch_get",purpose="poll",result="success"\} 1/);
  assert.match(output, /epiber_sheet_read_cooldown_seconds 2.5/);
  assert.match(output, /epiber_sheet_refreshes_scheduled 1/);
  assert.match(output, /epiber_http_request_duration_seconds_bucket\{le="\+Inf",method="GET",route="\/api\/session"\} 1/);
  assert.match(output, /epiber_people_normalization_current 1/);
  assert.match(output, /epiber_people_normalization_people 42/);
  assert.match(output, /epiber_people_normalization_affected_people 7/);
  assert.match(output, /epiber_people_normalization_issues 9/);
  assert.match(output, /epiber_people_normalization_issue_count\{code="EMAIL_DUPLICATE"\} 2/);
  assert.match(output, /epiber_people_normalization_issue_count\{code="ROLE_INVALID"\} 0/);
  assert.equal(output.includes("person-p1"), false);
  assert.equal(output.includes("Ada"), false);
  assert.equal(output.includes("ada@example.test"), false);
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
  assert.match(output, /epiber_people_normalization_current 0/);
  assert.match(output, /epiber_people_normalization_people 0/);
  assert.match(output, /epiber_people_normalization_affected_people 0/);
  assert.match(output, /epiber_people_normalization_issues 0/);
});
