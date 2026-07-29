const crypto = require("crypto");
const http = require("http");
const { version: APP_VERSION } = require("./package.json");
const {
  ALLOWED_ORIGINS,
  COOKIE_SECURE,
  HTTP_BODY_LIMIT_BYTES,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  LISTEN_HOST,
  MONITOR_COOKIE,
  PORT,
  SESSION_COOKIE,
  SESSION_TTL_MS,
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
const { canonicalizeMonitorPath, idValue, passwordHashValue, stringValue } = require("./validators.js");

function sendJson(response, status, body, headers = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(text);
}

function methodNotAllowed(response, allowed) {
  sendJson(response, 405, {
    ...errorData(new AppError("METHOD_NOT_ALLOWED", "HTTP-Methode ist nicht erlaubt", 405)),
    supportId: crypto.randomUUID(),
  }, { Allow: allowed.join(", ") });
}

function readiness({ repository, sheetService = null, initialized, shuttingDown }) {
  const data = dataStore.getReadiness();
  const poller = dataPoller.getStatus();
  const court = courtPoller.getStatus();
  const courtSource = courtPoller.getLastData().source;
  const activeCourt = court.courtActive["1"] || court.courtActive["2"];
  const courtReady = !activeCourt || !courtSource.stale;
  const ready = initialized && !shuttingDown && repository.status().open && data.ready && poller.running && courtReady;
  return {
    ready,
    initialized,
    shuttingDown,
    data,
    poller: { running: poller.running, tickCount: poller.tickCount },
    court: { ...court, ready: courtReady },
    sheets: sheetService?.status?.() || null,
  };
}

function createApplication(overrides = {}) {
  const repository = overrides.repository || new StateRepository(STATE_FILE);
  repository.init();
  stateStore.init(repository);
  const sheetService = overrides.sheetService || new SheetService({ repository });
  const authService = overrides.authService || new AuthService({ repository, sheetService });
  const monitorBroker = overrides.monitorBroker || new MonitorBroker({ repository, stateStore, dataStore });
  let initialized = false;
  let shuttingDown = false;
  let activeRequests = 0;
  let cleanupTimer = null;
  let initializePromise = null;
  const httpWriteLimiter = new TokenBucketLimiter({ rate: 0.2, burst: 6, idleMs: 900000 });
  const deviceLoginLimiter = new TokenBucketLimiter({ rate: 0.2, burst: 10, idleMs: 900000 });
  const passwordResetLimiter = new TokenBucketLimiter({ rate: 0.1, burst: 5, idleMs: 900000 });

  function limitHttpWrite(request, principalId) {
    if (!httpWriteLimiter.take(`principal:${principalId}`) || !httpWriteLimiter.take(`ip:${getRequestIp(request)}`)) {
      throw new AppError("WRITE_RATE_LIMIT", "Zu viele Schreiboperationen", 429);
    }
  }

  async function handler(request, response) {
    activeRequests++;
    const supportId = crypto.randomUUID();
    try {
      const url = new URL(request.url, "http://backend.invalid");
      const pathname = url.pathname;

      if (request.method === "OPTIONS") {
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        response.writeHead(204, {
          "Access-Control-Allow-Origin": request.headers.origin,
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Credentials": "true",
          "Vary": "Origin",
        });
        response.end();
        return;
      }

      if (pathname === "/version") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return sendJson(response, 200, { version: APP_VERSION });
      }

      if (pathname === "/live") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return sendJson(response, shuttingDown ? 503 : 200, { status: shuttingDown ? "stopping" : "ok", version: APP_VERSION });
      }

      if (pathname === "/ready" || pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const status = readiness({ repository, sheetService, initialized, shuttingDown });
        return sendJson(response, status.ready ? 200 : 503, { status: status.ready ? "ready" : "not-ready", version: APP_VERSION });
      }

      if (shuttingDown) {
        throw new AppError("SHUTTING_DOWN", "Server wird beendet", 503);
      }

      const cookies = parseCookies(request.headers.cookie);
      const sessionToken = cookies[SESSION_COOKIE] || "";

      if (pathname === "/status") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        authService.requireRole(sessionToken, ["admin"]);
        return sendJson(response, 200, {
          status: readiness({ repository, sheetService, initialized, shuttingDown }),
          provider: dataProvider.getStatus(),
          monitor: monitorBroker.status(),
          sheets: sheetService.status(),
          state: stateStore.getStatus(),
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
          });
        }
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        if (request.method === "POST") {
          if (shuttingDown) throw new AppError("SHUTTING_DOWN", "Server wird beendet", 503);
          const body = await readJsonBody(request, Math.min(2048, HTTP_BODY_LIMIT_BYTES));
          const result = await authService.login({ email: body.email, passwordHash: body.passwordHash, ip: getRequestIp(request) });
          const cookie = serializeCookie(SESSION_COOKIE, result.session.token, { maxAge: SESSION_TTL_MS / 1000, secure: COOKIE_SECURE });
          return sendJson(response, 200, { success: true, user: result.user, expiresAt: result.session.expiresAt, serverTime: Date.now() }, { "Set-Cookie": cookie });
        }
        if (request.method === "DELETE") {
          authService.logout(sessionToken);
          return sendJson(response, 200, { success: true }, { "Set-Cookie": clearCookie(SESSION_COOKIE, COOKIE_SECURE) });
        }
        return methodNotAllowed(response, ["GET", "POST", "DELETE"]);
      }

      if (pathname === "/api/password") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        const auth = authService.requireUser(sessionToken);
        limitHttpWrite(request, auth.principal.id);
        const body = await readJsonBody(request, Math.min(2048, HTTP_BODY_LIMIT_BYTES));
        const result = await authService.changeOwnPassword(
          sessionToken,
          passwordHashValue(body.currentPasswordHash, "currentPasswordHash"),
          passwordHashValue(body.newPasswordHash, "newPasswordHash"),
        );
        const cookie = serializeCookie(SESSION_COOKIE, result.session.token, { maxAge: SESSION_TTL_MS / 1000, secure: COOKIE_SECURE });
        return sendJson(response, 200, {
          success: true,
          user: result.user,
          expiresAt: result.session.expiresAt,
          serverTime: Date.now(),
        }, { "Set-Cookie": cookie });
      }

      if (pathname === "/api/password-reset") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        const ip = getRequestIp(request);
        if (!passwordResetLimiter.take(ip)) throw new AppError("RESET_RATE_LIMIT", "Zu viele Reset-Versuche", 429);
        const body = await readJsonBody(request, Math.min(2048, HTTP_BODY_LIMIT_BYTES));
        const result = await authService.resetPassword(
          stringValue(body.resetToken, "resetToken", { min: 32, max: 128, pattern: /^[A-Za-z0-9_-]+$/ }),
          passwordHashValue(body.newPasswordHash, "newPasswordHash"),
        );
        return sendJson(response, 200, result);
      }

      if (pathname === "/api/admin/password-reset") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        const auth = authService.requireRole(sessionToken, ["admin"]);
        limitHttpWrite(request, auth.principal.id);
        const body = await readJsonBody(request, Math.min(2048, HTTP_BODY_LIMIT_BYTES));
        const result = authService.createPasswordReset(
          sessionToken,
          idValue(body.personId, "personId"),
        );
        return sendJson(response, 200, result);
      }

      if (pathname === "/api/admin/password") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        const auth = authService.requireRole(sessionToken, ["admin"]);
        limitHttpWrite(request, auth.principal.id);
        const body = await readJsonBody(request, Math.min(2048, HTTP_BODY_LIMIT_BYTES));
        const result = await authService.setPasswordAsAdmin(
          sessionToken,
          idValue(body.personId, "personId"),
          passwordHashValue(body.newPasswordHash, "newPasswordHash"),
        );
        return sendJson(response, 200, result);
      }

      if (pathname === "/api/monitor/session") {
        if (request.method === "GET") {
          const device = repository.authenticateMonitor(cookies[MONITOR_COOKIE]);
          return sendJson(response, 200, { success: true, authenticated: !!device, monitor: device ? { id: device.monitorId, label: device.label } : null });
        }
        assertAllowedOrigin(request, ALLOWED_ORIGINS);
        if (request.method === "POST") {
          if (!deviceLoginLimiter.take(getRequestIp(request))) {
            throw new AppError("DEVICE_LOGIN_RATE_LIMIT", "Zu viele Geraete-Anmeldeversuche", 429);
          }
          const body = await readJsonBody(request, Math.min(2048, HTTP_BODY_LIMIT_BYTES));
          const token = stringValue(body.token, "token", { min: 32, max: 128 });
          const device = repository.authenticateMonitor(token);
          if (!device) throw new AppError("DEVICE_LOGIN_FAILED", "Geraetetoken ist ungueltig", 401);
          const cookie = serializeCookie(MONITOR_COOKIE, token, { maxAge: 31536000, secure: COOKIE_SECURE });
          return sendJson(response, 200, { success: true, monitor: { id: device.monitorId, label: device.label } }, { "Set-Cookie": cookie });
        }
        if (request.method === "DELETE") {
          return sendJson(response, 200, { success: true }, { "Set-Cookie": clearCookie(MONITOR_COOKIE, COOKIE_SECURE) });
        }
        return methodNotAllowed(response, ["GET", "POST", "DELETE"]);
      }

      sendJson(response, 404, { ...errorData(new AppError("NOT_FOUND", "Route wurde nicht gefunden", 404)), supportId });
    } catch (error) {
      if (!(error instanceof AppError)) console.error(`server: HTTP-Fehler ${supportId}:`, error);
      else if ((error.status || 500) >= 500) console.warn(`server: HTTP-Fehler ${supportId}: ${error.code}`);
      if (!response.headersSent) {
        const headers = {
          ...(error.details?.retryAfterMs ? { "Retry-After": String(Math.ceil(error.details.retryAfterMs / 1000)) } : {}),
          ...(error.details?.sessionInvalidated ? { "Set-Cookie": clearCookie(SESSION_COOKIE, COOKIE_SECURE) } : {}),
        };
        sendJson(response, error.status || 500, { ...errorData(error), supportId }, headers);
      } else {
        response.destroy();
      }
    } finally {
      activeRequests = Math.max(0, activeRequests - 1);
    }
  }

  const server = http.createServer(handler);
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = 100;
  dataProvider.init(server, {
    appVersion: APP_VERSION,
    authService,
    canonicalizeMonitorPath,
    monitorBroker,
    repository,
    sheetService,
  });

  function initialize() {
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      const result = await dataPoller.initialLoad();
      if (shuttingDown) return { ...result, aborted: true };
      dataPoller.start();
      const courts = stateStore.getScoreboardCourts();
      courtPoller.setCourtActive({ "1": courts["1"].aktiv === 1, "2": courts["2"].aktiv === 1 });
      initialized = true;
      cleanupTimer = setInterval(() => repository.cleanup(), 300000);
      cleanupTimer.unref?.();
      return result;
    })();
    return initializePromise;
  }

  async function shutdown(signal = "SIGTERM") {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`server: ${signal}, kontrollierter Shutdown startet`);
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    const serverClosed = server.listening
      ? new Promise((resolve) => server.close(resolve))
      : Promise.resolve();
    const drains = (async () => {
      await Promise.allSettled([
        dataPoller.stop(),
        courtPoller.stop(),
        dataProvider.shutdown(server),
        initializePromise || Promise.resolve(),
      ]);
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
      repository.close();
    } catch (error) {
      server.closeAllConnections();
      drains.finally(() => repository.close());
      throw error;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }

  return {
    authService,
    handler,
    initialize,
    monitorBroker,
    repository,
    server,
    sheetService,
    shutdown,
    status: () => readiness({ repository, sheetService, initialized, shuttingDown }),
  };
}

async function start() {
  validateRuntimeConfig();
  const app = createApplication();
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(PORT, LISTEN_HOST, resolve);
  });
  console.log(`ePiber-Backend v${APP_VERSION} auf http://${LISTEN_HOST}:${PORT}`);
  app.initialize().catch((error) => console.error("server: Initialisierung fehlgeschlagen:", error));

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    const forceTimer = setTimeout(() => {
      console.error("server: Shutdown-Timeout ueberschritten");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS + 2000);
    forceTimer.unref?.();
    try {
      await app.shutdown(signal);
      clearTimeout(forceTimer);
      process.exit(0);
    } catch (error) {
      console.error("server: Shutdown fehlgeschlagen:", error);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  return app;
}

if (require.main === module) {
  start().catch((error) => {
    console.error("server: Start fehlgeschlagen:", error);
    process.exit(1);
  });
}

module.exports = { createApplication, readiness, start };
