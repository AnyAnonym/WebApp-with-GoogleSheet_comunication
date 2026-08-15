const crypto = require("crypto");
const http = require("http");
const { version: APP_VERSION } = require("./package.json");
const {
  ALLOWED_ORIGINS,
  AUDIT_ACTIONS,
  AUDITLOG_FILE,
  AUDIT_LOG_JOURNAL,
  COOKIE_SECURE,
  HTTP_BODY_LIMIT_BYTES,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  INSTANCE_ID,
  LISTEN_HOST,
  MONITOR_COOKIE,
  PORT,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SCORELOG_FILE,
  SHUTDOWN_GRACE_MS,
  STATE_FILE,
  validateRuntimeConfig,
} = require("./config.js");
const dataPoller = require("./dataPoller.js");
const dataProvider = require("./dataProvider.js");
const dataStore = require("./dataStore.js");
const courtPoller = require("./courtPoller.js");
const stateStore = require("./stateStore.js");
const { AuthService } = require("./authService.js");
const { AppError, errorData } = require("./errors.js");
const { FrontendLoggingService } = require("./frontendLoggingService.js");
const { MonitorBroker } = require("./monitorBroker.js");
const {
  assertAllowedOrigin,
  clearCookie,
  getRequestIp,
  parseCookies,
  readJsonBody,
  serializeCookie,
  TokenBucketLimiter,
} = require("./security.js");
const { SheetService } = require("./sheetService.js");
const { StateRepository } = require("./stateRepository.js");
const { ScoreLogRepository } = require("./scoreLogRepository.js");
const { AuditLogRepository } = require("./auditLogRepository.js");
const logger = require("./logger.js");
const metrics = require("./metrics.js");
const { booleanValue, canonicalizeMonitorPath, emailValue, idValue, passwordHashValue, stringValue } = require("./validators.js");

const RESPONSE_REQUEST_ID = Symbol("responseRequestId");
const RESPONSE_ERROR_CODE = Symbol("responseErrorCode");
const RESPONSE_BYTES = Symbol("responseBytes");
const PROCESS_STARTED_AT = Date.now();

function sendJson(response, status, body, headers = {}) {
  const text = JSON.stringify(body);
  response[RESPONSE_BYTES] = Buffer.byteLength(text);
  response[RESPONSE_ERROR_CODE] = body?.error?.code || response[RESPONSE_ERROR_CODE] || null;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
    ...(response[RESPONSE_REQUEST_ID] ? { "X-Request-ID": response[RESPONSE_REQUEST_ID] } : {}),
  });
  response.end(text);
}

function sendText(response, status, text, contentType) {
  const body = String(text);
  response[RESPONSE_BYTES] = Buffer.byteLength(body);
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": response[RESPONSE_BYTES],
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(response[RESPONSE_REQUEST_ID] ? { "X-Request-ID": response[RESPONSE_REQUEST_ID] } : {}),
  });
  response.end(body);
}

function methodNotAllowed(response, allowed, supportId) {
  sendJson(response, 405, {
    ...errorData(new AppError("METHOD_NOT_ALLOWED", "HTTP-Methode ist nicht erlaubt", 405)),
    supportId,
  }, { Allow: allowed.join(", ") });
}

function readiness({ repository, scoreLogRepository = null, auditLogRepository = null, sheetService = null, initialized, shuttingDown }) {
  const data = dataStore.getReadiness();
  data.ready = Object.entries(data.tables).every(([table, status]) => table === "matchtyp" || status.current);
  const poller = dataPoller.getStatus();
  const court = courtPoller.getStatus();
  const courtSource = courtPoller.getLastData().source;
  const courtState = stateStore.getStatus();
  const unresolvedActiveRules = (courtState.displayRulesMigration?.unresolved || []).filter(
    (entry) => courtState.courts?.[entry.court]?.aktiv === 1,
  );
  const activeCourt = court.courtActive["1"] || court.courtActive["2"];
  const courtReady = !activeCourt || !courtSource.stale;
  const displayRulesReady = unresolvedActiveRules.length === 0;
  const state = repository.status();
  const scoreLog = scoreLogRepository?.status?.() || null;
  const auditLog = auditLogRepository?.status?.() || null;
  const persistenceReady = (!scoreLog || (scoreLog.open && scoreLog.ready)) && (!auditLog || (auditLog.open && auditLog.ready));
  const components = {
    initialized: Boolean(initialized),
    accepting_requests: !shuttingDown,
    state_sqlite: Boolean(state.open && state.ready),
    scorelog_sqlite: !scoreLog || Boolean(scoreLog.open && scoreLog.ready),
    auditlog_sqlite: !auditLog || Boolean(auditLog.open && auditLog.ready),
    sheet_data: Boolean(data.ready),
    sheet_poller: Boolean(poller.running),
    court_source: Boolean(courtReady),
    court_display_rules: Boolean(displayRulesReady),
  };
  const reasons = Object.entries(components).filter(([, value]) => !value).map(([component]) => component.toUpperCase());
  const ready = Object.values(components).every(Boolean);
  return {
    ready,
    initialized,
    shuttingDown,
    components,
    reasons,
    state,
    data,
    poller: { running: poller.running, tickCount: poller.tickCount },
    court: { ...court, source: courtSource, ready: courtReady, displayRulesReady, unresolvedActiveRules },
    sheets: sheetService?.status?.() || null,
    scoreLog,
    auditLog,
  };
}

function createApplication(overrides = {}) {
  const repository = overrides.repository || new StateRepository(STATE_FILE);
  repository.init();
  const scoreLogRepository = overrides.scoreLogRepository || new ScoreLogRepository(SCORELOG_FILE, { instanceId: INSTANCE_ID });
  const auditLogRepository = overrides.auditLogRepository || new AuditLogRepository(AUDITLOG_FILE, {
    instanceId: INSTANCE_ID,
    journal: AUDIT_LOG_JOURNAL,
  });
  scoreLogRepository.init?.();
  auditLogRepository.init?.();
  stateStore.init(repository);
  courtPoller.configure({ scoreLog: scoreLogRepository, courtContext: (court) => stateStore.getCourt(court) });
  const sheetService = overrides.sheetService || new SheetService({ repository });
  const authService = overrides.authService || new AuthService({ repository, sheetService });
  const frontendLoggingService = overrides.frontendLoggingService || new FrontendLoggingService({
    repository,
    authService,
    log: logger.log,
    appVersion: APP_VERSION,
  });
  const monitorBroker = overrides.monitorBroker || new MonitorBroker({ repository, stateStore, dataStore });
  let initialized = false;
  let shuttingDown = false;
  let activeRequests = 0;
  let cleanupTimer = null;
  let initializePromise = null;
  const httpWriteLimiter = new TokenBucketLimiter({ rate: 0.2, burst: 6, idleMs: 900000 });
  const frontendLoggingAdminLimiter = new TokenBucketLimiter({ rate: 1, burst: 20, idleMs: 900000 });
  const deviceLoginLimiter = new TokenBucketLimiter({ rate: 0.2, burst: 10, idleMs: 900000 });
  const passwordResetLimiter = new TokenBucketLimiter({ rate: 0.1, burst: 5, idleMs: 900000 });

  function limitHttpWrite(request, principalId) {
    if (!httpWriteLimiter.take(`principal:${principalId}`) || !httpWriteLimiter.take(`ip:${getRequestIp(request)}`)) {
      throw new AppError("WRITE_RATE_LIMIT", "Zu viele Schreiboperationen", 429);
    }
  }

  function limitFrontendLoggingAdmin(request, principalId) {
    if (!frontendLoggingAdminLimiter.take(`principal:${principalId}`) || !frontendLoggingAdminLimiter.take(`ip:${getRequestIp(request)}`)) {
      throw new AppError("WRITE_RATE_LIMIT", "Zu viele Logging-Aenderungen", 429);
    }
  }

  async function handler(request, response) {
    activeRequests++;
    const supportId = crypto.randomUUID();
    const startedAt = Date.now();
    response[RESPONSE_REQUEST_ID] = supportId;
    let httpAudit = null;
    let httpActionCompleted = false;
    let route = "invalid";
    const beginAudit = ({ action, principal = null, targetType = "", targetId = "", before = null, sourceIp = "", attemptedEmail = "" }) => {
      if (!(AUDIT_ACTIONS.has("*") || AUDIT_ACTIONS.has(action))) return;
      httpAudit = {
        eventId: supportId,
        actorType: principal?.type || "anonymous",
        actorId: principal?.id || "",
        actorName: principal?.name || "",
        role: principal?.role || "anonymous",
        action,
        targetType,
        targetId,
        requestId: supportId,
        result: "started",
        before,
        sourceIp,
        attemptedEmail,
      };
      auditLogRepository.record(httpAudit);
    };
    const finishAudit = ({ principal = null, targetType, targetId, after = null, result = "success", errorCode = null } = {}) => {
      if (!httpAudit) return;
      if (result === "success") httpActionCompleted = true;
      const completedAudit = {
        ...httpAudit,
        ...(principal ? { actorType: principal.type, actorId: principal.id, actorName: principal.name || "", role: principal.role } : {}),
        ...(targetType === undefined ? {} : { targetType }),
        ...(targetId === undefined ? {} : { targetId }),
        result,
        after,
        errorCode,
        finished: true,
      };
      auditLogRepository.record(completedAudit);
      httpAudit = completedAudit;
    };
    const publicResult = (result) => {
      if (!result || typeof result !== "object") return result;
      const value = { ...result };
      delete value._audit;
      return value;
    };
    try {
      const url = new URL(request.url, "http://backend.invalid");
      const pathname = url.pathname;
      route = pathname;
      const origin = request.headers.origin;
      if (origin && ALLOWED_ORIGINS.has(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Access-Control-Allow-Credentials", "true");
        response.setHeader("Vary", "Origin");
      }

      if (request.method === "OPTIONS") {
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        response.writeHead(204, {
          "Access-Control-Allow-Origin": request.headers.origin,
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Credentials": "true",
          "Vary": "Origin",
          "X-Request-ID": supportId,
        });
        response.end();
        return;
      }

      if (pathname === "/version") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"], supportId);
        return sendJson(response, 200, { version: APP_VERSION });
      }

      if (pathname === "/live") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"], supportId);
        return sendJson(response, shuttingDown ? 503 : 200, { status: shuttingDown ? "stopping" : "ok", version: APP_VERSION });
      }

      if (pathname === "/ready" || pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"], supportId);
        const status = readiness({ repository, scoreLogRepository, auditLogRepository, sheetService, initialized, shuttingDown });
        return sendJson(response, status.ready ? 200 : 503, { status: status.ready ? "ready" : "not-ready", version: APP_VERSION });
      }

      if (pathname === "/metrics") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"], supportId);
        const status = readiness({ repository, scoreLogRepository, auditLogRepository, sheetService, initialized, shuttingDown });
        return sendText(response, 200, metrics.render({
          appVersion: APP_VERSION,
          processStartedAt: PROCESS_STARTED_AT,
          activeHttpRequests: activeRequests,
          readiness: status,
          ws: dataProvider.getMetricsStatus(),
          sheetPoller: dataPoller.getStatus(),
          court: courtPoller.getStatus(),
          state: status.state,
          sheets: status.sheets,
        }), "text/plain; version=0.0.4; charset=utf-8");
      }

      if (shuttingDown) {
        throw new AppError("SHUTTING_DOWN", "Server wird beendet", 503);
      }

      const cookies = parseCookies(request.headers.cookie);
      const sessionToken = cookies[SESSION_COOKIE] || "";
      const diagnosticIdentity = () => authService.getDiagnosticIdentity(sessionToken);

      if (pathname === "/api/frontend-logging-policy") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"], supportId);
        return sendJson(response, 200, {
          success: true,
          frontendLogging: frontendLoggingService.getPolicy(diagnosticIdentity()?.id || null),
        });
      }

      if (pathname === "/api/frontend-events") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"], supportId);
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        const body = await readJsonBody(request, HTTP_BODY_LIMIT_BYTES);
        const result = frontendLoggingService.recordBatch({
          body,
          identity: diagnosticIdentity(),
          sourceIp: getRequestIp(request),
        });
        return sendJson(response, 200, result);
      }

      if (pathname === "/status") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"], supportId);
        const statusAuth = authService.requireRole(sessionToken, ["admin"], { allowLastKnownGoodRole: true });
        return sendJson(response, 200, {
          authorization: {
            role: statusAuth.principal.role,
            roleSource: statusAuth.principal.roleSource || "current",
          },
          status: readiness({ repository, scoreLogRepository, auditLogRepository, sheetService, initialized, shuttingDown }),
          provider: dataProvider.getStatus(),
          monitor: monitorBroker.status(),
          sheets: sheetService.status(),
          scoreLog: scoreLogRepository.status(),
          auditLog: auditLogRepository.status(),
          state: stateStore.getStatus(),
        });
      }

      if (pathname === "/api/admin/grafana-auth") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"], supportId);
        const auth = authService.requireRole(sessionToken, ["admin"]);
        return sendJson(response, 200, { success: true }, {
          "X-WEBAUTH-USER": `epiber-${INSTANCE_ID}:${auth.principal.id}`,
          "X-WEBAUTH-ROLE": "Admin",
        });
      }

      if (pathname === "/api/session") {
        if (request.method === "GET") {
          const auth = authService.getUserForToken(sessionToken);
          return sendJson(response, 200, {
            success: true,
            authenticated: !!auth,
            user: auth?.user || null,
            expiresAt: auth?.session.expiresAt || null,
            serverTime: Date.now(),
            frontendLogging: frontendLoggingService.getPolicy(auth?.principal.id || null),
          });
        }
        if (request.method === "POST") {
          assertAllowedOrigin(request, ALLOWED_ORIGINS);
          if (shuttingDown) throw new AppError("SHUTTING_DOWN", "Server wird beendet", 503);
          const body = await readJsonBody(request, Math.min(2048, HTTP_BODY_LIMIT_BYTES));
          const sourceIp = getRequestIp(request);
          let attemptedEmail;
          try {
            attemptedEmail = emailValue(body.email);
          } catch (error) {
            beginAudit({ action: "login", targetType: "session", sourceIp, before: { identifierValid: false } });
            throw error;
          }
          beginAudit({ action: "login", targetType: "session", sourceIp, attemptedEmail, before: { identifierValid: true } });
          const result = await authService.login({ email: attemptedEmail, passwordHash: body.passwordHash, ip: sourceIp });
          finishAudit({
            principal: {
              type: "user",
              id: result.user.id,
              name: [result.user.firstName, result.user.lastName].filter(Boolean).join(" "),
              role: result.user.role,
            },
            targetType: "user",
            targetId: result.user.id,
          });
          const cookie = serializeCookie(SESSION_COOKIE, result.session.token, { maxAge: SESSION_TTL_MS / 1000, secure: COOKIE_SECURE });
          return sendJson(response, 200, {
            success: true,
            user: result.user,
            expiresAt: result.session.expiresAt,
            serverTime: Date.now(),
            frontendLogging: frontendLoggingService.getPolicy(result.user.id),
          }, { "Set-Cookie": cookie });
        }
        if (request.method === "DELETE") {
          assertAllowedOrigin(request, ALLOWED_ORIGINS);
          const auth = authService.getUserForToken(sessionToken);
          beginAudit({ action: "logout", principal: auth?.principal, targetType: "session", targetId: auth?.principal.id || "" });
          authService.logout(sessionToken);
          finishAudit();
          return sendJson(response, 200, {
            success: true,
            frontendLogging: frontendLoggingService.getPolicy(null),
          }, { "Set-Cookie": clearCookie(SESSION_COOKIE, COOKIE_SECURE) });
        }
        return methodNotAllowed(response, ["GET", "POST", "DELETE"], supportId);
      }

      if (pathname === "/api/password") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"], supportId);
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        const auth = authService.requireUser(sessionToken);
        beginAudit({ action: "passwordChange", principal: auth.principal, targetType: "user", targetId: auth.principal.id });
        limitHttpWrite(request, auth.principal.id);
        const body = await readJsonBody(request, Math.min(2048, HTTP_BODY_LIMIT_BYTES));
        const result = await authService.changeOwnPassword(
          sessionToken,
          passwordHashValue(body.currentPasswordHash, "currentPasswordHash"),
          passwordHashValue(body.newPasswordHash, "newPasswordHash"),
        );
        finishAudit({ after: { credentialChanged: true, sessionsRevoked: true } });
        const cookie = serializeCookie(SESSION_COOKIE, result.session.token, { maxAge: SESSION_TTL_MS / 1000, secure: COOKIE_SECURE });
        return sendJson(response, 200, {
          success: true,
          user: result.user,
          expiresAt: result.session.expiresAt,
          serverTime: Date.now(),
          frontendLogging: frontendLoggingService.getPolicy(result.user.id),
        }, { "Set-Cookie": cookie });
      }

      if (pathname === "/api/admin/frontend-logging") {
        if (request.method === "GET") {
          authService.requireRole(sessionToken, ["admin"]);
          return sendJson(response, 200, frontendLoggingService.adminView());
        }
        if (request.method === "POST") {
          assertAllowedOrigin(request, ALLOWED_ORIGINS);
          const auth = authService.requireRole(sessionToken, ["admin"]);
          limitFrontendLoggingAdmin(request, auth.principal.id);
          const body = await readJsonBody(request, Math.min(4096, HTTP_BODY_LIMIT_BYTES));
          const before = frontendLoggingService.settingsSnapshot();
          beginAudit({
            action: "frontendLoggingSettings",
            principal: auth.principal,
            targetType: "frontend-logging",
            targetId: "global",
            before,
          });
          const stored = frontendLoggingService.updateSettings(body);
          finishAudit({ after: { ...stored.value, revision: stored.revision } });
          return sendJson(response, 200, { success: true, settings: { ...stored.value, revision: stored.revision } });
        }
        return methodNotAllowed(response, ["GET", "POST"], supportId);
      }

      if (pathname === "/api/admin/frontend-logging/targets") {
        if (!["POST", "DELETE"].includes(request.method)) return methodNotAllowed(response, ["POST", "DELETE"], supportId);
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        const auth = authService.requireRole(sessionToken, ["admin"]);
        limitFrontendLoggingAdmin(request, auth.principal.id);
        const body = await readJsonBody(request, Math.min(2048, HTTP_BODY_LIMIT_BYTES));
        const personId = idValue(body.personId, "personId");
        const before = frontendLoggingService.targetsSnapshot().value[personId] || null;
        beginAudit({
          action: request.method === "POST" ? "frontendLoggingTargetSet" : "frontendLoggingTargetRemove",
          principal: auth.principal,
          targetType: "user",
          targetId: personId,
          before,
        });
        const result = request.method === "POST"
          ? frontendLoggingService.setTarget(body, auth.principal)
          : frontendLoggingService.removeTarget(body);
        finishAudit({ after: request.method === "POST" ? result.target : { removed: result.removed } });
        return sendJson(response, 200, { success: true, ...result });
      }

      if (pathname === "/api/password-reset") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"], supportId);
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        const ip = getRequestIp(request);
        if (!passwordResetLimiter.take(ip)) throw new AppError("RESET_RATE_LIMIT", "Zu viele Reset-Versuche", 429);
        const body = await readJsonBody(request, Math.min(2048, HTTP_BODY_LIMIT_BYTES));
        beginAudit({ action: "passwordReset", targetType: "user" });
        const result = await authService.resetPassword(
          stringValue(body.resetToken, "resetToken", { min: 32, max: 128, pattern: /^[A-Za-z0-9_-]+$/ }),
          passwordHashValue(body.newPasswordHash, "newPasswordHash"),
        );
        finishAudit({ targetId: result._audit?.personId || "", after: { credentialChanged: true, sessionsRevoked: true } });
        return sendJson(response, 200, publicResult(result));
      }

      if (pathname === "/api/password-setup") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"], supportId);
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        const ip = getRequestIp(request);
        if (!passwordResetLimiter.take(`setup:${ip}`)) throw new AppError("RESET_RATE_LIMIT", "Zu viele Versuche", 429);
        const body = await readJsonBody(request, Math.min(2048, HTTP_BODY_LIMIT_BYTES));
        beginAudit({ action: "passwordSetup", targetType: "user" });
        const result = await authService.setupPassword(
          body.email,
          passwordHashValue(body.newPasswordHash, "newPasswordHash"),
        );
        finishAudit({ targetId: result._audit?.personId || "", after: { credentialChanged: true, sessionsRevoked: true } });
        return sendJson(response, 200, publicResult(result));
      }

      if (pathname === "/api/admin/password-reset") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"], supportId);
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        const auth = authService.requireRole(sessionToken, ["admin"]);
        limitHttpWrite(request, auth.principal.id);
        const body = await readJsonBody(request, Math.min(2048, HTTP_BODY_LIMIT_BYTES));
        beginAudit({ action: "adminPasswordResetProof", principal: auth.principal, targetType: "user", targetId: String(body.personId || "") });
        const result = authService.createPasswordReset(
          sessionToken,
          idValue(body.personId, "personId"),
        );
        finishAudit({ after: { resetProofCreated: true, expiresAt: result.expiresAt } });
        return sendJson(response, 200, result);
      }

      if (pathname === "/api/admin/password-setup") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"], supportId);
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        const auth = authService.requireRole(sessionToken, ["admin"]);
        limitHttpWrite(request, auth.principal.id);
        const body = await readJsonBody(request, Math.min(2048, HTTP_BODY_LIMIT_BYTES));
        beginAudit({ action: "adminPasswordSetup", principal: auth.principal, targetType: "user", targetId: String(body.personId || "") });
        const result = await authService.setPasswordSetupAllowed(
          sessionToken,
          idValue(body.personId, "personId"),
          booleanValue(body.allowed, "allowed"),
        );
        finishAudit({ after: { allowed: result.allowed } });
        return sendJson(response, 200, result);
      }

      if (pathname === "/api/admin/password") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"], supportId);
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        const auth = authService.requireRole(sessionToken, ["admin"]);
        limitHttpWrite(request, auth.principal.id);
        const body = await readJsonBody(request, Math.min(2048, HTTP_BODY_LIMIT_BYTES));
        beginAudit({ action: "adminPasswordSet", principal: auth.principal, targetType: "user", targetId: String(body.personId || "") });
        const result = await authService.setPasswordAsAdmin(
          sessionToken,
          idValue(body.personId, "personId"),
          passwordHashValue(body.newPasswordHash, "newPasswordHash"),
        );
        finishAudit({ after: { credentialChanged: true, sessionsRevoked: true } });
        return sendJson(response, 200, result);
      }

      if (pathname === "/api/monitor/session") {
        if (request.method === "GET") {
          const device = repository.authenticateMonitor(cookies[MONITOR_COOKIE]);
          return sendJson(response, 200, { success: true, authenticated: !!device, monitor: device ? { id: device.monitorId, label: device.label } : null });
        }
        if (request.method === "POST") {
          assertAllowedOrigin(request, ALLOWED_ORIGINS);
          if (!deviceLoginLimiter.take(getRequestIp(request))) {
            throw new AppError("DEVICE_LOGIN_RATE_LIMIT", "Zu viele Geraete-Anmeldeversuche", 429);
          }
          const body = await readJsonBody(request, Math.min(2048, HTTP_BODY_LIMIT_BYTES));
          beginAudit({ action: "monitorEnroll", targetType: "monitor" });
          const token = stringValue(body.token, "token", { min: 32, max: 128 });
          const device = repository.authenticateMonitor(token);
          if (!device) throw new AppError("DEVICE_LOGIN_FAILED", "Geraetetoken ist ungueltig", 401);
          finishAudit({ principal: { type: "device", id: device.monitorId, role: "device" }, targetId: device.monitorId });
          const cookie = serializeCookie(MONITOR_COOKIE, token, { maxAge: 31536000, secure: COOKIE_SECURE });
          return sendJson(response, 200, { success: true, monitor: { id: device.monitorId, label: device.label } }, { "Set-Cookie": cookie });
        }
        if (request.method === "DELETE") {
          assertAllowedOrigin(request, ALLOWED_ORIGINS);
          const device = repository.authenticateMonitor(cookies[MONITOR_COOKIE]);
          beginAudit({ action: "monitorLogout", principal: device ? { type: "device", id: device.monitorId, role: "device" } : null, targetType: "monitor", targetId: device?.monitorId || "" });
          finishAudit();
          return sendJson(response, 200, { success: true }, { "Set-Cookie": clearCookie(MONITOR_COOKIE, COOKIE_SECURE) });
        }
        return methodNotAllowed(response, ["GET", "POST", "DELETE"], supportId);
      }

      sendJson(response, 404, { ...errorData(new AppError("NOT_FOUND", "Route wurde nicht gefunden", 404)), supportId });
    } catch (error) {
      if (route === "/api/frontend-events" && ["FRONTEND_EVENT_NOT_ALLOWED", "VALIDATION_ERROR"].includes(error.code)) {
        metrics.recordFrontendBatchRejection("validation_error");
      }
      let responseError = error;
      if (httpAudit && !httpAudit.finished) {
        try {
          finishAudit({ result: httpActionCompleted || error.code === "WRITE_OUTCOME_UNKNOWN" ? "unknown" : "failed", errorCode: error.code || "INTERNAL_ERROR" });
        } catch (auditError) {
          logger.log("error", "audit_record_failed", { supportId, action: httpAudit.action, error: auditError });
        }
      }
      if (httpActionCompleted && error.code !== "WRITE_OUTCOME_UNKNOWN") {
        responseError = new AppError("WRITE_OUTCOME_UNKNOWN", "Aenderung ausgefuehrt, Auditabschluss ist unklar", 503);
      }
      if (!(error instanceof AppError) || (error.status || 500) >= 500) {
        let route = "invalid";
        try { route = new URL(request.url, "http://backend.invalid").pathname; } catch {}
        logger.log(error instanceof AppError ? "warn" : "error", "http_request_failed", {
          supportId,
          method: request.method,
          route,
          status: error.status || 500,
          error,
        });
      }
      if (!response.headersSent) {
        const headers = {
          ...(responseError.details?.retryAfterMs ? { "Retry-After": String(Math.ceil(responseError.details.retryAfterMs / 1000)) } : {}),
          ...(responseError.details?.sessionInvalidated ? { "Set-Cookie": clearCookie(SESSION_COOKIE, COOKIE_SECURE) } : {}),
        };
        sendJson(response, responseError.status || 500, { ...errorData(responseError), supportId }, headers);
      } else {
        response[RESPONSE_ERROR_CODE] = responseError.code || "INTERNAL_ERROR";
        response.destroy();
      }
    } finally {
      const status = Number(response.statusCode) || 500;
      const errorCode = response[RESPONSE_ERROR_CODE] || null;
      logger.log(status >= 500 ? "warn" : "info", "http_request_completed", {
        supportId,
        method: request.method,
        route,
        status,
        durationMs: Date.now() - startedAt,
        result: status < 400 ? "success" : status < 500 ? "rejected" : "failed",
        errorCode,
        responseBytes: response[RESPONSE_BYTES] || 0,
      });
      metrics.recordHttpRequest({ method: request.method, route, status, durationMs: Date.now() - startedAt, result: status < 400 ? "success" : status < 500 ? "rejected" : "failed", responseBytes: response[RESPONSE_BYTES] || 0 });
      activeRequests = Math.max(0, activeRequests - 1);
    }
  }

  const server = http.createServer(handler);
  server.on("error", (error) => {
    logger.log("error", "http_server_error", { listening: server.listening, error });
  });
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = 100;
  dataProvider.init(server, {
    appVersion: APP_VERSION,
    auditLogRepository,
    authService,
    canonicalizeMonitorPath,
    monitorBroker,
    repository,
    sheetService,
  });

  function initialize() {
    if (initializePromise) return initializePromise;
    const startedAt = Date.now();
    initializePromise = (async () => {
      const result = await dataPoller.initialLoad();
      if (shuttingDown) return { ...result, aborted: true };
      stateStore.migrateLegacyCourtDisplayRules(dataStore.get("matchtyp"));
      dataPoller.start();
      const courts = stateStore.getScoreboardCourts();
      courtPoller.setCourtActive(
        { "1": courts["1"].aktiv === 1, "2": courts["2"].aktiv === 1 },
        { initial: true },
      );
      initialized = true;
      logger.log("info", "server_initialization_completed", { initialLoadSuccess: result.success, ready: readiness({ repository, scoreLogRepository, auditLogRepository, sheetService, initialized, shuttingDown }).ready, durationMs: Date.now() - startedAt });
      cleanupTimer = setInterval(() => repository.cleanup(), 300000);
      cleanupTimer.unref?.();
      return result;
    })();
    return initializePromise;
  }

  async function shutdown(signal = "SIGTERM") {
    if (shuttingDown) return;
    shuttingDown = true;
    const startedAt = Date.now();
    logger.log("info", "server_shutdown_started", { signal, graceMs: SHUTDOWN_GRACE_MS, activeRequests, activeWrites: sheetService.status()?.activeWrites || 0 });
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    const serverClosed = server.listening
      ? new Promise((resolve) => server.close(resolve))
      : Promise.resolve();
    const drains = (async () => {
      const results = await Promise.allSettled([
        dataPoller.stop(),
        courtPoller.stop(),
        dataProvider.shutdown(server),
        initializePromise || Promise.resolve(),
      ]);
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected) throw rejected.reason;
      while (activeRequests > 0) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await sheetService.stop();
    })();
    let deadlineTimer;
    try {
      await Promise.race([
        Promise.all([drains, serverClosed]),
        new Promise((_, reject) => {
          deadlineTimer = setTimeout(
            () => reject(new AppError("SHUTDOWN_TIMEOUT", "Shutdown-Drain hat die Grace-Deadline ueberschritten", 503, {
              activeRequests,
              sheets: sheetService.status(),
            })),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
      auditLogRepository.close?.();
      scoreLogRepository.close?.();
      repository.close();
      logger.log("info", "server_shutdown_completed", { signal, durationMs: Date.now() - startedAt });
    } catch (error) {
      server.closeAllConnections();
      drains.finally(() => {
        auditLogRepository.close?.();
        scoreLogRepository.close?.();
        repository.close();
      });
      throw error;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }

  return {
    authService,
    auditLogRepository,
    frontendLoggingService,
    handler,
    initialize,
    monitorBroker,
    repository,
    scoreLogRepository,
    server,
    sheetService,
    shutdown,
    status: () => readiness({ repository, scoreLogRepository, auditLogRepository, sheetService, initialized, shuttingDown }),
  };
}

async function start() {
  validateRuntimeConfig();
  const app = createApplication();
  await new Promise((resolve, reject) => {
    const onStartupError = (error) => reject(error);
    app.server.once("error", onStartupError);
    app.server.listen(PORT, LISTEN_HOST, () => {
      app.server.off("error", onStartupError);
      resolve();
    });
  });
  logger.log("info", "server_listening", { host: LISTEN_HOST, port: PORT });
  app.initialize().catch((error) => logger.log("error", "server_initialization_failed", { error }));

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    const forceTimer = setTimeout(() => {
      logger.log("error", "server_shutdown_timeout", { graceMs: SHUTDOWN_GRACE_MS });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS + 2000);
    forceTimer.unref?.();
    try {
      await app.shutdown(signal);
      clearTimeout(forceTimer);
      await logger.flush();
      process.exit(0);
    } catch (error) {
      logger.log("error", "server_shutdown_failed", { signal, error });
      await logger.flush();
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("unhandledRejection", (error) => {
    logger.log("error", "server_unhandled_rejection", { error });
    stop("unhandledRejection");
  });
  process.on("uncaughtException", (error) => {
    logger.log("error", "server_uncaught_exception", { error });
    stop("uncaughtException");
  });
  return app;
}

if (require.main === module) {
  start().catch((error) => {
    logger.log("error", "server_start_failed", { error });
    logger.flush().finally(() => process.exit(1));
  });
}

module.exports = { createApplication, readiness, start };
