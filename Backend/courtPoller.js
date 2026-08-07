const crypto = require("crypto");
const {
  COURT_FETCH_TIMEOUT_MS,
  COURT_MAX_BACKOFF_MS,
  COURT_MAX_RESPONSE_BYTES,
  COURT_POLL_INTERVAL,
  COURT_URL,
  SCORE_LOG_JOURNAL,
} = require("./config.js");
const logger = require("./logger.js");

let fetchImplementation = globalThis.fetch;
let scoreLogRepository = null;
let getCourtContext = () => ({ matchId: "", aktiv: 1, revision: 0 });
let timer = null;
let controller = null;
let generation = 0;
let running = false;
let courtActive = { "1": false, "2": false };
const ZERO_SCORE = Object.freeze({
  satz1home: "0",
  satz1gast: "0",
  satz2home: "0",
  satz2gast: "0",
  satz3home: "0",
  satz3gast: "0",
  punktehome: "0",
  punktegast: "0",
});
let lastCourts = [
  { platz: "1", ...ZERO_SCORE },
  { platz: "2", ...ZERO_SCORE },
];
let lastCourtScores = {};
let courtEpoch = { "1": 0, "2": 0 };
let externalBaseline = { "1": null, "2": null };
let waitForExternalChange = { "1": false, "2": false };
let suppressNextScoreLog = { "1": false, "2": false };
let revision = 0;
let pollCount = 0;
let pushCount = 0;
let failureCount = 0;
let lastAttemptAt = 0;
let lastSuccessAt = 0;
let lastError = null;
let onUpdate = null;
let lastNotificationAt = 0;

function scoreString(court) {
  return `${court.satz1home}-${court.satz1gast}/${court.satz2home}-${court.satz2gast}/${court.satz3home}-${court.satz3gast}/${court.punktehome}-${court.punktegast}`;
}

function cleanScore(value) {
  const result = String(value ?? "0").trim();
  if (!result) return "0";
  if (/^\d+$/.test(result)) return String(Number(result));
  const normalized = result.toUpperCase();
  if (!/^(A|AD)$/.test(normalized)) throw new Error("Ungueltiger Scorewert");
  return normalized;
}

function normalizeData(data, requiredCourts = courtActive) {
  if (!data || typeof data !== "object" || !Array.isArray(data.courts)) throw new Error("courts-Array fehlt");
  const seen = new Set();
  const courts = data.courts.map((court) => {
    if (!court || typeof court !== "object") throw new Error("Ungueltiger Court-Eintrag");
    const platz = String(court.platz || "").trim();
    if (platz !== "1" && platz !== "2") throw new Error("Ungueltige Platznummer");
    if (seen.has(platz)) throw new Error("Doppelte Platznummer");
    seen.add(platz);
    return {
      platz,
      satz1home: cleanScore(court.satz1home),
      satz1gast: cleanScore(court.satz1gast),
      satz2home: cleanScore(court.satz2home),
      satz2gast: cleanScore(court.satz2gast),
      satz3home: cleanScore(court.satz3home),
      satz3gast: cleanScore(court.satz3gast),
      punktehome: cleanScore(court.punktehome),
      punktegast: cleanScore(court.punktegast),
    };
  }).sort((left, right) => left.platz.localeCompare(right.platz));
  for (const court of ["1", "2"]) {
    if (requiredCourts[court] && !seen.has(court)) throw new Error(`Aktiver Platz ${court} fehlt`);
  }
  return courts;
}

async function readBoundedText(response) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > COURT_MAX_RESPONSE_BYTES) throw new Error("Court-Antwort ist zu gross");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > COURT_MAX_RESPONSE_BYTES) throw new Error("Court-Antwort ist zu gross");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > COURT_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Court-Antwort ist zu gross");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function acceptCourtScores(courts, activeAtStart, epochAtStart) {
  let changed = false;
  const byCourt = new Map(lastCourts.map((court) => [court.platz, court]));
  for (const court of courts) {
    if (!activeAtStart[court.platz] || !courtActive[court.platz] || epochAtStart[court.platz] !== courtEpoch[court.platz]) continue;
    const current = scoreString(court);
    if (waitForExternalChange[court.platz]) {
      if (externalBaseline[court.platz] === null) {
        externalBaseline[court.platz] = current;
        continue;
      }
      if (externalBaseline[court.platz] === current) continue;
      waitForExternalChange[court.platz] = false;
      externalBaseline[court.platz] = null;
    }
    const previous = scoreString(byCourt.get(court.platz));
    const suppressLog = suppressNextScoreLog[court.platz];
    suppressNextScoreLog[court.platz] = false;
    if (previous === current) continue;
    if (!suppressLog) {
      try {
        if (!scoreLogRepository) throw new Error("ScoreLog-Repository ist nicht initialisiert");
        const context = getCourtContext(court.platz);
        const event = scoreLogRepository.append({
          eventId: crypto.randomUUID(),
          court: court.platz,
          score: current,
          matchId: context.matchId,
          courtActive: context.aktiv === 1 || context.aktiv === true,
          courtRevision: context.revision,
        });
        if (SCORE_LOG_JOURNAL) {
          logger.log("info", "score_logged", {
            eventId: event.eventId,
            court: event.court,
            sequence: event.sequence,
            score: event.score,
            matchId: event.matchId,
            courtRevision: event.courtRevision,
          });
        }
      } catch (error) {
        logger.log("error", "score_log_write_failed", { court: court.platz, error });
        continue;
      }
    }
    byCourt.set(court.platz, court);
    lastCourtScores[court.platz] = current;
    changed = true;
  }
  if (changed) lastCourts = [byCourt.get("1"), byCourt.get("2")];
  return changed;
}

function snapshot() {
  const now = Date.now();
  const staleAfterMs = Math.max(
    COURT_FETCH_TIMEOUT_MS + COURT_MAX_BACKOFF_MS,
    COURT_FETCH_TIMEOUT_MS + COURT_POLL_INTERVAL * 2,
    15000,
  );
  return {
    courts: structuredClone(lastCourts),
    revision,
    source: {
      active: running,
      lastAttemptAt,
      lastSuccessAt,
      ageMs: lastSuccessAt ? now - lastSuccessAt : null,
      stale: running && (!!lastError || !lastSuccessAt || now - lastSuccessAt > staleAfterMs),
      staleAfterMs,
      lastError,
    },
  };
}

function notify(changed) {
  if (!onUpdate) return;
  try {
    lastNotificationAt = Date.now();
    onUpdate(snapshot(), { changed });
  } catch (error) {
    logger.log("error", "court_update_callback_failed", { error });
  }
}

function schedule(myGeneration, delay) {
  if (!running || myGeneration !== generation) return;
  timer = setTimeout(() => poll(myGeneration), delay);
  timer.unref?.();
}

async function poll(myGeneration = generation) {
  if (!running || myGeneration !== generation) return;
  if (controller) {
    schedule(myGeneration, 50);
    return;
  }
  lastAttemptAt = Date.now();
  const activeAtStart = { ...courtActive };
  const epochAtStart = { ...courtEpoch };
  const localController = new AbortController();
  controller = localController;
  const timeout = setTimeout(() => localController.abort(new Error("Court-Fetch Timeout")), COURT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(COURT_URL, { cache: "no-store", signal: localController.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await readBoundedText(response);
    const courts = normalizeData(JSON.parse(text), activeAtStart);
    const changed = acceptCourtScores(courts, activeAtStart, epochAtStart);
    const recovered = failureCount > 0 || lastError !== null || lastSuccessAt === 0;
    pollCount++;
    failureCount = 0;
    lastSuccessAt = Date.now();
    lastError = null;
    if (changed) {
      revision++;
      pushCount++;
    }
    if (changed || recovered || Date.now() - lastNotificationAt >= 10000) notify(changed);
    schedule(myGeneration, COURT_POLL_INTERVAL);
  } catch (error) {
    if (myGeneration !== generation || !running) return;
    failureCount++;
    lastError = { at: Date.now(), message: String(error.message || error).slice(0, 300) };
    const backoff = Math.min(COURT_MAX_BACKOFF_MS, COURT_POLL_INTERVAL * (2 ** Math.min(failureCount, 5)));
    logger.log("warn", "court_poll_failed", { consecutiveFailures: failureCount, backoffMs: backoff, error });
    notify(false);
    const jitter = Math.floor(Math.random() * Math.max(1, backoff * 0.2));
    schedule(myGeneration, backoff + jitter);
  } finally {
    clearTimeout(timeout);
    if (controller === localController) controller = null;
  }
}

function updatePollingState() {
  const shouldRun = courtActive["1"] || courtActive["2"];
  if (shouldRun === running) return;
  generation++;
  if (timer) clearTimeout(timer);
  timer = null;
  if (controller) controller.abort(new Error("Court-Polling gestoppt"));
  running = shouldRun;
  failureCount = 0;
  if (running) {
    lastSuccessAt = 0;
    lastError = null;
    logger.log("info", "court_poller_started", { activeCourts: Object.entries(courtActive).filter(([, active]) => active).map(([court]) => court), intervalMs: COURT_POLL_INTERVAL });
    schedule(generation, 0);
  } else {
    logger.log("info", "court_poller_stopped", { pollCount, pushCount });
    notify(false);
  }
}

function setCourtActive(courts, { initial = false } = {}) {
  for (const court of ["1", "2"]) {
    if (courts[court] === undefined) continue;
    const active = courts[court] === true || courts[court] === 1;
    if (active !== courtActive[court]) {
      courtEpoch[court]++;
      externalBaseline[court] = null;
      waitForExternalChange[court] = active && !initial;
      suppressNextScoreLog[court] = active && initial;
    }
    courtActive[court] = active;
  }
  updatePollingState();
}

function resetCourtScore(court) {
  const courtKey = String(court);
  if (courtKey !== "1" && courtKey !== "2") throw new Error("Court muss 1 oder 2 sein");
  courtEpoch[courtKey]++;
  externalBaseline[courtKey] = null;
  waitForExternalChange[courtKey] = courtActive[courtKey];
  suppressNextScoreLog[courtKey] = false;
  const reset = { platz: courtKey, ...ZERO_SCORE };
  lastCourts = lastCourts.map((current) => current.platz === courtKey ? reset : current);
  lastCourtScores[courtKey] = scoreString(reset);
  revision++;
  pushCount++;
  notify(true);
  return structuredClone(reset);
}

function setOnUpdate(callback) {
  onUpdate = callback;
}

function getLastData() {
  return snapshot();
}

function getStatus() {
  return {
    running,
    courtActive: { ...courtActive },
    pollCount,
    pushCount,
    lastAttemptAt,
    lastSuccessAt,
    lastError,
    revision,
  };
}

async function stop() {
  generation++;
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  if (controller) controller.abort(new Error("Shutdown"));
}

function setDependenciesForTests({ fetch: nextFetch, scoreLog: nextScoreLog, courtContext } = {}) {
  if (nextFetch) fetchImplementation = nextFetch;
  if (nextScoreLog) scoreLogRepository = nextScoreLog;
  if (courtContext) getCourtContext = courtContext;
}

function configure({ scoreLog, courtContext }) {
  scoreLogRepository = scoreLog;
  getCourtContext = courtContext;
}

module.exports = {
  configure,
  getLastData,
  getStatus,
  poll,
  resetCourtScore,
  setCourtActive,
  setDependenciesForTests,
  setOnUpdate,
  stop,
  updatePollingState,
};
