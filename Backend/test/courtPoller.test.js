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
        satz1home: "6",
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
  await waitFor(() => appendCalls.length === 1, 1200, "Initialer Score wurde nicht geloggt");
  assert.equal(appendCalls[0].range, "ScoreLog");
  assert.equal(appendCalls[0].valueInputOption, "USER_ENTERED");
  assert.equal(appendCalls[0].requestBody.values[0].length, 3);
  assert.match(appendCalls[0].requestBody.values[0][0], /^\d{6}-\d{4}-\d{2}$/);
  assert.deepEqual(appendCalls[0].requestBody.values[0].slice(1), ["1", "3-4/0-0/0-0/15-0"]);

  appendFails = true;
  score = "4";
  await waitFor(() => appendCalls.length === 2, 1200, "Geaenderter Score wurde nicht geschrieben");
  const pollMarker = courtPoller.getStatus().pollCount;
  await waitFor(() => courtPoller.getStatus().pollCount > pollMarker, 1200, "Folgepoll blieb aus");
  assert.equal(appendCalls.length, 2);

  appendFails = false;
  score = "5";
  await waitFor(() => appendCalls.length === 3, 1200, "Naechste Scoreaenderung wurde nicht geschrieben");
});
