const { ISSUE_CODES } = require("./peopleNormalization.js");

const HTTP_BUCKETS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120]);
const FIXED_HTTP_METHODS = new Set(["GET", "POST", "DELETE", "OPTIONS"]);
const FIXED_HTTP_ROUTES = new Set([
  "/metrics", "/version", "/live", "/ready", "/health", "/status",
  "/internal/messaging-report",
  "/api/frontend-logging-policy", "/api/frontend-events", "/api/session",
  "/api/password", "/api/admin/grafana-auth", "/api/admin/frontend-logging", "/api/admin/frontend-logging/targets",
  "/api/password-reset", "/api/password-setup", "/api/admin/password-reset",
  "/api/admin/password-setup", "/api/admin/password", "/api/monitor/session",
]);
const FIXED_RESULTS = new Set(["success", "rejected", "failed"]);
const FIXED_SHEET_LOAD_RESULTS = new Set(["applied", "recovered", "failed", "ignored_stale"]);
const FIXED_COURT_RESULTS = new Set(["success", "recovered", "failed", "cancelled"]);
const FIXED_FRONTEND_OUTCOMES = new Set(["accepted", "dropped_policy", "dropped_level", "dropped_sampling", "dropped_rate_limit"]);
const FIXED_FRONTEND_REJECTIONS = new Set(["validation_error"]);
const FIXED_LOG_OUTCOMES = new Set(["written", "serialization_failed", "write_failed", "backpressure"]);
const FIXED_LEVELS = new Set(["debug", "info", "warn", "error"]);
const FIXED_TABLES = new Set(["players", "bewerbe", "bewerbsart", "matchtyp", "matches1", "rlPlatzierung", "navigator", "entryList"]);
const FIXED_SHEET_METHODS = new Set(["values_get", "values_batch_get", "spreadsheet_get", "metadata_search", "metadata_row", "metadata_rows", "metadata_cleanup"]);
const FIXED_SHEET_PURPOSES = new Set(["initial", "startup_recovery", "admin_refresh", "refresh", "write_precondition", "write_refresh", "confirmation", "metadata_search", "sheet_properties", "metadata_row", "metadata_rows", "metadata_cleanup"]);
const FIXED_SHEET_REFRESH_TRIGGERS = new Set(["startup", "startup_recovery", "admin"]);
const FIXED_SHEET_REQUEST_RESULTS = new Set(["success", "failed", "rate_limited"]);
const FIXED_SHEET_ATTEMPT_KINDS = new Set(["initial", "retry"]);

let counters = new Map();
let histograms = new Map();

function safeLabel(value, allowed, fallback = "unknown") {
  const normalized = String(value || "");
  return allowed.has(normalized) ? normalized : fallback;
}

function labelKey(labels) {
  return Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`).join("\u0000");
}

function increment(name, labels = {}, amount = 1) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) return false;
  const key = `${name}\u0001${labelKey(labels)}`;
  const current = counters.get(key) || { name, labels: { ...labels }, value: 0 };
  current.value += value;
  counters.set(key, current);
  return true;
}

function observe(name, labels, value, buckets = HTTP_BUCKETS) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return false;
  const key = `${name}\u0001${labelKey(labels)}`;
  const current = histograms.get(key) || {
    name,
    labels: { ...labels },
    count: 0,
    sum: 0,
    buckets: buckets.map((upperBound) => ({ upperBound, count: 0 })),
  };
  current.count++;
  current.sum += number;
  for (const bucket of current.buckets) {
    if (number <= bucket.upperBound) bucket.count++;
  }
  histograms.set(key, current);
  return true;
}

function normalizeHttpRoute(route) {
  if (FIXED_HTTP_ROUTES.has(route)) return route;
  return route === "invalid" ? "invalid" : "not_found";
}

function recordHttpRequest({ method, route, result, durationMs, responseBytes = 0 }) {
  const labels = {
    method: safeLabel(String(method || "").toUpperCase(), FIXED_HTTP_METHODS, "OTHER"),
    route: normalizeHttpRoute(route),
    result: safeLabel(result, FIXED_RESULTS, "failed"),
  };
  increment("epiber_http_requests_total", labels);
  observe("epiber_http_request_duration_seconds", { method: labels.method, route: labels.route }, Math.max(0, Number(durationMs) || 0) / 1000);
  increment("epiber_http_response_bytes_total", { route: labels.route }, Math.max(0, Number(responseBytes) || 0));
}

function recordWsRequest({ endpoint, knownEndpoint, result, durationMs }) {
  const safeEndpoint = knownEndpoint && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(endpoint) ? endpoint : "unknown";
  const safeResult = safeLabel(result, FIXED_RESULTS, "failed");
  increment("epiber_ws_requests_total", { endpoint: safeEndpoint, result: safeResult });
  observe("epiber_ws_request_duration_seconds", { endpoint: safeEndpoint }, Math.max(0, Number(durationMs) || 0) / 1000);
}

function recordSheetTableLoad({ table, result, durationMs }) {
  const safeResult = safeLabel(result, FIXED_SHEET_LOAD_RESULTS, "failed");
  const safeTable = safeLabel(table, FIXED_TABLES);
  increment("epiber_sheet_table_loads_total", { table: safeTable, result: safeResult });
  observe("epiber_sheet_table_load_duration_seconds", { table: safeTable }, Math.max(0, Number(durationMs) || 0) / 1000);
}

function sheetApiLabels(method, purpose) {
  return {
    method: safeLabel(method, FIXED_SHEET_METHODS),
    purpose: safeLabel(purpose, FIXED_SHEET_PURPOSES),
  };
}

function recordSheetApiAttempt({ method, purpose, kind }) {
  increment("epiber_sheet_api_attempts_total", {
    ...sheetApiLabels(method, purpose),
    kind: safeLabel(kind, FIXED_SHEET_ATTEMPT_KINDS),
  });
}

function recordSheetApiRequest({ method, purpose, result, durationMs }) {
  const labels = sheetApiLabels(method, purpose);
  increment("epiber_sheet_api_requests_total", {
    ...labels,
    result: safeLabel(result, FIXED_SHEET_REQUEST_RESULTS, "failed"),
  });
  observe("epiber_sheet_api_request_duration_seconds", labels, Math.max(0, Number(durationMs) || 0) / 1000);
}

function recordSheetRefresh({ trigger, result, durationMs }) {
  const labels = {
    trigger: safeLabel(trigger, FIXED_SHEET_REFRESH_TRIGGERS),
    result: safeLabel(result, new Set(["success", "failed"]), "failed"),
  };
  increment("epiber_sheet_refresh_operations_total", labels);
  observe("epiber_sheet_refresh_duration_seconds", { trigger: labels.trigger }, Math.max(0, Number(durationMs) || 0) / 1000);
}

function recordCourtPoll({ result, durationMs }) {
  const safeResult = safeLabel(result, FIXED_COURT_RESULTS, "failed");
  increment("epiber_court_polls_total", { result: safeResult });
  observe("epiber_court_poll_duration_seconds", {}, Math.max(0, Number(durationMs) || 0) / 1000);
}

function recordFrontendEvents(outcome, amount = 1) {
  increment("epiber_frontend_events_total", { outcome: safeLabel(outcome, FIXED_FRONTEND_OUTCOMES, "dropped_policy") }, amount);
}

function recordFrontendBatchRejection(reason) {
  increment("epiber_frontend_batch_rejections_total", { reason: safeLabel(reason, FIXED_FRONTEND_REJECTIONS, "validation_error") });
}

function recordLog(level, outcome = "written") {
  const safeLevel = safeLabel(level, FIXED_LEVELS, "error");
  const safeOutcome = safeLabel(outcome, FIXED_LOG_OUTCOMES, "write_failed");
  if (safeOutcome === "written") increment("epiber_log_events_total", { level: safeLevel });
  else increment(`epiber_log_${safeOutcome}_total`, { level: safeLevel });
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLabels(labels) {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}` : "";
}

function number(value, fallback = 0) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
}

function gauge(lines, name, value, labels = {}) {
  lines.push(`${name}${formatLabels(labels)} ${number(value)}`);
}

function metricType(lines, name, type) {
  lines.push(`# TYPE ${name} ${type}`);
}

function render({ appVersion, processStartedAt, activeHttpRequests, readiness, ws, sheetPoller, court, state, sheets, peopleNormalization } = {}) {
  const lines = [];
  for (const name of [
    "epiber_info", "epiber_process_uptime_seconds", "epiber_http_requests_active", "epiber_ready",
    "epiber_readiness_component_ready", "epiber_sheet_table_available", "epiber_sheet_table_current", "epiber_sheet_table_age_seconds",
    "epiber_sheet_table_consecutive_errors", "epiber_sheet_refresh_in_progress", "epiber_sheet_startup_recovery_active",
    "epiber_sheet_last_success_age_seconds",
    "epiber_sheet_writes_active", "epiber_sheet_write_queues", "epiber_sheet_metadata_intents_pending",
    "epiber_sheet_read_cooldown_seconds", "epiber_sheet_refreshes_scheduled",
    "epiber_court_poller_running", "epiber_court_active", "epiber_court_source_stale",
    "epiber_court_source_age_seconds", "epiber_court_poll_consecutive_failures", "epiber_court_score_updates",
    "epiber_ws_connections", "epiber_ws_requests_active", "epiber_sqlite_open", "epiber_sqlite_ready",
    "epiber_sqlite_writes_total", "epiber_sqlite_failures_total", "epiber_audit_records", "epiber_scorelog_sequence",
    "epiber_people_normalization_current", "epiber_people_normalization_people",
    "epiber_people_normalization_active_members",
    "epiber_people_normalization_affected_people", "epiber_people_normalization_issues",
    "epiber_people_normalization_issue_count",
  ]) metricType(lines, name, name.endsWith("_total") ? "counter" : "gauge");
  gauge(lines, "epiber_info", 1, { version: appVersion || "unknown" });
  gauge(lines, "epiber_process_uptime_seconds", Math.max(0, Date.now() - number(processStartedAt, Date.now())) / 1000);
  gauge(lines, "epiber_http_requests_active", Math.max(0, number(activeHttpRequests)));
  gauge(lines, "epiber_ready", readiness?.ready ? 1 : 0);

  const components = readiness?.components || {};
  for (const component of ["initialized", "accepting_requests", "state_sqlite", "scorelog_sqlite", "auditlog_sqlite", "messaging_sqlite", "sheet_data", "court_source", "court_display_rules"]) {
    gauge(lines, "epiber_readiness_component_ready", components[component] ? 1 : 0, { component });
  }
  for (const [table, tableStatus] of Object.entries(readiness?.data?.tables || {}).sort(([left], [right]) => left.localeCompare(right))) {
    gauge(lines, "epiber_sheet_table_available", tableStatus.available ? 1 : 0, { table });
    gauge(lines, "epiber_sheet_table_current", tableStatus.current ? 1 : 0, { table });
    gauge(lines, "epiber_sheet_table_age_seconds", tableStatus.ageMs === null ? -1 : Math.max(0, number(tableStatus.ageMs)) / 1000, { table });
    gauge(lines, "epiber_sheet_table_consecutive_errors", Math.max(0, number(tableStatus.consecutiveErrors)), { table });
  }
  gauge(lines, "epiber_sheet_refresh_in_progress", sheetPoller?.inProgress ? 1 : 0);
  gauge(lines, "epiber_sheet_startup_recovery_active", sheetPoller?.bootstrapRecoveryActive ? 1 : 0);
  gauge(lines, "epiber_sheet_last_success_age_seconds", sheetPoller?.dataAgeMs === null ? -1 : Math.max(0, number(sheetPoller?.dataAgeMs)) / 1000);
  gauge(lines, "epiber_sheet_writes_active", Math.max(0, number(sheets?.activeWrites)));
  gauge(lines, "epiber_sheet_write_queues", Math.max(0, number(sheets?.queues)));
  gauge(lines, "epiber_sheet_metadata_intents_pending", Math.max(0, number(sheets?.pendingMetadataIntents)));
  gauge(lines, "epiber_sheet_read_cooldown_seconds", Math.max(0, number(sheets?.readCoordinator?.retryAfterMs)) / 1000);
  gauge(lines, "epiber_sheet_refreshes_scheduled", Math.max(0, number(sheets?.scheduledRefreshes)));

  gauge(lines, "epiber_people_normalization_current", peopleNormalization?.current ? 1 : 0);
  gauge(lines, "epiber_people_normalization_people", Math.max(0, number(peopleNormalization?.peopleCount)));
  for (const classification of ["player", "player_a", "player_b"]) {
    gauge(lines, "epiber_people_normalization_active_members", Math.max(0, number(peopleNormalization?.activeMemberCounts?.[classification])), { classification });
  }
  gauge(lines, "epiber_people_normalization_affected_people", Math.max(0, number(peopleNormalization?.affectedCount)));
  gauge(lines, "epiber_people_normalization_issues", Math.max(0, number(peopleNormalization?.issueCount)));
  for (const code of ISSUE_CODES) {
    gauge(lines, "epiber_people_normalization_issue_count", Math.max(0, number(peopleNormalization?.issueCounts?.[code])), { code });
  }

  gauge(lines, "epiber_court_poller_running", court?.running ? 1 : 0);
  for (const courtId of ["1", "2"]) gauge(lines, "epiber_court_active", court?.courtActive?.[courtId] ? 1 : 0, { court: courtId });
  gauge(lines, "epiber_court_source_stale", readiness?.court?.source?.stale ? 1 : 0);
  gauge(lines, "epiber_court_source_age_seconds", readiness?.court?.source?.ageMs === null ? -1 : Math.max(0, number(readiness?.court?.source?.ageMs)) / 1000);
  gauge(lines, "epiber_court_poll_consecutive_failures", Math.max(0, number(court?.consecutiveFailures)));
  gauge(lines, "epiber_court_score_updates", Math.max(0, number(court?.pushCount)));

  for (const [connectionState, count] of Object.entries(ws?.connections || {}).sort(([left], [right]) => left.localeCompare(right))) {
    gauge(lines, "epiber_ws_connections", Math.max(0, number(count)), { state: connectionState });
  }
  gauge(lines, "epiber_ws_requests_active", Math.max(0, number(ws?.activeRequests)));

  const databases = {
    state,
    scorelog: readiness?.scoreLog,
    audit: readiness?.auditLog,
    messaging: readiness?.messaging,
  };
  for (const [database, status] of Object.entries(databases)) {
    gauge(lines, "epiber_sqlite_open", status?.open ? 1 : 0, { database });
    gauge(lines, "epiber_sqlite_ready", status?.ready !== false && status?.open ? 1 : 0, { database });
    if (status?.writeCount !== undefined) gauge(lines, "epiber_sqlite_writes_total", Math.max(0, number(status.writeCount)), { database });
    gauge(lines, "epiber_sqlite_failures_total", Math.max(0, number(status?.failureCount)), { database });
  }
  gauge(lines, "epiber_audit_records", Math.max(0, number(readiness?.auditLog?.count)));
  for (const courtId of ["1", "2"]) {
    gauge(lines, "epiber_scorelog_sequence", Math.max(0, number(readiness?.scoreLog?.lastSequenceByCourt?.[courtId])), { court: courtId });
  }

  const counterRows = [...counters.values()].sort((left, right) => left.name.localeCompare(right.name) || labelKey(left.labels).localeCompare(labelKey(right.labels)));
  for (const name of new Set(counterRows.map((row) => row.name))) metricType(lines, name, "counter");
  for (const row of counterRows) gauge(lines, row.name, row.value, row.labels);
  const histogramRows = [...histograms.values()].sort((left, right) => left.name.localeCompare(right.name) || labelKey(left.labels).localeCompare(labelKey(right.labels)));
  for (const name of new Set(histogramRows.map((row) => row.name))) metricType(lines, name, "histogram");
  for (const row of histogramRows) {
    for (const bucket of row.buckets) gauge(lines, `${row.name}_bucket`, bucket.count, { ...row.labels, le: String(bucket.upperBound) });
    gauge(lines, `${row.name}_bucket`, row.count, { ...row.labels, le: "+Inf" });
    gauge(lines, `${row.name}_sum`, row.sum, row.labels);
    gauge(lines, `${row.name}_count`, row.count, row.labels);
  }
  return `${lines.join("\n")}\n`;
}

function resetForTests() {
  counters = new Map();
  histograms = new Map();
}

module.exports = {
  normalizeHttpRoute,
  recordCourtPoll,
  recordFrontendBatchRejection,
  recordFrontendEvents,
  recordHttpRequest,
  recordLog,
  recordSheetApiAttempt,
  recordSheetApiRequest,
  recordSheetTableLoad,
  recordSheetRefresh,
  recordWsRequest,
  render,
  resetForTests,
};
