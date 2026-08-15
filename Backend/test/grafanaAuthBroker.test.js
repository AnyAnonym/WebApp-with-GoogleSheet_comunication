const test = require("node:test");
const assert = require("node:assert/strict");
const { createApplication, createHandler, selectRealms } = require("../grafanaAuthBroker.js");

const realms = [
  { name: "live", cookie: "live_session", url: "http://live/auth", userPrefix: "epiber-piber:" },
  { name: "pk", cookie: "pk_session", url: "http://pk/auth", userPrefix: "epiber-pk:" },
  { name: "paj", cookie: "paj_session", url: "http://paj/auth", userPrefix: "epiber-paj:" },
];

function response(status, user = "", role = "") {
  return new Response("{}", { status, headers: { "X-WEBAUTH-USER": user, "X-WEBAUTH-ROLE": role } });
}

test("Broker waehlt nur explizit konfigurierte Realms in kanonischer Prioritaet", () => {
  assert.deepEqual(selectRealms("paj,live", realms).map((realm) => realm.name), ["live", "paj"]);
  for (const value of [undefined, "", " ", "live,,paj", "live,live", "live,unknown", "LIVE,paj"]) {
    assert.throws(() => selectRealms(value, realms));
  }
});

test("Deaktiviertes PK-Realm wird auch mit vorhandenem Cookie nicht angefragt", async (context) => {
  const requests = [];
  const activeRealms = selectRealms("live,paj", realms);
  const server = createApplication({
    realms: activeRealms,
    fetchImpl: async (url) => {
      requests.push(url);
      return response(200, "epiber-piber:live-admin", "Admin");
    },
    log: () => {},
  });
  context.after(() => server.close());
  const base = await listen(server);
  assert.equal((await fetch(`${base}/auth`, { headers: { Cookie: "pk_session=pk" } })).status, 401);
  assert.deepEqual(requests, []);
  const accepted = await fetch(`${base}/auth`, { headers: { Cookie: "pk_session=pk; live_session=live" } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(requests, ["http://live/auth"]);
});

test("Broker-API bleibt ohne explizite Realms fail-closed", async (context) => {
  let called = false;
  const server = createApplication({ fetchImpl: async () => { called = true; return response(200); }, log: () => {} });
  context.after(() => server.close());
  const base = await listen(server);
  assert.equal((await fetch(`${base}/auth`, { headers: { Cookie: "pk_session=pk; live_session=live" } })).status, 401);
  assert.equal(called, false);
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("Broker verlangt GET und einen bekannten Pfad", async (context) => {
  const server = createApplication({ realms, fetchImpl: async () => response(500), log: () => {} });
  context.after(() => server.close());
  const base = await listen(server);
  assert.equal((await fetch(`${base}/live`)).status, 200);
  const metrics = await fetch(`${base}/metrics`);
  assert.equal(metrics.status, 200);
  assert.equal(metrics.headers.get("content-type"), "text/plain; version=0.0.4; charset=utf-8");
  assert.match(await metrics.text(), /epiber_grafana_auth_broker_up 1/);
  assert.equal((await fetch(`${base}/auth`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
});

test("Broker lehnt fehlende Sessions ab und ignoriert Browser-Identitaetsheader", async (context) => {
  let called = false;
  const server = createApplication({ realms, fetchImpl: async () => { called = true; return response(200); }, log: () => {} });
  context.after(() => server.close());
  const base = await listen(server);
  const result = await fetch(`${base}/auth`, { headers: { "X-WEBAUTH-USER": "attacker", "X-WEBAUTH-ROLE": "Admin" } });
  assert.equal(result.status, 401);
  assert.equal(result.headers.get("x-webauth-user"), null);
  assert.equal(called, false);
});

test("Broker reicht nur das passende Cookie weiter und uebernimmt Backendheader", async (context) => {
  const requests = [];
  const server = createApplication({
    realms,
    fetchImpl: async (url, options) => {
      requests.push({ url, cookie: options.headers.Cookie });
      return response(200, "epiber-pk:p1", "Admin");
    },
    log: () => {},
  });
  context.after(() => server.close());
  const base = await listen(server);
  const result = await fetch(`${base}/auth`, { headers: { Cookie: "pk_session=secret; unrelated=value" } });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("x-webauth-user"), "epiber-pk:p1");
  assert.equal(result.headers.get("x-webauth-role"), "Admin");
  assert.deepEqual(requests, [{ url: "http://pk/auth", cookie: "pk_session=secret" }]);
});

test("Broker verwendet bei mehreren Adminsessions die feste Realmprioritaet", async (context) => {
  const server = createApplication({
    realms,
    fetchImpl: async (url) => url.includes("live")
      ? response(200, "epiber-piber:live-admin", "Admin")
      : response(200, "epiber-paj:paj-admin", "Admin"),
    log: () => {},
  });
  context.after(() => server.close());
  const base = await listen(server);
  const result = await fetch(`${base}/auth`, { headers: { Cookie: "paj_session=a; live_session=b" } });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("x-webauth-user"), "epiber-piber:live-admin");
});

test("Broker akzeptiert eine gesunde Adminsession trotz Ausfall eines anderen Realms", async (context) => {
  const server = createApplication({
    realms,
    fetchImpl: async (url) => url.includes("live")
      ? response(503)
      : response(200, "epiber-paj:p1", "Admin"),
    log: () => {},
  });
  context.after(() => server.close());
  const base = await listen(server);
  const result = await fetch(`${base}/auth`, { headers: { Cookie: "live_session=a; paj_session=b" } });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("x-webauth-user"), "epiber-paj:p1");
});

test("Broker unterscheidet Rollenverbot und nicht pruefbare Identitaet", async () => {
  async function invoke(fetchImpl) {
    return new Promise((resolve) => {
      const headers = {};
      createHandler({ realms, fetchImpl, log: () => {} })(
        { method: "GET", url: "/auth", headers: { cookie: "pk_session=value" } },
        {
          writeHead(status, values) { this.status = status; Object.assign(headers, values); },
          end(body) { resolve({ status: this.status, headers, body }); },
        },
      );
    });
  }
  assert.equal((await invoke(async () => response(403))).status, 403);
  assert.equal((await invoke(async () => response(200, "attacker", "Admin"))).status, 503);
  assert.equal((await invoke(async () => { throw new Error("down"); })).status, 503);
});
