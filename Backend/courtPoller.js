const { google } = require("googleapis");
const {
  COURT_FETCH_TIMEOUT_MS,
  COURT_MAX_BACKOFF_MS,
  COURT_MAX_RESPONSE_BYTES,
  COURT_POLL_INTERVAL,
  COURT_URL,
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

async function writeScoreLog(platz, score) {
  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "ScoreLog",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[timestamp(), platz, score]] },
    });
  } catch (error) {
    console.error("ScoreLog Fehler:", error.message);
  }
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
    byCourt.set(court.platz, court);
    lastCourtScores[court.platz] = current;
    if (!suppressLog) void writeScoreLog(court.platz, current);
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
    lastSuccessAt = 0;
    lastError = null;
    console.log("courtPoller: Polling gestartet");
    schedule(generation, 0);
  } else {
    console.log("courtPoller: Polling gestoppt");
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
  resetCourtScore,
  setCourtActive,
  setDependenciesForTests,
  setOnUpdate,
  stop,
  updatePollingState,
};
