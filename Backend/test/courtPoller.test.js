const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
process.env.COURT_FETCH_TIMEOUT_MS = "500";
process.env.COURT_POLL_INTERVAL_MS = "500";
process.env.COURT_MAX_BACKOFF_MS = "2000";

const courtPoller = require("../courtPoller.js");
const { StateRepository } = require("../stateRepository.js");

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

  courtPoller.setDependenciesForTests({ fetch: fetchStub });
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

test("ScoreLog behaelt fehlgeschlagene Eintraege und verwendet dieselbe Event-ID erneut", async (t) => {
  const repository = new StateRepository(":memory:");
  repository.init();
  courtPoller.setRepository(repository);
  let score = "6";
  let appendFailure = "ambiguous";
  const appendEventIds = [];
  const loggedEventIds = new Set();
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
          return { data: { values: [...loggedEventIds].map((eventId) => [eventId]) } };
        },
        async append({ requestBody }) {
          const eventId = requestBody.values[0][3];
          appendEventIds.push(eventId);
          if (appendFailure === "ambiguous") throw new Error("temporary ScoreLog outage");
          if (appendFailure === "definite") {
            const error = new Error("ScoreLog permission denied");
            error.response = { status: 403 };
            throw error;
          }
          loggedEventIds.add(eventId);
          return { data: {} };
        },
      },
    },
  };

  courtPoller.setDependenciesForTests({ fetch: fetchStub, sheetsFactory: async () => sheets });
  t.after(async () => {
    courtPoller.setCourtActive({ "1": false, "2": false });
    await courtPoller.stop();
    repository.close();
  });
  courtPoller.setCourtActive({ "1": true, "2": false });
  await waitFor(() => courtPoller.getStatus().lastSuccessAt > 0, 1200, "Initialer Score wurde nicht gelesen");
  const initialRevision = courtPoller.getStatus().revision;
  const initialPollCount = courtPoller.getStatus().pollCount;

  score = "06";
  await waitFor(() => courtPoller.getStatus().pollCount > initialPollCount, 1200, "Semantischer Vergleich wurde nicht ausgefuehrt");
  assert.equal(courtPoller.getStatus().revision, initialRevision);

  score = "7";
  await waitFor(() => courtPoller.getStatus().scoreLogFailureCount > 0, 3000, "ScoreLog-Fehler wurde nicht behalten");
  assert.equal(courtPoller.getStatus().failedLogWrites, 1);
  assert.equal(new Set(appendEventIds).size, 1);
  assert.equal(repository.getState("scorelog-failures", []).value.length, 1);

  appendFailure = null;
  loggedEventIds.add(appendEventIds[0]);
  await waitFor(() => courtPoller.getStatus().scoreLogSuccessCount > 0, 3000, "ScoreLog-Eintrag wurde nicht erneut geschrieben");
  assert.equal(courtPoller.getStatus().failedLogWrites, 0);
  assert.equal(new Set(appendEventIds).size, 1);
  assert.equal(loggedEventIds.size, 1);
  assert.equal(appendEventIds.length, 1);
  assert.deepEqual(repository.getState("scorelog-failures", []).value, []);

  const successMarker = courtPoller.getStatus().scoreLogSuccessCount;
  const failureMarker = courtPoller.getStatus().scoreLogFailureCount;
  appendFailure = "definite";
  score = "8";
  await waitFor(() => courtPoller.getStatus().scoreLogFailureCount > failureMarker, 3000, "Definitiver ScoreLog-Fehler wurde nicht behalten");
  assert.equal(repository.getState("scorelog-failures", []).value[0].uncertain, false);
  appendFailure = null;
  await waitFor(() => courtPoller.getStatus().scoreLogSuccessCount > successMarker, 3000, "Definitiv fehlgeschlagener Append wurde nicht erneut versucht");
  assert.equal(loggedEventIds.size, 2);
});
