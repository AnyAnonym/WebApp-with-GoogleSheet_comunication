const test = require("node:test");
const assert = require("node:assert/strict");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
process.env.COURT_FETCH_TIMEOUT_MS = "500";
process.env.COURT_POLL_INTERVAL_MS = "500";
process.env.COURT_MAX_BACKOFF_MS = "2000";

const courtPoller = require("../courtPoller.js");
const logger = require("../logger.js");

function scoreLogRecorder({ shouldFail = () => false } = {}) {
  const events = [];
  let attempts = 0;
  return {
    events,
    get attempts() { return attempts; },
    append(event) {
      attempts++;
      if (shouldFail()) throw new Error("ScoreLog write failed");
      const stored = { ...event, sequence: events.length + 1, occurredAt: new Date().toISOString() };
      events.push(stored);
      return stored;
    },
  };
}

function configure(fetch, scoreLog, courtContext = () => ({ matchId: "m1", aktiv: 1, revision: 1 })) {
  courtPoller.setDependenciesForTests({
    fetch,
    scoreLog,
    courtContext,
  });
}

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

  configure(fetchStub, scoreLogRecorder());
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

test("ScoreLog persistiert vor der Anzeige und wiederholt nach einem Insertfehler", async (t) => {
  let score = "3";
  let appendFails = false;
  let contextActive = 1;
  const scoreLog = scoreLogRecorder({ shouldFail: () => appendFails });
  const logEvents = [];
  const originalLog = logger.log;
  logger.log = (level, event, fields) => {
    logEvents.push({ level, event, fields });
    return true;
  };
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
  configure(fetchStub, scoreLog, () => ({
    matchId: "m1",
    bewerbId: "b1",
    bewerb: "Herren Einzel",
    homePlayer: "Max Muster",
    guestPlayer: "Paul Beispiel",
    aktiv: contextActive,
    revision: 7,
    email: "nicht-loggen@example.test",
    phone: "00123 456",
  }));
  courtPoller.resetCourtScore("1", { reason: "assignment" });
  courtPoller.logCourtSnapshot("1", "startup");
  t.after(async () => {
    logger.log = originalLog;
    courtPoller.setCourtActive({ "1": false, "2": false });
    await courtPoller.stop();
  });
  courtPoller.setCourtActive({ "1": true, "2": false });
  const startupEvent = logEvents.find(({ event, fields }) => event === "court_state_snapshot" && fields.reason === "startup");
  assert.equal(startupEvent.fields.score, "0-0/0-0/0-0/0-0");
  const activatedEvent = logEvents.find(({ event, fields }) => event === "court_state_snapshot" && fields.reason === "activated");
  assert.equal(activatedEvent.fields.active, true);
  const baselinePollCount = courtPoller.getStatus().pollCount;
  await waitFor(() => courtPoller.getStatus().pollCount > baselinePollCount, 1200, "Initialer Score wurde nicht als Baseline gelesen");
  assert.equal(scoreLog.events.length, 0);
  score = "4";
  await waitFor(() => scoreLog.events.length === 1, 1200, "Scoreaenderung wurde nicht persistiert");
  assert.equal(scoreLog.events[0].court, "1");
  assert.equal(scoreLog.events[0].score, "4-4/0-0/0-0/15-0");
  assert.equal(scoreLog.events[0].matchId, "m1");
  const firstScoreEvent = logEvents.find(({ event }) => event === "score_logged");
  assert.deepEqual(firstScoreEvent.fields, {
    eventId: scoreLog.events[0].eventId,
    occurredAt: scoreLog.events[0].occurredAt,
    sequence: 1,
    court: "1",
    score: "4-4/0-0/0-0/15-0",
    matchId: "m1",
    bewerbId: "b1",
    bewerb: "Herren Einzel",
    homePlayer: "Max Muster",
    guestPlayer: "Paul Beispiel",
    active: true,
    courtRevision: 7,
  });
  const assignmentEvent = logEvents.find(({ event, fields }) => event === "court_state_snapshot" && fields.reason === "assignment");
  assert.equal(assignmentEvent.fields.score, "0-0/0-0/0-0/0-0");
  assert.equal(assignmentEvent.fields.homePlayer, "Max Muster");
  assert.equal(JSON.stringify(logEvents).includes("nicht-loggen@example.test"), false);
  assert.equal(JSON.stringify(logEvents).includes("00123 456"), false);

  appendFails = true;
  score = "5";
  await waitFor(() => scoreLog.attempts >= 2, 1200, "Fehlgeschlagener Insert wurde nicht versucht");
  assert.equal(scoreLog.events.length, 1);
  assert.equal(logEvents.filter(({ event }) => event === "score_logged").length, 1);
  assert.equal(courtPoller.getLastData().courts[0].satz1home, "4");

  appendFails = false;
  await waitFor(() => scoreLog.events.length === 2, 1200, "Unveraenderter Quellstand wurde nach Recovery nicht erneut persistiert");
  assert.equal(scoreLog.events[1].score, "5-4/0-0/0-0/15-0");
  assert.equal(courtPoller.getLastData().courts[0].satz1home, "5");
  contextActive = 0;
  courtPoller.setCourtActive({ "1": false, "2": false });
  const deactivatedEvent = logEvents.find(({ event, fields }) => event === "court_state_snapshot" && fields.reason === "deactivated");
  assert.equal(deactivatedEvent.fields.active, false);
});

test("persistiert aktiver Court uebernimmt nach Prozessstart den ersten Stand ohne ScoreLog", async (t) => {
  let score = "8";
  const scoreLog = scoreLogRecorder();
  const logEvents = [];
  const originalLog = logger.log;
  logger.log = (level, event, fields) => {
    logEvents.push({ level, event, fields });
    return true;
  };
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
  configure(fetchStub, scoreLog);
  t.after(async () => {
    logger.log = originalLog;
    courtPoller.setCourtActive({ "1": false, "2": false });
    await courtPoller.stop();
  });

  courtPoller.setCourtActive({ "1": true, "2": false }, { initial: true });
  await waitFor(
    () => courtPoller.getLastData().courts.find((entry) => entry.platz === "1")?.satz1home === "8",
    1200,
    "Erster Court-Stand wurde nach Prozessstart nicht uebernommen",
  );
  assert.equal(scoreLog.events.length, 0);
  const baselineEvent = logEvents.find(({ event, fields }) => event === "court_state_snapshot" && fields.reason === "startup_baseline");
  assert.equal(baselineEvent.fields.score, "8-5/0-0/0-0/30-15");
  assert.equal(logEvents.some(({ event }) => event === "score_logged"), false);

  score = "9";
  await waitFor(() => scoreLog.events.length === 1, 1200, "Folgeaenderung wurde nicht geloggt");
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

  configure(fetchStub, scoreLogRecorder());
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

test("Court-Fehler werden zusammengefasst, Recovery geloggt und erst nach Erfolgsalter stale", async (t) => {
  let calls = 0;
  let failAfterRecovery = false;
  const events = [];
  const originalLog = logger.log;
  logger.log = (level, event, fields) => {
    events.push({ level, event, fields });
    return true;
  };
  const fetchStub = async () => {
    calls++;
    if (calls <= 2 || failAfterRecovery) {
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    }
    return new Response(JSON.stringify({
      courts: [{
        platz: "1",
        satz1home: "1",
        satz1gast: "0",
        satz2home: "0",
        satz2gast: "0",
        satz3home: "0",
        satz3gast: "0",
        punktehome: "0",
        punktegast: "0",
      }],
    }), { status: 200 });
  };

  courtPoller.setCourtActive({ "1": false, "2": false });
  courtPoller.setDependenciesForTests({
    fetch: fetchStub,
    scoreLog: scoreLogRecorder(),
    courtContext: () => ({ matchId: "m1", aktiv: 1, revision: 1 }),
    summaryEvery: 2,
  });
  t.after(async () => {
    logger.log = originalLog;
    courtPoller.setDependenciesForTests({ summaryEvery: 10 });
    courtPoller.setCourtActive({ "1": false, "2": false });
    await courtPoller.stop();
  });
  courtPoller.setCourtActive({ "1": true, "2": false });

  await waitFor(
    () => events.some(({ event }) => event === "court_poll_recovered"),
    5000,
    "Court-Recovery wurde nicht protokolliert",
  );
  assert.equal(events.filter(({ event }) => event === "court_poll_failed").length, 1);
  assert.equal(events.filter(({ event }) => event === "court_poll_failure_summary").length, 1);
  assert.equal(events.filter(({ event }) => event === "court_poll_recovered").length, 1);

  failAfterRecovery = true;
  await waitFor(() => courtPoller.getStatus().lastError?.code === "ECONNRESET", 1200, "Court-Folgefehler blieb aus");
  const freshFailure = courtPoller.getLastData().source;
  assert.equal(freshFailure.stale, false);
  assert.equal(freshFailure.consecutiveFailures, 1);
  assert.equal(freshFailure.lastError.code, "ECONNRESET");

  const originalNow = Date.now;
  Date.now = () => freshFailure.lastSuccessAt + freshFailure.staleAfterMs + 1;
  try {
    assert.equal(courtPoller.getLastData().source.stale, true);
  } finally {
    Date.now = originalNow;
  }
});
