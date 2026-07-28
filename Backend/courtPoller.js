const crypto = require("crypto");
const { google } = require("googleapis");
const {
  COURT_FETCH_TIMEOUT_MS,
  COURT_MAX_BACKOFF_MS,
  COURT_MAX_RESPONSE_BYTES,
  COURT_POLL_INTERVAL,
  COURT_URL,
  GOOGLE_REQUEST_TIMEOUT_MS,
  SHEET_ID,
} = require("./config.js");

let fetchImplementation = globalThis.fetch;
let sheetsClientFactory = null;
let sheetsClient = null;
let timer = null;
let controller = null;
let generation = 0;
let running = false;
let courtActive = { "1": false, "2": false };
let lastCourts = [];
let lastFingerprint = "";
let lastCourtScores = {};
let revision = 0;
let pollCount = 0;
let pushCount = 0;
let failureCount = 0;
let lastAttemptAt = 0;
let lastSuccessAt = 0;
let lastError = null;
let onUpdate = null;
let logQueue = Promise.resolve();
let pendingLogWrites = 0;
let failedLogWrites = [];
let scoreLogSuccessCount = 0;
let scoreLogRetryCount = 0;
let scoreLogFailureCount = 0;
let scoreLogDropCount = 0;
let lastScoreLogError = null;
let lastNotificationAt = 0;
let stopping = false;
let stateRepository = null;
const SCORELOG_FAILURES_STATE_KEY = "scorelog-failures";
const activeLogEventIds = new Set();

function persistFailedLogWrites() {
  if (!stateRepository?.status().open) return;
  const current = stateRepository.getState(SCORELOG_FAILURES_STATE_KEY, []);
  stateRepository.setState(SCORELOG_FAILURES_STATE_KEY, failedLogWrites, current.revision);
}

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (sheetsClientFactory) {
    sheetsClient = await sheetsClientFactory();
    return sheetsClient;
  }
  const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

function timestamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}-${values.hour}${values.minute}-${values.second}`;
}

function scoreString(court) {
  return `${court.satz1home}-${court.satz1gast}/${court.satz2home}-${court.satz2gast}/${court.satz3home}-${court.satz3gast}/${court.punktehome}-${court.punktegast}`;
}

function cleanScore(value) {
  const result = String(value ?? "0").trim();
  if (result.length > 20 || /[\x00-\x1f<>]/.test(result)) throw new Error("Ungueltiger Scorewert");
  if (!result) return "0";
  if (/^\d+$/.test(result)) return String(Number(result));
  return result.toUpperCase();
}

function normalizeData(data) {
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
    if (courtActive[court] && !seen.has(court)) throw new Error(`Aktiver Platz ${court} fehlt`);
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

async function appendScoreLog(item) {
  let lastFailure;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const sheets = await getSheetsClient();
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: "ScoreLog!D:D",
      }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
      if ((existing.data.values || []).some((row) => row[0] === item.eventId)) return;
      if (item.uncertain) {
        lastFailure ||= new Error("ScoreLog-Append ist noch nicht nachweisbar");
      } else {
        item.uncertain = true;
        item.uncertainSince = Date.now();
        persistFailedLogWrites();
        try {
          await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: "ScoreLog",
            valueInputOption: "RAW",
            requestBody: { values: [[timestamp(), item.platz, item.score, item.eventId]] },
          }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
          return;
        } catch (error) {
          const status = Number(error?.response?.status || error?.status || 0);
          if (status >= 400 && status < 500 && status !== 408) {
            item.uncertain = false;
            item.uncertainSince = 0;
            persistFailedLogWrites();
          }
          lastFailure = error;
        }
      }
    } catch (error) {
      lastFailure = error;
    }
    if (attempt < 3) {
      scoreLogRetryCount++;
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
    }
  }
  throw lastFailure || new Error("ScoreLog fehlgeschlagen");
}

function queueScoreLog(platz, score, eventId = crypto.randomUUID(), retainedItem = null) {
  const item = retainedItem || { platz, score, eventId, uncertain: false };
  if (!failedLogWrites.some((entry) => entry.eventId === item.eventId)) {
    if (failedLogWrites.length >= 100) {
      scoreLogDropCount++;
      lastScoreLogError = { at: Date.now(), message: "ScoreLog-Persistenzwarteschlange ist voll" };
      return false;
    }
    failedLogWrites.push(item);
    persistFailedLogWrites();
  }
  if (stopping || pendingLogWrites >= 100) {
    lastScoreLogError = { at: Date.now(), message: "ScoreLog-Warteschlange nicht verfuegbar" };
    console.error("courtPoller: ScoreLog zur spaeteren Verarbeitung behalten");
    return false;
  }
  if (activeLogEventIds.has(item.eventId)) return true;
  activeLogEventIds.add(item.eventId);
  pendingLogWrites++;
  logQueue = logQueue.catch(() => {}).then(async () => {
    try {
      await appendScoreLog(item);
      scoreLogSuccessCount++;
      lastScoreLogError = null;
      failedLogWrites = failedLogWrites.filter((entry) => entry.eventId !== item.eventId);
      persistFailedLogWrites();
    } catch (error) {
      scoreLogFailureCount++;
      lastScoreLogError = { at: Date.now(), message: String(error?.message || error).slice(0, 300), eventId: item.eventId };
      persistFailedLogWrites();
      console.error("courtPoller: ScoreLog endgueltig fehlgeschlagen:", lastScoreLogError.message);
    }
  }).finally(() => {
    pendingLogWrites--;
    activeLogEventIds.delete(item.eventId);
  });
  return true;
}

function retryFailedScoreLog() {
  if (!failedLogWrites.length || stopping || pendingLogWrites >= 100) return;
  const item = failedLogWrites.find((entry) => !activeLogEventIds.has(entry.eventId));
  if (item) queueScoreLog(item.platz, item.score, item.eventId, item);
}

function detectScoreChanges(courts) {
  for (const court of courts) {
    const current = scoreString(court);
    const previous = lastCourtScores[court.platz];
    lastCourtScores[court.platz] = current;
    if (previous !== undefined && previous !== current) queueScoreLog(court.platz, current);
  }
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
    console.error("courtPoller: Update-Callback fehlgeschlagen:", error.message);
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
  const localController = new AbortController();
  controller = localController;
  const timeout = setTimeout(() => localController.abort(new Error("Court-Fetch Timeout")), COURT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(COURT_URL, { cache: "no-store", signal: localController.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await readBoundedText(response);
    const courts = normalizeData(JSON.parse(text));
    const fingerprint = JSON.stringify(courts);
    const changed = fingerprint !== lastFingerprint;
    const recovered = failureCount > 0 || lastError !== null || lastSuccessAt === 0;
    pollCount++;
    failureCount = 0;
    lastSuccessAt = Date.now();
    lastError = null;
    if (changed) {
      detectScoreChanges(courts);
      lastCourts = courts;
      lastFingerprint = fingerprint;
      revision++;
      pushCount++;
    }
    retryFailedScoreLog();
    if (changed || recovered || Date.now() - lastNotificationAt >= 10000) notify(changed);
    schedule(myGeneration, COURT_POLL_INTERVAL);
  } catch (error) {
    if (myGeneration !== generation || !running) return;
    failureCount++;
    lastError = { at: Date.now(), message: String(error.message || error).slice(0, 300) };
    console.error("courtPoller: Poll-Fehler:", lastError.message);
    notify(false);
    const backoff = Math.min(COURT_MAX_BACKOFF_MS, COURT_POLL_INTERVAL * (2 ** Math.min(failureCount, 5)));
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
    stopping = false;
    lastSuccessAt = 0;
    lastError = null;
    console.log("courtPoller: Polling gestartet");
    schedule(generation, 0);
  } else {
    console.log("courtPoller: Polling gestoppt");
    notify(false);
  }
}

function setCourtActive(courts) {
  for (const court of ["1", "2"]) {
    if (courts[court] !== undefined) courtActive[court] = courts[court] === true || courts[court] === 1;
  }
  updatePollingState();
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
    pendingLogWrites,
    failedLogWrites: failedLogWrites.length,
    scoreLogSuccessCount,
    scoreLogRetryCount,
    scoreLogFailureCount,
    scoreLogDropCount,
    lastScoreLogError,
    scoreLogPending: failedLogWrites.map(({ eventId, platz, score, uncertain }) => ({ eventId, platz, score, uncertain })),
    lastAttemptAt,
    lastSuccessAt,
    lastError,
    revision,
  };
}

async function stop() {
  stopping = true;
  generation++;
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  if (controller) controller.abort(new Error("Shutdown"));
  await logQueue.catch(() => {});
  persistFailedLogWrites();
}

function setRepository(repository) {
  stateRepository = repository;
  if (!repository?.status().open) return;
  const persisted = repository.getState(SCORELOG_FAILURES_STATE_KEY, []).value;
  const known = new Set(failedLogWrites.map((item) => item.eventId));
  for (const item of Array.isArray(persisted) ? persisted : []) {
    if (item?.eventId && !known.has(item.eventId)) failedLogWrites.push(item);
  }
}

function setDependenciesForTests({ fetch: nextFetch, sheetsFactory } = {}) {
  if (nextFetch) fetchImplementation = nextFetch;
  if (sheetsFactory) {
    sheetsClientFactory = sheetsFactory;
    sheetsClient = null;
  }
}

module.exports = {
  getLastData,
  getStatus,
  poll,
  setCourtActive,
  setDependenciesForTests,
  setOnUpdate,
  setRepository,
  stop,
  updatePollingState,
};
