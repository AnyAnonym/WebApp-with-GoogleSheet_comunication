const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
process.env.COURT_FETCH_TIMEOUT_MS = "500";
process.env.COURT_POLL_INTERVAL_MS = "500";
process.env.COURT_MAX_BACKOFF_MS = "2000";

const courtPoller = require("../courtPoller.js");

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

test("Court-Poller begrenzt haengende Calls, verkraftet ungueltiges JSON und pusht semantisch", async (t) => {
  let mode = "slow";
  let extraField = "first";
  let liveScore = "6";
  let abortCount = 0;
  const notifications = [];
  const fetchStub = async (_url, { signal }) => {
    if (mode === "slow") {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortCount++;
          reject(signal.reason);
        }, { once: true });
      });
    }
    if (mode === "invalid") {
      return new Response("{invalid", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      generatedAt: extraField,
      courts: [{
        platz: "1",
        satz1home: liveScore,
        satz1gast: "4",
        satz2home: "0",
        satz2gast: "0",
        satz3home: "0",
        satz3gast: "0",
        punktehome: "15",
        punktegast: "0",
        ignored: extraField,
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  courtPoller.setDependenciesForTests({
    fetch: fetchStub,
    sheetsFactory: async () => ({ spreadsheets: { values: { append: async () => ({ data: {} }) } } }),
  });
  courtPoller.setOnUpdate((snapshot, metadata) => notifications.push({ snapshot, metadata }));
  t.after(async () => {
    courtPoller.setCourtActive({ "1": false, "2": false });
    await courtPoller.stop();
    courtPoller.setOnUpdate(null);
  });
  courtPoller.setCourtActive({ "1": true, "2": false });

  await waitFor(
    () => courtPoller.getStatus().lastError?.message.includes("Timeout"),
    1200,
    "Court-Fetch wurde nicht rechtzeitig abgebrochen",
  );

  mode = "invalid";
  await waitFor(
    () => courtPoller.getStatus().lastError?.message.includes("JSON"),
    1800,
    "Ungueltiges Court-JSON wurde nicht als Fehler erfasst",
  );

  mode = "valid";
  const baselinePollCount = courtPoller.getStatus().pollCount;
  await waitFor(
    () => courtPoller.getStatus().pollCount > baselinePollCount,
    3200,
    "Erster gueltiger Court-Stand wurde nicht als Baseline gelesen",
  );
  assert.equal(courtPoller.getStatus().revision, 0);
  liveScore = "7";
  await waitFor(
    () => courtPoller.getStatus().revision === 1,
    3200,
    "Gueltiger Court-Snapshot wurde nach Backoff nicht verarbeitet",
  );
  const afterFirstSuccess = courtPoller.getStatus();
  assert.equal(afterFirstSuccess.pushCount, 1);
  assert.equal(courtPoller.getLastData().courts[0].ignored, undefined);

  extraField = "second";
  await waitFor(
    () => courtPoller.getStatus().pollCount > afterFirstSuccess.pollCount,
    1200,
    "Zweiter Court-Poll blieb aus",
  );
  assert.equal(courtPoller.getStatus().revision, 1);
  assert.equal(courtPoller.getStatus().pushCount, 1);

  const failureMarker = courtPoller.getStatus().lastAttemptAt;
  mode = "invalid";
  await waitFor(
    () => courtPoller.getStatus().lastError && courtPoller.getStatus().lastAttemptAt > failureMarker,
    1800,
    "Fehlerstatus fuer unveraenderte Court-Daten wurde nicht publiziert",
  );
  const notificationCount = notifications.length;
  mode = "valid";
  await waitFor(
    () => notifications.slice(notificationCount).some(({ metadata, snapshot }) => metadata.changed === false && snapshot.source.lastError === null),
    3200,
    "Erholung mit unveraenderten Scores wurde nicht publiziert",
  );

  mode = "slow";
  const attemptMarker = courtPoller.getStatus().lastAttemptAt;
  const abortMarker = abortCount;
  await waitFor(() => courtPoller.getStatus().lastAttemptAt > attemptMarker, 1200, "Deaktivierungstest hat keinen Fetch gestartet");
  courtPoller.setCourtActive({ "1": false, "2": false });
  await waitFor(() => abortCount > abortMarker, 300, "Deaktivierung hat den laufenden Court-Fetch nicht abgebrochen");
});

test("ScoreLog verwendet den dreispaltigen Legacy-Write ohne Retry", async (t) => {
  let score = "3";
  let appendFails = false;
  const appendCalls = [];
  const fetchStub = async () => new Response(JSON.stringify({
    courts: [{
      platz: "1",
      satz1home: score,
      satz1gast: "4",
      satz2home: "0",
      satz2gast: "0",
      satz3home: "0",
      satz3gast: "0",
      punktehome: "15",
      punktegast: "0",
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  const sheets = {
    spreadsheets: {
      values: {
        async get() {
          throw new Error("Legacy-ScoreLog darf keinen Readback ausfuehren");
        },
        async append(params) {
          appendCalls.push(structuredClone(params));
          if (appendFails) throw new Error("ScoreLog permission denied");
          return { data: {} };
        },
      },
    },
  };

  courtPoller.setDependenciesForTests({ fetch: fetchStub, sheetsFactory: async () => sheets });
  t.after(async () => {
    courtPoller.setCourtActive({ "1": false, "2": false });
    await courtPoller.stop();
  });
  courtPoller.setCourtActive({ "1": true, "2": false });
  const baselinePollCount = courtPoller.getStatus().pollCount;
  await waitFor(() => courtPoller.getStatus().pollCount > baselinePollCount, 1200, "Initialer Score wurde nicht als Baseline gelesen");
  assert.equal(appendCalls.length, 0);
  score = "4";
  await waitFor(() => appendCalls.length === 1, 1200, "Initialer Score wurde nicht geloggt");
  assert.equal(appendCalls[0].range, "ScoreLog");
  assert.equal(appendCalls[0].valueInputOption, "USER_ENTERED");
  assert.equal(appendCalls[0].requestBody.values[0].length, 3);
  assert.match(appendCalls[0].requestBody.values[0][0], /^\d{6}-\d{4}-\d{2}$/);
  assert.deepEqual(appendCalls[0].requestBody.values[0].slice(1), ["1", "4-4/0-0/0-0/15-0"]);

  appendFails = true;
  score = "5";
  await waitFor(() => appendCalls.length === 2, 1200, "Geaenderter Score wurde nicht geschrieben");
  const pollMarker = courtPoller.getStatus().pollCount;
  await waitFor(() => courtPoller.getStatus().pollCount > pollMarker, 1200, "Folgepoll blieb aus");
  assert.equal(appendCalls.length, 2);

  appendFails = false;
  score = "6";
  await waitFor(() => appendCalls.length === 3, 1200, "Naechste Scoreaenderung wurde nicht geschrieben");
});

test("persistiert aktiver Court uebernimmt nach Prozessstart den ersten Stand ohne ScoreLog", async (t) => {
  let score = "8";
  const appendCalls = [];
  const fetchStub = async () => new Response(JSON.stringify({
    courts: [{
      platz: "1",
      satz1home: score,
      satz1gast: "5",
      satz2home: "0",
      satz2gast: "0",
      satz3home: "0",
      satz3gast: "0",
      punktehome: "30",
      punktegast: "15",
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  courtPoller.setCourtActive({ "1": false, "2": false });
  courtPoller.setDependenciesForTests({
    fetch: fetchStub,
    sheetsFactory: async () => ({
      spreadsheets: { values: { append: async (params) => { appendCalls.push(structuredClone(params)); } } },
    }),
  });
  t.after(async () => {
    courtPoller.setCourtActive({ "1": false, "2": false });
    await courtPoller.stop();
  });

  courtPoller.setCourtActive({ "1": true, "2": false }, { initial: true });
  await waitFor(
    () => courtPoller.getLastData().courts.find((entry) => entry.platz === "1")?.satz1home === "8",
    1200,
    "Erster Court-Stand wurde nach Prozessstart nicht uebernommen",
  );
  assert.equal(appendCalls.length, 0);

  score = "9";
  await waitFor(() => appendCalls.length === 1, 1200, "Folgeaenderung wurde nicht geloggt");
});

test("deaktivierte Plaetze frieren ein und ein Reset ueberholt laufende Fetches", async (t) => {
  let releaseFetch;
  let fetchStarted = false;
  const responseScores = {
    "1": "6",
    "2": "4",
  };
  let delayed = false;
  const court = (platz) => ({
    platz,
    satz1home: responseScores[platz],
    satz1gast: "2",
    satz2home: "0",
    satz2gast: "0",
    satz3home: "0",
    satz3gast: "0",
    punktehome: "15",
    punktegast: "0",
  });
  const fetchStub = async () => {
    fetchStarted = true;
    if (delayed) await new Promise((resolve) => { releaseFetch = resolve; });
    return new Response(JSON.stringify({ courts: [court("1"), court("2")] }), { status: 200 });
  };

  courtPoller.setDependenciesForTests({
    fetch: fetchStub,
    sheetsFactory: async () => ({ spreadsheets: { values: { append: async () => ({ data: {} }) } } }),
  });
  t.after(async () => {
    releaseFetch?.();
    courtPoller.setCourtActive({ "1": false, "2": false });
    await courtPoller.stop();
  });

  courtPoller.setCourtActive({ "1": true, "2": true });
  const baselinePollCount = courtPoller.getStatus().pollCount;
  await waitFor(() => courtPoller.getStatus().pollCount > baselinePollCount, 1200, "Initiale Scores wurden nicht als Baseline gelesen");
  responseScores["1"] = "7";
  responseScores["2"] = "5";
  await waitFor(
    () => courtPoller.getLastData().courts.find((entry) => entry.platz === "1")?.satz1home === "7",
    1200,
    "Initiale Scores wurden nicht uebernommen",
  );

  courtPoller.setCourtActive({ "1": false, "2": true });
  responseScores["1"] = "1";
  responseScores["2"] = "6";
  await waitFor(
    () => courtPoller.getLastData().courts.find((entry) => entry.platz === "2")?.satz1home === "6",
    1200,
    "Aktiver Platz wurde nicht weiter aktualisiert",
  );
  assert.equal(courtPoller.getLastData().courts.find((entry) => entry.platz === "1").satz1home, "7");

  const reactivationPollCount = courtPoller.getStatus().pollCount;
  courtPoller.setCourtActive({ "1": true, "2": true });
  await waitFor(() => courtPoller.getStatus().pollCount >= reactivationPollCount + 2, 1800, "Reaktivierter Platz wurde nicht gepollt");
  assert.equal(courtPoller.getLastData().courts.find((entry) => entry.platz === "1").satz1home, "7");
  responseScores["1"] = "2";
  await waitFor(
    () => courtPoller.getLastData().courts.find((entry) => entry.platz === "1")?.satz1home === "2",
    1200,
    "Erste externe Aenderung nach Reaktivierung wurde nicht uebernommen",
  );

  delayed = true;
  fetchStarted = false;
  await waitFor(() => fetchStarted && typeof releaseFetch === "function", 1200, "Verzoegerter Fetch wurde nicht gestartet");
  courtPoller.resetCourtScore("1");
  const pollMarker = courtPoller.getStatus().pollCount;
  releaseFetch();
  await waitFor(() => courtPoller.getStatus().pollCount > pollMarker, 1200, "Verzoegerter Fetch wurde nicht abgeschlossen");
  const resetCourt = courtPoller.getLastData().courts.find((entry) => entry.platz === "1");
  assert.deepEqual(
    Object.fromEntries(Object.entries(resetCourt).filter(([key]) => key !== "platz")),
    {
      satz1home: "0", satz1gast: "0", satz2home: "0", satz2gast: "0",
      satz3home: "0", satz3gast: "0", punktehome: "0", punktegast: "0",
    },
  );
});
