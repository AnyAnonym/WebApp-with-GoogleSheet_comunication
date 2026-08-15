const http = require("node:http");
const { version: APP_VERSION } = require("./package.json");
const { parseCookies } = require("./security.js");

const DEFAULT_REALMS = Object.freeze([
  Object.freeze({ name: "live", cookie: "epiber_piber_session", url: "http://127.0.0.1:8080/api/admin/grafana-auth", userPrefix: "epiber-piber:" }),
  Object.freeze({ name: "pk", cookie: "epiber_pk_session", url: "http://127.0.0.1:8084/api/admin/grafana-auth", userPrefix: "epiber-pk:" }),
  Object.freeze({ name: "paj", cookie: "epiber_paj_session", url: "http://127.0.0.1:8083/api/admin/grafana-auth", userPrefix: "epiber-paj:" }),
]);

function selectRealms(value, realms = DEFAULT_REALMS) {
  if (typeof value !== "string" || !value.trim()) throw new Error("GRAFANA_AUTH_BROKER_REALMS fehlt");
  const names = value.split(",").map((name) => name.trim());
  if (names.some((name) => !name)) throw new Error("GRAFANA_AUTH_BROKER_REALMS enthaelt einen leeren Eintrag");
  const selected = new Set();
  const known = new Set(realms.map((realm) => realm.name));
  for (const name of names) {
    if (!known.has(name)) throw new Error(`Unbekanntes Grafana-Auth-Realm: ${name}`);
    if (selected.has(name)) throw new Error(`Doppeltes Grafana-Auth-Realm: ${name}`);
    selected.add(name);
  }
  return Object.freeze(realms.filter((realm) => selected.has(realm.name)));
}

function writeLog(level, event, fields = {}) {
  const line = JSON.stringify({
    ...fields,
    timestamp: new Date().toISOString(),
    level,
    service: "epiber-grafana-auth",
    instance: "shared",
    version: APP_VERSION,
    event,
  });
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

function json(response, status, body, headers = {}) {
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

function text(response, body) {
  response.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function verifyRealm(realm, token, { fetchImpl, timeoutMs }) {
  try {
    const response = await fetchImpl(realm.url, {
      method: "GET",
      headers: { Cookie: `${realm.cookie}=${encodeURIComponent(token)}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 200) {
      const user = response.headers.get("x-webauth-user") || "";
      const role = response.headers.get("x-webauth-role") || "";
      if (user.startsWith(realm.userPrefix) && user.length > realm.userPrefix.length && role === "Admin") {
        return { outcome: "accepted", realm: realm.name, user, role };
      }
      return { outcome: "unavailable", realm: realm.name, reason: "invalid_identity_headers" };
    }
    if (response.status === 401) return { outcome: "unauthenticated", realm: realm.name };
    if (response.status === 403) return { outcome: "forbidden", realm: realm.name };
    return { outcome: "unavailable", realm: realm.name, reason: `status_${response.status}` };
  } catch (error) {
    return { outcome: "unavailable", realm: realm.name, reason: error?.name === "TimeoutError" ? "timeout" : "request_failed" };
  }
}

function createHandler({ realms = [], fetchImpl = fetch, timeoutMs = 2000, log = writeLog } = {}) {
  return async function handler(request, response) {
    if (request.url === "/metrics") {
      if (request.method !== "GET") return json(response, 405, { success: false }, { Allow: "GET" });
      return text(response, "# TYPE epiber_grafana_auth_broker_up gauge\nepiber_grafana_auth_broker_up 1\n");
    }
    if (request.url === "/live") {
      if (request.method !== "GET") return json(response, 405, { success: false }, { Allow: "GET" });
      return json(response, 200, { status: "ok", version: APP_VERSION });
    }
    if (request.url !== "/auth") return json(response, 404, { success: false });
    if (request.method !== "GET") return json(response, 405, { success: false }, { Allow: "GET" });

    const cookies = parseCookies(request.headers.cookie);
    const candidates = realms.filter((realm) => cookies[realm.cookie]);
    if (!candidates.length) return json(response, 401, { success: false });

    const results = await Promise.all(candidates.map((realm) => verifyRealm(realm, cookies[realm.cookie], { fetchImpl, timeoutMs })));
    const accepted = results.find((result) => result.outcome === "accepted");
    if (accepted) {
      return json(response, 200, { success: true }, {
        "X-WEBAUTH-USER": accepted.user,
        "X-WEBAUTH-ROLE": accepted.role,
      });
    }

    const unavailable = results.find((result) => result.outcome === "unavailable");
    if (unavailable) {
      log("warn", "grafana_auth_unavailable", { realm: unavailable.realm, reason: unavailable.reason });
      return json(response, 503, { success: false });
    }
    const status = results.some((result) => result.outcome === "forbidden") ? 403 : 401;
    return json(response, status, { success: false });
  };
}

function createApplication(options = {}) {
  const server = http.createServer(createHandler(options));
  server.requestTimeout = 5000;
  server.headersTimeout = 3000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 50;
  return server;
}

function start() {
  const host = process.env.GRAFANA_AUTH_BROKER_HOST || "127.0.0.1";
  const port = Number(process.env.GRAFANA_AUTH_BROKER_PORT || 8085);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Ungueltiger GRAFANA_AUTH_BROKER_PORT");
  const realms = selectRealms(process.env.GRAFANA_AUTH_BROKER_REALMS);
  const server = createApplication({ realms });
  server.listen(port, host, () => writeLog("info", "grafana_auth_broker_started", { host, port }));
}

if (require.main === module) start();

module.exports = { DEFAULT_REALMS, createApplication, createHandler, selectRealms, verifyRealm };
