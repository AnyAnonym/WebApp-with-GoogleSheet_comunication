const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const dataStore = require("../dataStore.js");

test.beforeEach(() => dataStore.resetForTests());

test("ein vor einem Write gestarteter Poll darf den Cache nicht zuruecksetzen", () => {
  dataStore.set("entryList", [["ID"], ["old"]], { source: "test" });
  const staleRead = dataStore.beginRead("entryList");
  dataStore.set("entryList", [["ID"], ["old"], ["new"]], { source: "write" });

  const result = dataStore.set("entryList", [["ID"], ["old"]], { source: "poll", readToken: staleRead });
  assert.equal(result.ignored, true);
  assert.deepEqual(dataStore.get("entryList"), [["ID"], ["old"], ["new"]]);
  assert.equal(dataStore.getMeta("entryList").staleResultCount, 1);
});

test("bei ueberlappenden Reads gewinnt der spaeter gestartete Read", () => {
  const first = dataStore.beginRead("matches1");
  const second = dataStore.beginRead("matches1");
  dataStore.set("matches1", [["ID"], ["newer"]], { source: "poll", readToken: second });
  const stale = dataStore.set("matches1", [["ID"], ["older"]], { source: "poll", readToken: first });

  assert.equal(stale.ignored, true);
  assert.deepEqual(dataStore.get("matches1"), [["ID"], ["newer"]]);
});

test("Pollfehler und Erholung werden auch ohne Datenaenderung publiziert", () => {
  const events = [];
  const unsubscribe = dataStore.onChange((event) => events.push(event));
  dataStore.set("entryList", [["ID"], ["e1"]], { source: "poll" });
  events.length = 0;
  dataStore.markError("entryList", new Error("temporarily unavailable"));
  dataStore.set("entryList", [["ID"], ["e1"]], { source: "poll" });
  unsubscribe();

  assert.equal(events[0].source, "poll-error");
  assert.equal(events[0].changed, false);
  assert.equal(events[1].recovered, true);
  assert.equal(events[1].changed, false);
});

test("ein vor einem Write gestarteter Pollfehler darf den Cachezustand nicht ueberholen", () => {
  dataStore.set("entryList", [["ID"], ["old"]], { source: "test" });
  const staleRead = dataStore.beginRead("entryList");
  dataStore.set("entryList", [["ID"], ["new"]], { source: "write" });

  const result = dataStore.markError("entryList", new Error("stale failure"), staleRead);
  assert.equal(result.ignored, true);
  assert.equal(result.result, "ignored_stale");
  assert.equal(dataStore.getMeta("entryList").lastError, null);
  assert.equal(dataStore.getMeta("entryList").staleResultCount, 1);
});

test("Fehlerfolge und Ausfalldauer enden mit einem eindeutigen Recovery-Ergebnis", () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    assert.equal(dataStore.set("entryList", [["ID"], ["e1"]]).result, "applied");
    now = 2000;
    const first = dataStore.markError("entryList", Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    assert.equal(first.result, "failed");
    assert.equal(first.lastError.code, "ETIMEDOUT");
    assert.equal(first.consecutiveErrors, 1);
    assert.equal(first.outageDurationMs, 0);

    now = 2500;
    const second = dataStore.markError("entryList", Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    assert.equal(second.consecutiveErrors, 2);
    assert.equal(second.outageDurationMs, 500);

    now = 4000;
    const recovered = dataStore.set("entryList", [["ID"], ["e1"]]);
    assert.equal(recovered.result, "recovered");
    assert.equal(recovered.recoveredErrorCode, "ETIMEDOUT");
    assert.equal(recovered.recoveredErrorSequence, 2);
    assert.equal(recovered.outageDurationMs, 2000);
    assert.equal(dataStore.getMeta("entryList").consecutiveErrors, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("lokale Write-Projektion verlaengert keine autoritative Tabellenfrische", () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    dataStore.set("entryList", [["ID"], ["e1"]], { source: "poll" });
    const authoritativeAt = dataStore.getMeta("entryList").lastUpdate;
    now = 35000;
    dataStore.markError("entryList", Object.assign(new Error("quota"), { code: "SHEETS_RATE_LIMITED" }));
    now = 36000;
    dataStore.set("entryList", [["ID"], ["e1"], ["e2"]], { source: "write-local", authoritative: false });

    const meta = dataStore.getMeta("entryList");
    assert.equal(meta.lastUpdate, authoritativeAt);
    assert.equal(meta.lastMutation, 36000);
    assert.equal(meta.lastError.code, "SHEETS_RATE_LIMITED");
    assert.equal(meta.consecutiveErrors, 1);
    assert.equal(dataStore.isTableCurrent("entryList", now), false);
  } finally {
    Date.now = originalNow;
  }
});

test("Write-Reads zaeunen Polls ohne eine Fachmutation vorzutaeuschen", () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    dataStore.set("entryList", [["ID"], ["e1"]], { source: "poll" });
    now = 2000;
    dataStore.set("entryList", [["ID"], ["e1"], ["e2"]], { source: "write-local", authoritative: false });
    const staleRead = dataStore.beginRead("entryList");

    now = 3000;
    dataStore.set("entryList", [["ID"], ["e1"], ["e2"]], { source: "write-read" });
    assert.equal(dataStore.getMeta("entryList").lastMutation, 2000);
    assert.equal(dataStore.set("entryList", [["ID"], ["e1"]], { source: "poll", readToken: staleRead }).ignored, true);

    now = 4000;
    dataStore.set("entryList", [["ID"], ["e1"], ["e2"]], { source: "write-refresh" });
    assert.equal(dataStore.getMeta("entryList").lastMutation, 2000);
  } finally {
    Date.now = originalNow;
  }
});
