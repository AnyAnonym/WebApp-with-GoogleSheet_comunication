const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const FRONTEND_ROOT = path.resolve(__dirname, "../../Frontend");

const authStub = `
const role = new URLSearchParams(window.location.search).get("role");
const loginError = new URLSearchParams(window.location.search).get("loginError");
const user = role ? { id: role + "-1", role, login: role + "-login", email: role + "@example.test" } : null;
export const ready = Promise.resolve(user);
export const createPasswordReset = async () => ({ resetToken: "token" });
export const login = async () => {
  if (!loginError) return user;
  const error = new Error(loginError === "LOGIN_RATE_LIMIT" ? "Zu viele Anmeldeversuche" : "Login fehlgeschlagen");
  error.code = loginError;
  if (loginError === "LOGIN_RATE_LIMIT") error.details = { retryAfterMs: 610000 };
  throw error;
};
export const logout = async () => {};
export const changePassword = async () => ({ success: true });
export const getUser = () => user;
export const isAuthenticated = () => Boolean(user);
export const refreshSession = async () => user;
export const resetPassword = async () => ({ success: true });
export const setPasswordSetupAllowed = async () => ({ success: true });
export const setPasswordForPerson = async () => ({ success: true });
export const setupPassword = async () => ({ success: true });
export function subscribeAuth(callback) {
  queueMicrotask(() => callback(user, { status: user ? "authenticated" : "anonymous" }));
  return () => {};
}
`;

const dataClientStub = `
let messageRevision = 7;
let messages = [
  { messageId: "unread-new", createdAt: "2026-08-30T10:00:00.000Z", competitionName: "Sommercup", roundName: "Viertelfinale", subject: "Neue Platzinformation", eventType: "result", actorName: "Ergebnis Erfasser", acknowledged: false },
  { messageId: "unread-old", createdAt: "2026-08-29T08:30:00.000Z", competitionName: "Wintercup", roundName: "1. Gruppe", subject: "Turnierhinweis", eventType: "notice", actorName: "Turnierleitung", acknowledged: false },
  { messageId: "read-new", createdAt: "2026-08-31T11:00:00.000Z", competitionName: "", roundName: "", subject: "Bereits bestätigt", actorName: "System", acknowledged: true, acknowledgedAt: "2026-08-31T11:30:00.000Z" },
];
const messageBodies = {
  "unread-new": Array.from({ length: 80 }, (_, index) => "Lange Meldungszeile " + (index + 1)).join("\\n"),
  "unread-old": "Bitte den Turnierhinweis beachten.",
  "read-new": "Diese Meldung wurde bereits bestätigt.",
};
window.__acknowledgeCalls = [];
window.__matchDateCalls = [];
window.__adminRankingCalls = [];
window.__matchResultCalls = [];
window.__suggestionCalls = [];
window.__endpointCalls = [];
const operationIds = new Map();
export const getOperationId = (key) => {
  if (!operationIds.has(key)) operationIds.set(key, "operation-" + key);
  return operationIds.get(key);
};
export const releaseOperationId = () => {};
export const subscribeInvalidations = () => () => {};
export const subscribe = () => () => {};
const rankings = [
  { competitionId: "r1", competitionName: "Herren", competitionEndAt: 1, competitionEnded: false, rank: 1, status: "active", canChallenge: true, canWithdraw: true },
  { competitionId: "r2", competitionName: "Damen Doppel Lang", competitionEndAt: 2, competitionEnded: false, rank: 2, status: "active", canChallenge: false, canWithdraw: false, openChallenge: { matchId: "match-r2", direction: "challenger", opponentName: "Test Gegner", opponentRank: 5, challengedAt: "260829-1200", matchDate: "260905-1600" } },
  { competitionId: "r3", competitionName: "Senioren 45 Plus", competitionEndAt: 3, competitionEnded: false, rank: 3, status: "active", canChallenge: false, openChallenge: { matchId: "match-r3", direction: "challenged", opponentName: "Andere Gegnerin", opponentRank: 7, challengedAt: "260830-0900" } },
  { competitionId: "r4", competitionName: "Mixed Sommer", competitionEndAt: 4, competitionEnded: false, rank: 4, status: "active", canChallenge: false, canWithdraw: false, openChallenge: { matchId: "match-r4", direction: "challenger", opponentName: "Mixed Gegner", opponentRank: 2, challengedAt: "260828-1200" } },
  { competitionId: "r5", competitionName: "Wintercup", competitionEndAt: 20, competitionEnded: false, rank: 0, status: "withdrawn", canChallenge: false, withdrawal: { withdrawnAt: "260829-1230", reason: "Verletzt" } },
  { competitionId: "r6", competitionName: "Damen Herbst", competitionEndAt: 5, competitionEnded: false, rank: 5, status: "active", canChallenge: false, canWithdraw: false, openChallenge: { matchId: "match-r6", direction: "challenged", opponentName: "Herbst Gegnerin", opponentRank: 3, challengedAt: "260818-1200" } },
];
const profileRole = new URLSearchParams(window.location.search).get("role");
const defaultResultRules = { winningSets: 2, setTarget: 6, setTiebreak: "6-6", decidingSet: "vollstaendiger Satz" };
const competitions = [{
  competitionId: "r1", competitionName: "Herren", ranking: true, rankingMembers: [
    { personId: "player-1", name: "Own Player", rank: 1 },
    { personId: "p2", name: "Foreign Player", rank: 2 },
    { personId: "p3", name: "Withdrawn One", rank: 0 },
    { personId: "p4", name: "Withdrawn Two", rank: 0 },
  ], matches: [{
    matchId: "match-open", round: "G1", matchDate: "260903-1000", matchEnd: "", result: "",
    completionType: "regular", resultRules: defaultResultRules, teams: [{ ids: ["player-1", "partner-1"], names: ["Own Player", "Doubles Partner"] }, { ids: ["p2"], names: ["Foreign Player"] }],
    status: "open", fingerprint: "a".repeat(64), canSetResult: profileRole === "player", canAdminSetMatchEnd: false, canAdminClear: false,
  }, {
    matchId: "match-completed", round: "G2", matchDate: "260902-1000", matchEnd: "260902-1200", result: "6-4/2-1",
    completionType: "retirement", resultRules: defaultResultRules, losingSide: 2, teams: [{ ids: ["p2"], names: ["Foreign Player"], rankAtResult: 2 }, { ids: ["player-1"], names: ["Own Player"], rankAtResult: 0 }],
    status: "completed", fingerprint: "b".repeat(64), canSetResult: profileRole === "player", canAdminSetMatchEnd: false, canAdminClear: false,
  }, {
    matchId: "match-without-date", round: "", matchDate: "", matchEnd: "", result: "", completionType: "regular",
    resultRules: { winningSets: 3, setTarget: 6, setTiebreak: "6-6", decidingSet: "MT10" },
    teams: [{ ids: ["player-1"], names: ["Own Player"] }, { ids: ["p2"], names: ["Foreign Player"] }],
    status: "open", fingerprint: "e".repeat(64), canSetResult: profileRole === "player", canAdminSetMatchEnd: false, canAdminClear: false,
  }, {
    matchId: "match-bye", round: "R1-P1", matchDate: "", matchEnd: "", result: "", completionType: "regular", bye: true,
    teams: [{ ids: ["player-1"], names: ["Own Player"] }, { ids: [], names: [] }],
    status: "open", fingerprint: "9".repeat(64), canSetResult: false, canAdminSetMatchEnd: false, canAdminClear: false,
  }],
}, ...rankings.filter(({ openChallenge }) => openChallenge).map((ranking) => ({
  competitionId: ranking.competitionId,
  competitionName: ranking.competitionName,
  competitionEndAt: ranking.competitionEndAt,
  competitionEnded: false,
  ranking: true,
  matches: [{
    matchId: ranking.openChallenge.matchId,
    round: "F",
    matchDate: ranking.openChallenge.matchDate || "",
    challengeDate: ranking.openChallenge.challengedAt,
    matchEnd: "",
    result: "",
    completionType: "regular",
    resultRules: defaultResultRules,
    teams: [{ ids: ["player-1"], names: ["Own Player"] }, { ids: ["p2"], names: [ranking.openChallenge.opponentName] }],
    status: "open",
    fingerprint: ranking.competitionId.repeat(32).slice(0, 64),
    canSetResult: profileRole === "player" || profileRole === "admin",
    canSetMatchAppointment: profileRole === "player" || profileRole === "admin",
    canAdminSetMatchEnd: false,
    canAdminClear: false,
  }],
})), {
  competitionId: "cup", competitionName: "Sommercup", competitionEndAt: null, competitionEnded: false, matches: [{
    matchId: "cup-open", round: "HF-P2", matchDate: "260903-1100", matchEnd: "", result: "", completionType: "regular",
    teams: [{ ids: ["p2"], names: ["Foreign Player"] }, { ids: ["other"], names: ["Other Player"] }], status: "open",
    fingerprint: "c".repeat(64), canSetResult: profileRole === "admin", canSetMatchAppointment: profileRole === "admin", canAdminSetMatchEnd: false, canAdminClear: false,
  }, {
    matchId: "cup-completed", round: "F", matchDate: "260901-1000", matchEnd: "260901-1200", result: "6-2/6-2", completionType: "regular",
    teams: [{ ids: ["p2"], names: ["Foreign Player"] }, { ids: ["other"], names: ["Other Player"] }], status: "completed",
    fingerprint: "d".repeat(64), canSetResult: profileRole === "admin", canAdminSetMatchEnd: profileRole === "admin", canAdminClear: profileRole === "admin",
  }, {
    matchId: "cup-walkover", round: "VF", matchDate: "260902-1000", matchEnd: "260902-1000", result: "", completionType: "walkover", losingSide: 2,
    teams: [{ ids: ["p2"], names: ["Foreign Player"] }, { ids: ["other"], names: ["Other Player"] }], status: "completed",
    fingerprint: "7".repeat(64), canSetResult: false, canAdminSetMatchEnd: false, canAdminClear: false,
  }],
}, {
  competitionId: "archive-new", competitionName: "Archiv Neu", competitionEndAt: 30, competitionEnded: true, matches: [{
    matchId: "archive-new-open", round: "F", matchDate: "260801-1000", matchEnd: "", result: "", completionType: "regular",
    teams: [{ ids: ["p2"], names: ["Foreign Player"] }, { ids: ["other"], names: ["Other Player"] }], status: "open",
    fingerprint: "f".repeat(64), canSetResult: profileRole === "player", canAdminSetMatchEnd: false, canAdminClear: false,
  }],
}, {
  competitionId: "archive-old", competitionName: "Archiv Alt", competitionEndAt: 10, competitionEnded: true, matches: [{
    matchId: "archive-old-completed", round: "F", matchDate: "250801-1000", matchEnd: "250801-1200", result: "6-1/6-1", completionType: "regular",
    teams: [{ ids: ["p2"], names: ["Foreign Player"] }, { ids: ["other"], names: ["Other Player"] }], status: "completed",
    fingerprint: "0".repeat(64), canSetResult: profileRole === "player", canAdminSetMatchEnd: false, canAdminClear: false,
  }],
}];
export function createEndpoint(name) {
  return async (params = {}) => {
    window.__endpointCalls.push({ name, params: structuredClone(params) });
    const role = new URLSearchParams(window.location.search).get("role");
    const withdrawn = new URLSearchParams(window.location.search).get("withdrawn") === "1";
    const newcomer = new URLSearchParams(window.location.search).get("newcomer") === "1";
    const ineligible = new URLSearchParams(window.location.search).get("ineligible") === "1";
    const inactivePlayer = new URLSearchParams(window.location.search).get("inactivePlayer") === "1";
    const blockedTarget = new URLSearchParams(window.location.search).get("blockedTarget") === "1";
    const ownBusy = new URLSearchParams(window.location.search).get("ownBusy") === "1";
    const noNotifications = new URLSearchParams(window.location.search).get("noNotifications") === "1";
    const emptyProfile = new URLSearchParams(window.location.search).get("emptyProfile") === "1";
    if (name === "rlPlatzierung") return { data: { success: true, values: [
      ["BewerbID", "PersonID", "Rang"],
      ...Array.from({ length: 28 }, (_, index) => ["2", withdrawn || newcomer || ineligible ? "p" + (index + 1) : (index === 0 ? "player-1" : "p" + (index + 1)), String(index + 1)]),
      ...(withdrawn ? [["2", "player-1", "0"]] : []),
    ] } };
    if (name === "players") return { data: { success: true, values: [
      ["ID", "Vorname", "Nachname", "Aktiv"],
      ...Array.from({ length: 28 }, (_, index) => [withdrawn || newcomer || ineligible ? "p" + (index + 1) : (index === 0 ? "player-1" : "p" + (index + 1)), "Spieler" + (index + 1), "Mobil" + (index + 1), inactivePlayer && index === 27 ? "0" : "1"]),
    ] } };
    if (name === "preMatches") return { data: { success: true, values: [[
      "BewerbID", "Ergebnis", "Spieler1ID", "Spieler2ID", "Spieler3ID", "Spieler4ID",
    ], ...(ownBusy ? [["2", "", "player-1", "", "p2", ""]] : [])] } };
    if (name === "readMatchRestrictions") return { data: {
      success: true, complete: true, schonzeit: ownBusy ? [{ id: "player-1", until: "2099-01-01T00:00:00.000Z" }] : [],
      sperrzeit: blockedTarget ? [{ id: "p1", until: "2099-01-01T00:00:00.000Z" }] : [],
    } };
    if (name === "bewerbe") return { data: { success: true, values: [["ID", "Bezeichnung"], ["2", "Mobile Rangliste"]] } };
    if (name === "rankingChallengeState") return { data: { success: true,
      mode: ineligible ? "ineligible" : (newcomer ? "newcomer" : (withdrawn ? "returning" : "ranked")),
      rank: newcomer || withdrawn || ineligible ? null : 1,
      returnFromRank: withdrawn ? 4 : null,
    } };
    if (name === "withdrawnRankingPlayers") return { data: { success: true, competitionName: "Wintercup", players: [
      {
        personId: "p1", name: "Own Player", withdrawnAt: "260829-1230", previousRank: 4, reason: "Verletzt",
        returnChallenge: { challengedAt: "260830-1400", opponentName: "Test Gegner", opponentRank: 6 },
      },
      { personId: "p2", name: "Other Player", withdrawnAt: "260828-1100", previousRank: 7, reason: "Pause", returnChallenge: null },
    ] } };
    if (name === "myProfile") return { data: { success: true, profile: {
       id: role + "-1", firstName: "Own", lastName: "Player", login: role + "-login",
        email: "contact@example.test", phone: "", birthDate: "", notifications: noNotifications ? [] : ["Email", "Whatsapp"], competitions: emptyProfile ? [] : competitions.filter(({ competitionId }) => competitionId.startsWith("r")), rankings: emptyProfile ? [] : withdrawn ? [{
         competitionId: "2", competitionName: "Mobile Rangliste", rank: 0, status: "withdrawn",
         withdrawal: { withdrawnAt: "260829-1200", previousRank: 4, reason: "Pause" },
       }] : rankings,
     } } };
    if (name === "publicProfile") {
      const profileRankings = structuredClone(rankings);
      if (new URLSearchParams(window.location.search).get("dst") === "1") profileRankings[1].openChallenge.challengedAt = "270328-0237";
      return { data: { success: true, profile: {
        id: "p2", firstName: "Foreign", lastName: "Player",
        ...(role === "admin" ? { login: "foreign-login", passwordSetupAllowed: false } : {}),
        email: "directory@example.test", phone: "", birthDate: "", competitions, rankings: newcomer ? [{
          competitionId: "2", competitionName: "Mobile Rangliste", rank: 2, status: "active", canChallenge: true,
        }] : profileRankings,
      } } };
    }
    if (name === "myMessageSummary") return { data: {
      success: true,
      unreadCount: messages.filter((message) => !message.acknowledged).length,
      revision: messageRevision,
    } };
    if (name === "myMessages") return { data: {
      success: true,
      messages: messages.map(({ ...message }) => message),
      unreadCount: messages.filter((message) => !message.acknowledged).length,
      revision: messageRevision,
    } };
    if (name === "myMessage") {
      const message = messages.find((entry) => entry.messageId === params.messageId);
      return { data: { success: Boolean(message), message: message ? { ...message, body: messageBodies[message.messageId] } : null } };
    }
    if (name === "acknowledgeMessage") {
      window.__acknowledgeCalls.push({ ...params });
      messages = messages.map((message) => message.messageId === params.messageId
        ? { ...message, acknowledged: true, acknowledgedAt: "2026-08-31T12:00:00.000Z" }
        : message).sort((left, right) => {
          if (left.acknowledged !== right.acknowledged) return left.acknowledged ? 1 : -1;
          return new Date(right.createdAt) - new Date(left.createdAt);
        });
      messageRevision += 1;
      return { data: {
        success: true,
        unreadCount: messages.filter((message) => !message.acknowledged).length,
        revision: messageRevision,
      } };
    }
    if (name === "setMatchAppointment" || name === "adminSetMatchAppointment") {
      window.__matchDateCalls.push({ endpoint: name, ...params });
      return { data: { success: true, matchId: params.matchId, matchDate: params.matchDate } };
    }
    if (["adminDeleteRankingChallenge", "adminSetRankingChallengeDate"].includes(name)) {
      window.__adminRankingCalls.push({ endpoint: name, ...params });
      return { data: { success: true, matchId: params.matchId } };
    }
    if (name === "matchResultSuggestion") {
      window.__suggestionCalls.push({ ...params });
      if (params.court === "2" && new URLSearchParams(window.location.search).get("badSource") === "1") return { data: { success: true, matchId: params.matchId, suggestion: { result: "6-0/6-0", sets: ["6-0", "6-0"] }, source: { type: "unknown", court: "2" }, expectedFingerprint: "a".repeat(64) } };
      if (new URLSearchParams(window.location.search).get("noSuggestion") === "1") return { data: { success: true, matchId: params.matchId, suggestion: { result: "", sets: [] }, source: { type: "none", court: params.court }, expectedFingerprint: "a".repeat(64) } };
      if (params.court === "2" && new URLSearchParams(window.location.search).get("ambiguousSuggestion") === "1") return { data: { success: true, matchId: params.matchId, suggestion: { result: "6-0/6-0", sets: ["6-0", "6-0"] }, source: { type: "scoreLog", court: "2" }, expectedFingerprint: "a".repeat(64) } };
      if (params.court === "2") return { data: { success: true, matchId: params.matchId, suggestion: { result: "", sets: [] }, source: { type: "none", court: "2" }, expectedFingerprint: "a".repeat(64) } };
      return { data: { success: true, matchId: params.matchId, suggestion: { result: "6-3/6-4", sets: ["6-3", "6-4"] }, source: { type: "scoreLog", court: "1" }, expectedFingerprint: "a".repeat(64) } };
    }
    if (["setMatchResult", "adminSetMatchEnd", "adminClearMatchResult", "adminCorrectRankingResult"].includes(name)) {
      window.__matchResultCalls.push({ endpoint: name, ...params });
      return { data: { success: true, matchId: params.matchId, fingerprint: "e".repeat(64) } };
    }
    return { data: { success: true } };
  };
}
`;

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/modals-test.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/CSS/styles.css"></head><body><script type="module" src="/JS/modals-under-test.js"></script></body></html>');
      return;
    }
    if (pathname === "/ranking-test.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/CSS/styles.css"></head><body><main><section id="rankingSection" class="full-width-section"><h2>Rangliste</h2><div id="rankingContainer" class="pyramid"></div></section></main><script type="module" src="/JS/modals-under-test.js"></script><script type="module" src="/JS/rangliste-under-test.js"></script></body></html>');
      return;
    }
    if (pathname === "/messages-test.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/CSS/styles.css"></head><body><div id="header-container"></div><div id="mobile-nav-container"></div><script type="module" src="/JS/navbar-under-test.js"></script><script type="module" src="/JS/modals-under-test.js"></script></body></html>');
      return;
    }
    if (pathname === "/JS/modals-under-test.js") {
      const source = fs.readFileSync(path.join(FRONTEND_ROOT, "JS/modals.js"), "utf8")
        .replace('"./dataClient.js"', '"/test/dataClient.js"')
        .replace('"./authClient.js"', '"/test/authClient.js"')
        .replace('"./diagnostics.js"', '"/test/diagnostics.js"')
        .replace('"./profileModalState.js"', '"/test/profileModalState.js"');
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(source);
      return;
    }
    if (pathname === "/JS/rangliste-under-test.js") {
      const source = fs.readFileSync(path.join(FRONTEND_ROOT, "JS/rangliste.js"), "utf8")
        .replace('"./dataClient.js"', '"/test/dataClient.js"')
        .replace('"./authClient.js"', '"/test/authClient.js"')
        .replace('"./monitorReady.js"', '"/test/monitorReady.js"')
        .replace('"./diagnostics.js"', '"/test/diagnostics.js"')
        .replace('"./rankingMatchState.js"', '"/JS/rankingMatchState.js"');
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(source);
      return;
    }
    if (pathname === "/JS/navbar-under-test.js" || pathname === "/JS/navbar.js") {
      const source = fs.readFileSync(path.join(FRONTEND_ROOT, "JS/navbar.js"), "utf8")
        .replace('"./dataClient.js"', '"/test/dataClient.js"')
        .replace('"./authClient.js"', '"/test/authClient.js"');
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(source);
      return;
    }
    if (pathname === "/test/authClient.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(authStub);
      return;
    }
    if (pathname === "/test/dataClient.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(dataClientStub);
      return;
    }
    if (pathname === "/test/diagnostics.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end("export const diagnostic = { info() {}, warn() {}, error() {} };\n");
      return;
    }
    if (pathname === "/test/monitorReady.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end("export const signalMonitorReady = () => {}; export const signalMonitorFailed = () => {};\n");
      return;
    }
    if (pathname === "/test/profileModalState.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(fs.readFileSync(path.join(FRONTEND_ROOT, "JS/profileModalState.js"), "utf8"));
      return;
    }
    if (pathname === "/JS/authClient.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(authStub);
      return;
    }
    if (["/JS/staticReady.js", "/JS/modals.js", "/JS/global.js", "/JS/clock.js", "/JS/footer.js"].includes(pathname)) {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end();
      return;
    }
    const relative = pathname.replace(/^\/+/, "");
    const filePath = path.resolve(FRONTEND_ROOT, relative || "index.html");
    if (!filePath.startsWith(`${FRONTEND_ROOT}${path.sep}`) || !fs.existsSync(filePath)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": contentType(filePath) });
    response.end(fs.readFileSync(filePath));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("Mobile Navigation zeigt rollenabhaengige Links nur berechtigten Benutzern", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const cases = [
      { role: "", playersVisible: false, adminVisible: false },
      { role: "player", playersVisible: true, adminVisible: false },
      { role: "admin", playersVisible: true, adminVisible: true },
    ];
    for (const expected of cases) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      try {
        await page.goto(`http://127.0.0.1:${address.port}/index.html?role=${expected.role}`, { waitUntil: "domcontentloaded" });
        await page.locator("#hamburgerBtn").click();
        await page.locator("#mobileNavModal").waitFor({ state: "visible" });

        const players = page.locator('.mobile-nav-links [data-auth="required"]');
        const adminLinks = page.locator('.mobile-nav-links [data-role="admin"]');
        const serviceLink = page.locator('.mobile-nav-links a[href="servicebereich.html"]');
        assert.equal(await players.isVisible(), expected.playersVisible, `${expected.role || "anonymous"}: Spielerlink`);
        assert.equal(await serviceLink.isVisible(), expected.adminVisible, `${expected.role || "anonymous"}: Servicebereich`);
        for (const link of await adminLinks.all()) {
          assert.equal(await link.isVisible(), expected.adminVisible, `${expected.role || "anonymous"}: ${await link.textContent()}`);
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Anonyme direkte Profilaufrufe bleiben geschlossen und senden keinen Profilrequest", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/modals-test.html`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.openProfileModal({ playerId: "p2" }));
    assert.equal(await page.locator("#profileModal").isHidden(), true);
    assert.equal(await page.locator("#loginModal").isHidden(), true);
    assert.equal(await page.evaluate(() => window.__endpointCalls.some(({ name }) => name === "publicProfile")), false);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Leere aktuelle und archivierte Profilbewerbe bleiben erreichbar", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/modals-test.html?role=player&emptyProfile=1`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.openProfileModal());
    await page.getByRole("tab", { name: "Aktuell", exact: true }).click();
    assert.equal(await page.locator("#profileCurrentCompetitionsPanel").textContent(), "Keine Bewerbe enthalten");
    assert.equal(await page.locator("#profileCurrentCompetitionTabs").isHidden(), true);
    await page.getByRole("tab", { name: "Archiv", exact: true }).click();
    assert.equal(await page.locator("#profileArchiveCompetitionsPanel").textContent(), "Keine Bewerbe enthalten");
    assert.equal(await page.locator("#profileArchiveCompetitionTabs").isHidden(), true);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Loginfehler bleiben im mobilen Dialog sichtbar und nennen die Sperrdauer", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const cases = [
      { code: "LOGIN_FAILED", message: "Login oder Passwort ist ungültig." },
      { code: "LOGIN_RATE_LIMIT", message: "Zu viele Anmeldeversuche. Bitte in 11 Minuten erneut versuchen." },
    ];
    for (const expected of cases) {
      const context = await browser.newContext({ viewport: { width: 390, height: 600 } });
      const page = await context.newPage();
      try {
        await page.goto(`http://127.0.0.1:${address.port}/modals-test.html?loginError=${expected.code}`, { waitUntil: "domcontentloaded" });
        await page.evaluate(() => window.openLoginModal());
        await page.locator("#login").fill("mobile.login");
        await page.locator("#password").fill("wrong-password");
        await page.getByRole("button", { name: "Anmelden", exact: true }).click();

        const status = page.locator("#loginStatus");
        await status.waitFor({ state: "visible" });
        assert.equal(await status.textContent(), expected.message);
        assert.equal(await page.locator("#toastContainer .toast").count(), 0);
        const layout = await status.evaluate((element) => {
          const statusRect = element.getBoundingClientRect();
          const dialogRect = element.closest(".modal-content").getBoundingClientRect();
          return {
            statusTop: statusRect.top,
            statusBottom: statusRect.bottom,
            dialogTop: dialogRect.top,
            dialogBottom: dialogRect.bottom,
          };
        });
        assert.equal(layout.statusTop >= layout.dialogTop, true);
        assert.equal(layout.statusBottom <= layout.dialogBottom, true);

        if (expected.code === "LOGIN_FAILED") {
          await page.waitForTimeout(3200);
          assert.equal(await status.isVisible(), true);
          assert.equal(await status.textContent(), expected.message);
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Login- und Profilmodale trennen Login von Kontakt-E-Mail", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const playerPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await playerPage.addInitScript(() => {
      Date.now = () => new Date(2026, 8, 2, 12, 0).getTime();
    });
    await playerPage.goto(`http://127.0.0.1:${address.port}/modals-test.html?role=player`, { waitUntil: "domcontentloaded" });

    const loginInput = playerPage.locator("#login");
    assert.equal(await loginInput.getAttribute("type"), "text");
    assert.equal(await loginInput.getAttribute("autocomplete"), "username");
    assert.equal(await loginInput.getAttribute("inputmode"), null);
    assert.equal(await playerPage.locator('label[for="login"]').textContent(), "Login:");
    assert.equal(await playerPage.locator("#setupLogin").getAttribute("type"), "text");
    assert.equal(await playerPage.locator("#setupLogin").getAttribute("inputmode"), null);

    await playerPage.evaluate(() => window.openProfileModal());
    await playerPage.locator("#profileModal").waitFor({ state: "visible" });
    assert.match(await playerPage.locator("#profileText").textContent(), /Login: player-login/);
    assert.match(await playerPage.locator("#profileText").textContent(), /E-Mail: contact@example\.test/);
    assert.deepEqual(await playerPage.locator("#profileTabs [role=tab]").allTextContents(), [
      "System", "Meldungen (2)", "Aktuell", "Archiv",
    ]);
    assert.deepEqual(await playerPage.locator("#profileTabs [role=tab]").evaluateAll((tabs) => tabs.map((tab) => tab.tabIndex)), [0, 0, 0, 0]);
    assert.equal(await playerPage.locator("#profileCurrentCompetitionTabs").isHidden(), true);
    assert.equal(await playerPage.locator("#profileArchiveCompetitionTabs").isHidden(), true);
    assert.match(await playerPage.locator("#profileSystemPanel").textContent(), /Benachrichtigungen:\s*Email \| Whatsapp/);
    await playerPage.getByRole("tab", { name: "Aktuell", exact: true }).click();
    assert.deepEqual(await playerPage.locator("#profileCurrentCompetitionTabs [role=tab]").allTextContents(), [
      "Herren", "Damen Doppel Lang", "Senioren 45 Plus", "Mixed Sommer", "Damen Herbst",
    ]);
    await playerPage.getByRole("tab", { name: "Meldungen (2)", exact: true }).click();
    assert.equal(await playerPage.locator("#profileCurrentCompetitionTabs").isHidden(), true);
    await playerPage.getByRole("tab", { name: "Aktuell", exact: true }).click();
    await playerPage.getByRole("tab", { name: "Herren", exact: true }).click();
    assert.match(await playerPage.locator("#profileRankingPanel0").textContent(), /Ranglistenposition:\s*1/);
    const withdrawButton = playerPage.getByRole("button", { name: "Raushängen" });
    assert.equal(await withdrawButton.isDisabled(), false);
    await withdrawButton.click();
    assert.doesNotMatch(await playerPage.locator("#withdrawModal").textContent(), /Position wird freigegeben|Schonzeit|Sperrzeit/);
    assert.equal(await playerPage.getByRole("button", { name: "Verbindlich raushängen" }).isVisible(), true);
    await playerPage.locator("#withdrawModal .close").click();
    await playerPage.getByRole("tab", { name: "Damen Doppel Lang", exact: true }).click();
    assert.deepEqual(await playerPage.locator("#profileRankingPanel1 .profile-open-challenge > p").allTextContents(), [
      "Forderung vom 29.08.2026, 12:00 Uhr",
    ]);
    assert.deepEqual(await playerPage.locator("#profileRankingPanel1 .profile-actions > button").allTextContents(), []);
    assert.equal(await playerPage.getByRole("button", { name: "Raushängen" }).count(), 0);
    assert.deepEqual(await playerPage.locator("#profileRankingPanel1 .profile-match-actions > button").allTextContents(), [
      "Ergebnis eintragen", "Termin abändern",
    ]);
    await playerPage.locator("#profileRankingPanel1 .profile-match-actions").getByRole("button", { name: "Termin abändern" }).click();
    const changeDateDialog = playerPage.getByRole("dialog", { name: "Termin abändern" });
    assert.equal(await changeDateDialog.locator("#rankingMatchDay").inputValue(), "2026-09-05");
    assert.equal(await changeDateDialog.locator("select").inputValue(), "16");
    assert.equal(await changeDateDialog.locator("#matchDateCalendarMonth").textContent(), "September 2026");
    await changeDateDialog.getByRole("button", { name: "Nächster Monat" }).click();
    assert.equal(await changeDateDialog.locator("#matchDateCalendarMonth").textContent(), "Oktober 2026");
    assert.equal(await changeDateDialog.locator(".match-date-calendar-day").filter({ hasText: /^1$/ }).isDisabled(), false);
    await changeDateDialog.getByRole("button", { name: "Terminauswahl schließen" }).click();
    await playerPage.getByRole("tab", { name: "Senioren 45 Plus", exact: true }).click();
    const greenCountdown = playerPage.locator("#profileRankingPanel2 .profile-match-date-countdown");
    assert.match(await greenCountdown.textContent(), /^Terminfrist: -\d+ Tage, \d+ Stunden, \d+ Minuten$/);
    assert.equal(await greenCountdown.evaluate((element) => element.classList.contains("warning") || element.classList.contains("overdue")), false);
    assert.equal(await greenCountdown.evaluate((element) => getComputedStyle(element).color), "rgb(24, 114, 68)");
    assert.deepEqual(await playerPage.locator("#profileRankingPanel2 .profile-actions > button").allTextContents(), []);
    assert.deepEqual(await playerPage.locator("#profileRankingPanel2 .profile-match-actions > button").allTextContents(), [
      "Ergebnis eintragen", "Termin eintragen",
    ]);
    await playerPage.locator("#profileRankingPanel2 .profile-match-actions").getByRole("button", { name: "Termin eintragen" }).click();
    const matchDateDialog = playerPage.getByRole("dialog", { name: "Termin eintragen" });
    assert.equal(await matchDateDialog.locator("#matchDateReasonFields").isHidden(), true);
    assert.equal(await matchDateDialog.isVisible(), true);
    assert.equal(await matchDateDialog.locator("#matchDateCalendarMonth").textContent(), "August 2026");
    const challengeDay = matchDateDialog.locator(".match-date-calendar-day.challenge-start");
    assert.equal(await challengeDay.textContent(), "30");
    assert.equal(await challengeDay.isDisabled(), false);
    await matchDateDialog.getByRole("button", { name: "Nächster Monat" }).click();
    assert.equal(await matchDateDialog.locator("#matchDateCalendarMonth").textContent(), "September 2026");
    const finalDay = matchDateDialog.locator(".match-date-calendar-day.challenge-end");
    assert.equal(await finalDay.textContent(), "13");
    assert.equal(await finalDay.isDisabled(), false);
    assert.equal(await matchDateDialog.locator(".match-date-calendar-day").filter({ hasText: /^14$/ }).isDisabled(), true);
    assert.deepEqual(await matchDateDialog.locator("select option").allTextContents(), Array.from({ length: 18 }, (_, index) => `${String(index + 6).padStart(2, "0")}:00 Uhr`));
    const selectableMiddleDay = matchDateDialog.locator(".match-date-calendar-day").filter({ hasText: /^5$/ });
    assert.equal(await selectableMiddleDay.evaluate((element) => element.classList.contains("in-window")), true);
    await selectableMiddleDay.click();
    assert.equal(await matchDateDialog.locator("#rankingMatchDay").inputValue(), "2026-09-05");
    await matchDateDialog.locator("select").selectOption("18");
    await matchDateDialog.getByRole("button", { name: "Übernehmen" }).click();
    await playerPage.waitForFunction(() => window.__matchDateCalls.length === 1);
    assert.deepEqual(await playerPage.evaluate(() => window.__matchDateCalls[0]), {
      endpoint: "setMatchAppointment",
      operationId: "operation-match:appointment:match-r3:260905-1800:",
      matchId: "match-r3",
      matchDate: "260905-1800",
    });
    assert.equal(await matchDateDialog.isVisible(), false);
    await playerPage.waitForFunction(() => document.querySelector("#profileName")?.textContent === "Own Player");
    await playerPage.getByRole("tab", { name: "Mixed Sommer", exact: true }).click();
    assert.deepEqual(await playerPage.locator("#profileRankingPanel3 .profile-actions > button").allTextContents(), []);
    assert.deepEqual(await playerPage.locator("#profileRankingPanel3 .profile-match-actions > button").allTextContents(), [
      "Ergebnis eintragen", "Termin eintragen",
    ]);
    const orangeCountdown = playerPage.locator("#profileRankingPanel3 .profile-match-date-countdown");
    assert.equal(await orangeCountdown.textContent(), "Terminfrist: -2 Tage, 0 Stunden, 0 Minuten");
    assert.equal(await orangeCountdown.evaluate((element) => element.classList.contains("warning")), true);
    assert.equal(await orangeCountdown.evaluate((element) => getComputedStyle(element).color), "rgb(180, 83, 9)");
    await playerPage.getByRole("tab", { name: "Damen Herbst", exact: true }).click();
    const redCountdown = playerPage.locator("#profileRankingPanel4 .profile-match-date-countdown");
    assert.equal(await redCountdown.textContent(), "Terminfrist: +8 Tage, 0 Stunden, 0 Minuten");
    assert.equal(await redCountdown.evaluate((element) => element.classList.contains("overdue")), true);
    assert.equal(await redCountdown.evaluate((element) => getComputedStyle(element).color), "rgb(180, 35, 24)");
    await playerPage.getByRole("tab", { name: "Archiv", exact: true }).click();
    assert.deepEqual(await playerPage.locator("#profileArchiveCompetitionTabs [role=tab]").allTextContents(), ["Wintercup"]);
    await playerPage.getByRole("tab", { name: "Wintercup" }).click();
    assert.doesNotMatch(await playerPage.locator("#profileRankingPanel5").textContent(), /Ranglistenposition:\s*0/);
    assert.match(await playerPage.locator("#profileRankingPanel5").textContent(), /Rausgehängt am:\s*29\.08\.2026, 12:30 Uhr/);
    assert.match(await playerPage.locator("#profileRankingPanel5").textContent(), /Grund:\s*Verletzt/);
    await playerPage.getByRole("tab", { name: "Aktuell", exact: true }).click();
    assert.equal(await playerPage.getByRole("tab", { name: "Damen Herbst", exact: true }).getAttribute("aria-selected"), "true");
    const ownTabMetrics = await playerPage.locator("#profileCurrentCompetitionTabs").evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    assert.equal(ownTabMetrics.scrollWidth > ownTabMetrics.clientWidth, true);
    await playerPage.getByRole("tab", { name: "System" }).click();
    assert.equal(await playerPage.locator("#profileCurrentCompetitionTabs").isHidden(), true);
    assert.equal(await playerPage.locator("#profileArchiveCompetitionTabs").isHidden(), true);
    await playerPage.getByRole("button", { name: "Passwort ändern" }).click();
    assert.equal(await playerPage.locator("#changePasswordUsername").inputValue(), "player-login");

    await playerPage.evaluate(() => window.openProfileModal({ playerId: "p2" }));
    await playerPage.locator("#profileModal").waitFor({ state: "visible" });
    assert.doesNotMatch(await playerPage.locator("#profileText").textContent(), /Login:/);
    assert.match(await playerPage.locator("#profileText").textContent(), /E-Mail: directory@example\.test/);
    assert.equal(await playerPage.getByRole("tab", { name: /Meldungen/ }).count(), 0);
    await playerPage.getByRole("tab", { name: "Aktuell", exact: true }).click();
    assert.deepEqual(await playerPage.locator("#profileCurrentCompetitionTabs [role=tab]").allTextContents(), [
      "Herren", "Damen Doppel Lang", "Senioren 45 Plus", "Mixed Sommer", "Damen Herbst", "Sommercup",
    ]);
    await playerPage.getByRole("tab", { name: "Herren", exact: true }).click();
    assert.match(await playerPage.locator("#profileRankingPanel0").textContent(), /Ranglistenposition:\s*1/);
    assert.equal(await playerPage.getByRole("button", { name: "Fordern" }).isVisible(), true);
    await playerPage.getByRole("tab", { name: "Damen Doppel Lang", exact: true }).click();
    assert.deepEqual(await playerPage.locator("#profileRankingPanel1 .profile-open-challenge > p").allTextContents(), [
      "Forderung vom 29.08.2026, 12:00 Uhr",
    ]);
    assert.equal(await playerPage.locator("#profileRankingPanel1 .admin-ranking-danger").count(), 0);
    assert.doesNotMatch(await playerPage.locator("#profileRankingPanel1").textContent(), /Keine Aktion verfügbar/i);
    await playerPage.getByRole("tab", { name: "Senioren 45 Plus", exact: true }).click();
    assert.deepEqual(await playerPage.locator("#profileRankingPanel2 .profile-open-challenge > p").allTextContents(), [
      "Forderung vom 30.08.2026, 09:00 Uhr",
    ]);
    assert.doesNotMatch(await playerPage.locator("#profileRankingPanel2").textContent(), /Spieltermin/);
    await playerPage.getByRole("tab", { name: "Sommercup", exact: true }).click();
    assert.deepEqual(await playerPage.locator('[data-competition-id="cup"] .profile-match-card h3').allTextContents(), [
      "Halbfinale (03.09.2026, 11:00 Uhr)",
      "Finale (01.09.2026, 10:00 Uhr)",
      "Viertelfinale (02.09.2026, 10:00 Uhr)",
    ]);
    assert.equal(await playerPage.locator('[data-match-id="cup-walkover"] .profile-match-status').textContent(), "Foreign Player gewinnt durch W.O. von Other Player.");
    await playerPage.getByRole("tab", { name: "Archiv", exact: true }).click();
    assert.deepEqual(await playerPage.locator("#profileArchiveCompetitionTabs [role=tab]").allTextContents(), ["Archiv Neu", "Wintercup", "Archiv Alt"]);
    await playerPage.getByRole("tab", { name: "Archiv Neu", exact: true }).click();
    assert.equal(await playerPage.locator('[data-match-id="archive-new-open"]').getByRole("button", { name: "Ergebnis eintragen" }).isVisible(), true);
    await playerPage.keyboard.press("Escape");
    assert.equal(await playerPage.locator("#profileModal").isHidden(), true);
    await playerPage.evaluate(() => window.openWithdrawnRankingPlayers("r5"));
    await playerPage.locator("#withdrawnPlayersModal").waitFor({ state: "visible" });
    assert.equal(await playerPage.locator("#withdrawnPlayersTitle").innerText(), "Rausgehängt aus\nWintercup");
    const withdrawnEntries = playerPage.locator("#withdrawnPlayersBody .withdrawn-player");
    assert.equal(await withdrawnEntries.count(), 2);
    assert.deepEqual(await withdrawnEntries.nth(0).locator(":scope > *").allTextContents(), [
      "Own Player",
      "Datum: 29.08.2026, 12:30 Uhr",
      "Position: 4",
      "Grund: Verletzt",
      "Eingefordert am 30.08.2026, 14:00 Uhr gegen Test Gegner (Position 6)",
    ]);
    assert.deepEqual(await withdrawnEntries.nth(1).locator(":scope > *").allTextContents(), [
      "Other Player",
      "Datum: 28.08.2026, 11:00 Uhr",
      "Position: 7",
      "Grund: Pause",
    ]);
    assert.deepEqual(await withdrawnEntries.nth(0).locator(":scope > span, :scope > p").evaluateAll((lines) => (
      lines.map((line) => {
        const style = getComputedStyle(line);
        return { color: style.color, fontSize: style.fontSize };
      })
    )), Array.from({ length: 4 }, () => ({ color: "rgb(85, 85, 85)", fontSize: "14.4px" })));
    await playerPage.keyboard.press("Escape");
    await playerPage.close();

    const adminPage = await browser.newPage({ viewport: { width: 320, height: 240 } });
    await adminPage.goto(`http://127.0.0.1:${address.port}/modals-test.html?role=admin`, { waitUntil: "domcontentloaded" });
    await adminPage.evaluate(() => window.openProfileModal({ playerId: "p2" }));
    await adminPage.locator("#profileModal").waitFor({ state: "visible" });
    assert.match(await adminPage.locator("#profileText").textContent(), /Login: foreign-login/);
    assert.equal(await adminPage.getByRole("tab", { name: "Admin" }).isVisible(), true);
    await adminPage.getByRole("tab", { name: "Admin" }).click();
    assert.equal(await adminPage.getByRole("button", { name: "Reset-Code erstellen" }).isVisible(), true);
    const layout = await adminPage.locator("#profileModal .profile-dialog").evaluate((dialog) => {
      const rect = dialog.getBoundingClientRect();
      const body = dialog.querySelector(".profile-body");
      return {
        top: rect.top,
        bottom: window.innerHeight - rect.bottom,
        bodyScrollable: body.scrollHeight > body.clientHeight,
        pageLocked: getComputedStyle(document.body).overflow === "hidden",
      };
    });
    assert.equal(layout.top >= 19, true);
    assert.equal(layout.bottom >= 19, true);
    assert.equal(layout.bodyScrollable, true);
    assert.equal(layout.pageLocked, true);
    await adminPage.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Profilbewerbe werden zusammengefuehrt und Teilnehmer erfassen Ergebnisse im Kinddialog", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 45000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const anonymousPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await anonymousPage.goto(`http://127.0.0.1:${address.port}/ranking-test.html?id=2`, { waitUntil: "domcontentloaded" });
    const anonymousBox = anonymousPage.locator("#rankingContainer .box").first();
    await anonymousBox.waitFor({ state: "visible" });
    assert.equal(await anonymousPage.locator("#rankingContainer .box.profile-openable").count(), 0);
    assert.equal(await anonymousBox.getAttribute("role"), null);
    assert.equal(await anonymousBox.evaluate((box) => getComputedStyle(box).cursor), "default");
    await anonymousBox.click();
    assert.equal(await anonymousPage.locator("#profileModal").isHidden(), true);
    assert.equal(await anonymousPage.evaluate(() => window.__endpointCalls.some(({ name }) => name === "publicProfile")), false);
    await anonymousPage.close();

    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${address.port}/modals-test.html?role=player`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.openProfileModal({ playerId: "p2" }));
    await page.getByRole("tab", { name: "Aktuell", exact: true }).click();
    assert.equal(await page.getByRole("tab", { name: "Herren", exact: true }).count(), 1);
    assert.equal(await page.getByRole("tab", { name: "Sommercup", exact: true }).count(), 1);
    await page.getByRole("tab", { name: "Herren", exact: true }).click();
    const panel = page.locator('[data-competition-id="r1"]');
    assert.equal(await panel.locator(".profile-match-card").count(), 4);
    assert.deepEqual(await panel.locator(".profile-match-card h3").allTextContents(), [
      "1. Gruppe (03.09.2026, 10:00 Uhr)",
      "2. Gruppe (02.09.2026, 10:00 Uhr)",
      "Match (noch kein Termin festgelegt)",
      "Erste Runde (ohne Datum)",
    ]);
    assert.equal(await panel.locator('[data-match-id="match-open"] .profile-match-status').count(), 0);
    assert.equal(await panel.locator('[data-match-id="match-without-date"] .profile-match-status').count(), 0);
    assert.equal(await panel.locator('[data-match-id="match-completed"] .profile-match-status').textContent(), "Aufgabe durch Own Player: 6-4/2-1");
    assert.equal(await panel.locator('[data-match-id="match-completed"] .profile-match-teams').textContent(), "Foreign Player (2) gegen Own Player (0)");
    assert.equal(await panel.locator('[data-match-id="match-open"] .profile-match-teams').textContent(), "Own Player / Doubles Partner gegen Foreign Player");
    assert.equal(await panel.locator('[data-match-id="match-bye"] .profile-match-teams').textContent(), "Freilos für Own Player");
    assert.equal(await panel.locator('[data-match-id="match-bye"] .profile-match-actions > button').count(), 0);
    assert.deepEqual(await panel.locator('[data-match-id="match-open"] h3').evaluate((heading) => {
      const date = heading.querySelector(".profile-match-date");
      const team = heading.nextElementSibling;
      return {
        sameFontSize: getComputedStyle(team).fontSize === getComputedStyle(date).fontSize,
        dateFontWeight: getComputedStyle(date).fontWeight,
        headingMarginBottom: getComputedStyle(heading).marginBottom,
        teamMarginBottom: getComputedStyle(heading.nextElementSibling).marginBottom,
      };
    }), {
      sameFontSize: true,
      dateFontWeight: "400",
      headingMarginBottom: "4px",
      teamMarginBottom: "4px",
    });
    const resultButton = panel.locator('[data-match-id="match-open"]').getByRole("button", { name: "Ergebnis eintragen", exact: true });
    assert.equal(await panel.getByRole("button", { name: "Ergebnis eintragen", exact: true }).count(), 2);
    assert.equal(await resultButton.evaluate((button) => button.classList.contains("admin-danger")), false);
    await resultButton.click();
    const dialog = page.getByRole("dialog", { name: "Ergebnis erfassen" });
    assert.equal(await page.locator("#profileModal").getAttribute("inert"), "");
    assert.equal(await dialog.locator("#matchResultCompetition").textContent(), "Herren");
    assert.equal(await dialog.locator("#matchResultEncounter").textContent(), "Own Player / Doubles Partner gegen Foreign Player");
    assert.equal(await dialog.locator("#matchResultTarget").evaluate((target) => getComputedStyle(target).textAlign), "center");
    assert.equal(await dialog.locator("#matchResultStart").getAttribute("required"), "");
    assert.equal(await dialog.locator("#matchResultStart").inputValue(), "2026-09-03T10:00");
    assert.equal(await dialog.locator("#matchResultEnd").getAttribute("required"), "");
    assert.deepEqual(await dialog.locator(".match-result-score-column > h3").allTextContents(), ["Set 1", "Set 2", "Set 3"]);
    assert.equal(await dialog.locator('input[name="result"]').count(), 0);
    assert.deepEqual(await dialog.locator(".match-result-field-row").evaluateAll((rows) => rows.slice(0, 3).map((row) => {
      const label = row.querySelector("label").getBoundingClientRect();
      const control = row.querySelector("input, select").getBoundingClientRect();
      return Math.abs((label.top + label.height / 2) - (control.top + control.height / 2)) < 2;
    })), [true, true, true]);
    const stepSize = await dialog.locator(".match-result-score-step").first().evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    assert.equal(stepSize.width, stepSize.height);
    assert.equal(stepSize.width >= 44, true);
    await dialog.getByRole("button", { name: "Ergebnis speichern", exact: true }).click();
    assert.match(await dialog.locator("#matchResultStatus").textContent(), /vollständiges Ergebnis/);
    assert.equal(await page.evaluate(() => window.__matchResultCalls.length), 0);
    await dialog.locator("#matchResultKind").selectOption("walkover");
    assert.equal(await dialog.locator("#matchResultStartFields").isHidden(), true);
    assert.equal(await dialog.locator("#matchResultEndFields").isHidden(), true);
    assert.equal(await dialog.locator("#matchResultStart").isDisabled(), true);
    assert.equal(await dialog.locator("#matchResultEnd").isDisabled(), true);
    assert.deepEqual(await dialog.locator("#matchResultLosingSide option").allTextContents(), [
      "Bitte Verliererseite auswählen", "Own Player / Doubles Partner", "Foreign Player",
    ]);
    assert.equal(await dialog.locator("#matchResultLosingSide").inputValue(), "");
    assert.equal(await dialog.locator("#matchResultLosingSide").getAttribute("required"), "");
    await dialog.locator("#matchResultLosingSide").selectOption("2");
    await dialog.locator("#matchResultKind").selectOption("regular");
    assert.equal(await dialog.locator("#matchResultStart").inputValue(), "2026-09-03T10:00");
    assert.equal(await dialog.locator("#matchResultStart").getAttribute("readonly"), null);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.closest("#matchResultModal")?.id), "matchResultModal");
    const scoreboardButton = dialog.getByRole("button", { name: "Match vom Scoreboard übernehmen", exact: true });
    await scoreboardButton.click();
    assert.deepEqual(await dialog.locator(".match-result-score-row > input").evaluateAll((inputs) => inputs.map((input) => Number(input.value))), [6, 3, 6, 4, 0, 0]);
    assert.deepEqual(await page.evaluate(() => window.__suggestionCalls), [
      { matchId: "match-open", court: "1" }, { matchId: "match-open", court: "2" },
    ]);
    assert.equal(await page.evaluate(() => window.__matchResultCalls.length), 0);
    await page.evaluate(() => history.replaceState(null, "", `${location.pathname}?role=player&noSuggestion=1`));
    await scoreboardButton.click();
    assert.match(await dialog.locator("#matchResultStatus").textContent(), /kein Ergebnis verfügbar/);
    assert.equal(await dialog.locator("#matchResultStatus").evaluate((status) => getComputedStyle(status).position), "absolute");
    await page.waitForTimeout(3100);
    assert.equal(await dialog.locator("#matchResultStatus").isHidden(), true);
    await page.evaluate(() => history.replaceState(null, "", `${location.pathname}?role=player&ambiguousSuggestion=1`));
    await scoreboardButton.click();
    assert.match(await dialog.locator("#matchResultStatus").textContent(), /Platz 1 und Platz 2 gefunden/);
    await page.evaluate(() => history.replaceState(null, "", `${location.pathname}?role=player&badSource=1`));
    await scoreboardButton.click();
    assert.match(await dialog.locator("#matchResultStatus").textContent(), /unbekannten Quelle/);
    const firstSetBottom = dialog.getByLabel("Set 1, Foreign Player", { exact: true });
    await firstSetBottom.fill("6");
    await firstSetBottom.blur();
    await dialog.getByRole("button", { name: "Set 1, Own Player / Doubles Partner: Plus", exact: true }).click();
    assert.deepEqual(await dialog.locator(".match-result-score-column > h3").allTextContents(), ["Set 1", "TB", "Set 2", "Set 3"]);
    const tieBreakTop = dialog.getByLabel("Tie-Break in Set 1, Own Player / Doubles Partner", { exact: true });
    await tieBreakTop.fill("7");
    await tieBreakTop.blur();
    const tieBreakBottom = dialog.getByLabel("Tie-Break in Set 1, Foreign Player", { exact: true });
    await tieBreakBottom.fill("5");
    await tieBreakBottom.blur();
    await dialog.locator("#matchResultEnd").fill("2026-09-03T12:00");
    await dialog.getByRole("button", { name: "Ergebnis speichern", exact: true }).click();
    await page.waitForFunction(() => window.__matchResultCalls.length === 1);
    const initial = await page.evaluate(() => window.__matchResultCalls[0]);
    assert.deepEqual(initial, {
      endpoint: "setMatchResult", matchId: "match-open", expectedFingerprint: "a".repeat(64), kind: "regular",
      result: "7-6(5)/6-4", matchStart: "260903-1000", matchEnd: "260903-1200",
      operationId: initial.operationId,
    });
    assert.match(initial.operationId, /^operation-match-result:result:match-open:/);
    assert.equal(await page.locator("#profileModal").getAttribute("inert"), null);

    await page.getByRole("tab", { name: "Herren", exact: true }).click();
    const beforeUndatedDialog = Date.now();
    await page.locator('[data-match-id="match-without-date"]').getByRole("button", { name: "Ergebnis eintragen", exact: true }).click();
    assert.deepEqual(await page.locator("#matchResultScoreEditor .match-result-score-column > h3").allTextContents(), ["Set 1", "Set 2", "Set 3", "Set 4", "Set 5"]);
    assert.equal(await page.locator("#matchResultScoreEditor .match-result-score-column").nth(4).evaluate((column) => column.classList.contains("match-tiebreak")), true);
    const undatedStart = await page.locator("#matchResultStart").inputValue();
    const parsedUndatedStart = new Date(undatedStart).getTime();
    assert.equal(parsedUndatedStart >= beforeUndatedDialog - 91 * 60 * 1000 && parsedUndatedStart <= Date.now() - 89 * 60 * 1000, true);
    await page.getByRole("button", { name: "Ergebnisdialog abbrechen" }).click();

    await page.getByRole("tab", { name: "Herren", exact: true }).click();
    await page.locator('[data-match-id="match-completed"]').getByRole("button", { name: "Ergebnis korrigieren" }).click();
    const correction = page.getByRole("dialog", { name: "Ergebnis korrigieren" });
    assert.equal(await correction.locator("#matchResultStartFields").isHidden(), true);
    assert.equal(await correction.locator("#matchResultEndFields").isHidden(), true);
    assert.equal(await correction.locator("#matchResultLosingSide").inputValue(), "2");
    assert.deepEqual(await correction.locator("#matchResultLosingSide option").allTextContents(), [
      "Bitte Verliererseite auswählen", "Foreign Player", "Own Player",
    ]);
    await correction.locator("#matchResultKind").selectOption("regular");
    for (const [label, value] of [["Set 1, Foreign Player", "6"], ["Set 1, Own Player", "3"], ["Set 2, Foreign Player", "6"], ["Set 2, Own Player", "3"]]) {
      const input = correction.getByLabel(label, { exact: true });
      await input.fill(value);
      await input.blur();
    }
    await correction.getByRole("button", { name: "Ergebnis korrigieren" }).click();
    await page.waitForFunction(() => window.__matchResultCalls.length === 2);
    const corrected = await page.evaluate(() => window.__matchResultCalls[1]);
    assert.equal(Object.hasOwn(corrected, "matchEnd"), false);
    assert.equal(corrected.expectedFingerprint, "b".repeat(64));

    await page.getByRole("tab", { name: "Herren", exact: true }).click();
    await page.locator('[data-match-id="match-without-date"]').getByRole("button", { name: "Ergebnis eintragen", exact: true }).click();
    const walkoverDialog = page.getByRole("dialog", { name: "Ergebnis erfassen" });
    await walkoverDialog.locator("#matchResultKind").selectOption("walkover");
    await walkoverDialog.locator("#matchResultLosingSide").selectOption("1");
    await walkoverDialog.getByRole("button", { name: "Ergebnis speichern", exact: true }).click();
    await page.waitForFunction(() => window.__matchResultCalls.length === 3);
    const walkoverRequest = await page.evaluate(() => window.__matchResultCalls[2]);
    assert.equal(walkoverRequest.kind, "walkover");
    assert.equal(walkoverRequest.losingSide, 1);
    assert.equal(Object.hasOwn(walkoverRequest, "matchStart"), false);
    assert.equal(Object.hasOwn(walkoverRequest, "matchEnd"), false);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Admins sehen statt Teilnehmeraktionen rote Ergebnis- und Korrekturaktionen", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${address.port}/modals-test.html?role=admin`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.openProfileModal({ playerId: "p2" }));
    await page.getByRole("tab", { name: "Aktuell", exact: true }).click();
    await page.getByRole("tab", { name: "Sommercup", exact: true }).click();
    const openCard = page.locator('[data-match-id="cup-open"]');
    assert.deepEqual(await openCard.locator(".profile-match-actions .btn-login").allTextContents(), ["Ergebnis eintragen", "Termin abändern"]);
    assert.equal(await openCard.locator(".admin-danger").count(), 2);
    await openCard.getByRole("button", { name: "Termin abändern" }).click();
    const appointmentDialog = page.getByRole("dialog", { name: "Termin abändern" });
    assert.equal(await appointmentDialog.locator("#matchDateReasonFields").isVisible(), true);
    await appointmentDialog.getByRole("button", { name: "Nächster Monat" }).click();
    assert.equal(await appointmentDialog.locator(".match-date-calendar-day").filter({ hasText: /^1$/ }).isDisabled(), false);
    await appointmentDialog.getByRole("button", { name: "Terminauswahl schließen" }).click();
    const completedCard = page.locator('[data-match-id="cup-completed"]');
    assert.deepEqual(await completedCard.locator(".profile-match-actions .btn-login").allTextContents(), [
      "Ergebnis korrigieren", "Matchende setzen", "Ergebnis löschen",
    ]);
    assert.equal(await completedCard.locator(".admin-danger").count(), 3);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Admin-Rangplankorrektur setzt dynamische Mindestwerte und laesst Rang 0 fuer Rausgehaengte mehrfach zu", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${address.port}/modals-test.html?role=admin`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.openProfileModal({ playerId: "p2" }));
    await page.getByRole("tab", { name: "Aktuell", exact: true }).click();
    await page.getByRole("tab", { name: "Herren", exact: true }).click();
    const button = page.locator('[data-match-id="match-completed"]').getByRole("button", { name: "Mit Rangplan korrigieren", exact: true });
    assert.equal(await button.evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(180, 35, 24)");
    await button.click();
    const dialog = page.getByRole("dialog", { name: "Mit Rangplan korrigieren" });
    assert.equal(await page.locator("#profileModal").getAttribute("inert"), "");
    assert.equal(await dialog.locator("#matchResultEndFields").isHidden(), true);
    assert.equal(await dialog.locator("#matchResultRankPlan input").count(), 4);
    assert.deepEqual(await dialog.locator("#matchResultRankPlan input").evaluateAll((inputs) => inputs.map((input) => Number(input.value))), [1, 2, 0, 0]);
    assert.deepEqual(await dialog.locator("#matchResultRankPlan input").evaluateAll((inputs) => inputs.map((input) => input.min)), ["1", "1", "0", "0"]);
    await dialog.locator('[data-person-id="player-1"]').fill("2");
    await dialog.locator("#matchResultReason").fill("Rangfolge korrigieren");
    await dialog.getByRole("button", { name: "Mit Rangplan korrigieren", exact: true }).click();
    assert.match(await dialog.locator("#matchResultStatus").textContent(), /Positive Zielränge müssen eindeutig/);
    assert.equal(await page.evaluate(() => window.__matchResultCalls.length), 0);
    await dialog.locator('[data-person-id="p2"]').fill("1");
    await dialog.locator("#matchResultKind").selectOption("regular");
    for (const [label, value] of [["Set 1, Foreign Player", "6"], ["Set 1, Own Player", "3"], ["Set 2, Foreign Player", "6"], ["Set 2, Own Player", "3"]]) {
      const input = dialog.getByLabel(label, { exact: true });
      await input.fill(value);
      await input.blur();
    }
    await dialog.getByRole("button", { name: "Mit Rangplan korrigieren", exact: true }).click();
    await page.waitForFunction(() => window.__matchResultCalls.length === 1);
    const request = await page.evaluate(() => window.__matchResultCalls[0]);
    assert.deepEqual(request, {
      endpoint: "adminCorrectRankingResult",
      matchId: "match-completed",
      expectedFingerprint: "b".repeat(64),
      kind: "regular",
      result: "6-3/6-3",
      reason: "Rangfolge korrigieren",
      rankPlan: [
        { personId: "player-1", expectedRank: 1, newRank: 2 },
        { personId: "p2", expectedRank: 2, newRank: 1 },
        { personId: "p3", expectedRank: 0, newRank: 0 },
        { personId: "p4", expectedRank: 0, newRank: 0 },
      ],
      operationId: request.operationId,
    });
    assert.equal(Object.hasOwn(request, "matchEnd"), false);
    assert.match(request.operationId, /^operation-match-result:rankingRepair:match-completed:/);
    assert.equal(await page.locator("#profileModal").getAttribute("inert"), null);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Admins bearbeiten offene Forderungen mit roten begruendungspflichtigen Datumsaktionen", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${address.port}/modals-test.html?role=admin&dst=1`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.openProfileModal({ playerId: "p2" }));
    await page.getByRole("tab", { name: "Aktuell", exact: true }).click();
    await page.getByRole("tab", { name: "Damen Doppel Lang", exact: true }).click();
    const actions = page.locator("#profileRankingPanel1 .profile-actions .admin-ranking-danger");
    assert.deepEqual(await actions.allTextContents(), ["Forderung löschen", "Forderungsdatum ändern"]);
    assert.equal(await actions.first().evaluate((button) => getComputedStyle(button).backgroundColor), "rgb(180, 35, 24)");

    await page.getByRole("button", { name: "Forderungsdatum ändern", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Forderungsdatum ändern" });
    assert.equal(await page.locator("#profileModal").getAttribute("inert"), "");
    assert.equal(await dialog.locator("#adminRankingDay").getAttribute("min"), "1950-01-01");
    assert.equal(await dialog.locator("#adminRankingDay").getAttribute("max"), "2049-12-31");
    assert.equal(await dialog.locator("#adminRankingDay").inputValue(), "2027-03-28");
    assert.equal(await dialog.locator("#adminRankingTime").getAttribute("type"), "time");
    assert.equal(await dialog.locator("#adminRankingTime").getAttribute("step"), "60");
    assert.equal(await dialog.locator("#adminRankingTime").inputValue(), "02:37");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.closest("#adminRankingActionModal")?.id), "adminRankingActionModal");
    await dialog.locator("#adminRankingDay").fill("2026-01-02");
    await dialog.locator("#adminRankingTime").fill("00:37");
    await dialog.locator("#adminRankingReason").fill("x");
    await dialog.getByRole("button", { name: "Forderungsdatum ändern", exact: true }).click();
    await page.waitForFunction(() => window.__adminRankingCalls.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__adminRankingCalls[0]), {
      endpoint: "adminSetRankingChallengeDate",
      operationId: "operation-ranking:admin:challengeDate:match-r2:260102-0037:x",
      matchId: "match-r2",
      challengeDate: "260102-0037",
      reason: "x",
    });
    assert.equal(await page.locator("#profileModal").getAttribute("inert"), null);
    assert.equal(await page.getByRole("tab", { name: "Damen Doppel Lang", exact: true }).getAttribute("aria-selected"), "true");

    await page.getByRole("tab", { name: "Senioren 45 Plus", exact: true }).click();
    await page.locator("#profileRankingPanel2 .profile-match-actions").getByRole("button", { name: "Termin eintragen" }).click();
    dialog = page.getByRole("dialog", { name: "Termin eintragen" });
    assert.equal(await dialog.locator("#matchDateReasonFields").isVisible(), true);
    await dialog.locator("#matchDateReason").fill("Korrektur");
    await dialog.getByRole("button", { name: "Nächster Monat" }).click();
    await dialog.locator(".match-date-calendar-day").filter({ hasText: /^5$/ }).click();
    await dialog.locator("#rankingMatchHour").selectOption("18");
    await dialog.getByRole("button", { name: "Übernehmen" }).click();
    await page.waitForFunction(() => window.__matchDateCalls.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__matchDateCalls[0]), {
      endpoint: "adminSetMatchAppointment",
      operationId: "operation-match:appointment:match-r3:260905-1800:Korrektur",
      matchId: "match-r3",
      matchDate: "260905-1800",
      reason: "Korrektur",
    });

    await page.getByRole("button", { name: "Forderung löschen", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Forderung löschen" });
    assert.equal(await dialog.locator("#adminRankingDateFields").isHidden(), true);
    await dialog.locator("#adminRankingReason").fill("x");
    await dialog.getByRole("button", { name: "Forderung löschen", exact: true }).click();
    await page.waitForFunction(() => window.__adminRankingCalls.length === 2);
    assert.equal((await page.evaluate(() => window.__adminRankingCalls[1])).endpoint, "adminDeleteRankingChallenge");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Persoenliche Meldungen bleiben privat, geordnet und werden explizit bestaetigt", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
    await page.goto(`http://127.0.0.1:${address.port}/messages-test.html?role=player`, { waitUntil: "domcontentloaded" });
    await page.locator("#profileButton .message-count-badge").waitFor({ state: "visible" });
    assert.equal(await page.locator("#profileButton .message-count-badge").textContent(), "2");

    await page.locator("#profileButton").click();
    await page.getByRole("tab", { name: "Meldungen (2)", exact: true }).click();
    const rows = page.locator("#profileMessagesPanel .message-row");
    await rows.first().waitFor({ state: "visible" });
    assert.deepEqual(await rows.evaluateAll((items) => items.map((row) => (
      [...row.children].map((child) => ({ className: child.className, text: child.textContent }))
    ))), [
      [
        { className: "message-row-date", text: "30.08.2026, 12:00 Uhr" },
        { className: "message-row-competition", text: "Sommercup - Viertelfinale" },
        { className: "message-row-subject", text: "Neue Platzinformation" },
        { className: "message-row-actor", text: "Eingetragen durch: Ergebnis Erfasser" },
      ],
      [
        { className: "message-row-date", text: "29.08.2026, 10:30 Uhr" },
        { className: "message-row-competition", text: "Wintercup - 1. Gruppe" },
        { className: "message-row-subject", text: "Turnierhinweis" },
        { className: "message-row-actor", text: "Eingetragen durch: Turnierleitung" },
      ],
      [
        { className: "message-row-date", text: "31.08.2026, 13:00 Uhr" },
        { className: "message-row-competition", text: "Allgemeine Meldung" },
        { className: "message-row-subject", text: "Bereits bestätigt" },
        { className: "message-row-actor", text: "Eingetragen durch: System" },
      ],
    ]);
    assert.deepEqual(await rows.first().locator(":scope > *").evaluateAll((lines) => lines.map((line) => {
      const style = getComputedStyle(line);
      return { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight };
    })), [
      { color: "rgb(0, 0, 0)", fontSize: "14.4px", fontWeight: "400" },
      { color: "rgb(0, 0, 0)", fontSize: "14.4px", fontWeight: "400" },
      { color: "rgb(0, 0, 0)", fontSize: "14.4px", fontWeight: "700" },
      { color: "rgb(0, 0, 0)", fontSize: "12.8px", fontWeight: "400" },
    ]);
    assert.equal(await rows.first().locator(".message-row-date").textContent(), "30.08.2026, 12:00 Uhr");
    assert.equal(await rows.nth(0).evaluate((row) => row.classList.contains("unread")), true);
    assert.equal(await rows.nth(1).evaluate((row) => row.classList.contains("unread")), true);
    assert.equal(await rows.nth(2).evaluate((row) => row.classList.contains("unread")), false);

    await rows.first().focus();
    await page.keyboard.press("Enter");
    await page.locator("#messageDetailModal").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => window.__acknowledgeCalls.length), 0);
    assert.equal(await page.locator("#messageDetailSubject").textContent(), "Neue Platzinformation");
    assert.deepEqual(await page.locator("#messageDetailSubject, #messageDetailDate, #messageDetailCompetition, #messageDetailActor, #messageDetailBody").evaluateAll((elements) => elements.map((element) => element.id)), [
      "messageDetailSubject",
      "messageDetailDate",
      "messageDetailCompetition",
      "messageDetailActor",
      "messageDetailBody",
    ]);
    assert.equal(await page.locator("#messageDetailDate").evaluate((line) => getComputedStyle(line).color), "rgb(0, 0, 0)");
    assert.equal(await page.locator("#messageDetailCompetition").textContent(), "Sommercup");
    assert.equal(await page.locator("#messageDetailActor").textContent(), "Eingetragen durch: Ergebnis Erfasser");
    assert.equal(await page.locator("#messageDetailActor").isVisible(), true);
    assert.equal(await page.locator("#messageDetailActor").evaluate((line) => (
      line.previousElementSibling?.id === "messageDetailCompetition" && line.nextElementSibling?.id === "messageDetailBody"
    )), true);
    const detailLayout = await page.locator("#messageDetailBody").evaluate((body) => ({
      scrollable: body.scrollHeight > body.clientHeight,
      profileVisible: !document.getElementById("profileModal").classList.contains("hidden"),
      pageLocked: getComputedStyle(document.body).overflow === "hidden",
    }));
    assert.deepEqual(detailLayout, { scrollable: true, profileVisible: true, pageLocked: true });
    await page.keyboard.press("Tab");
    assert.equal(await page.getByRole("button", { name: "Zur Kenntnis genommen", exact: true }).evaluate((button) => document.activeElement === button), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#messageDetailModal .close").evaluate((button) => document.activeElement === button), true);

    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#messageDetailModal").isHidden(), true);
    assert.equal(await page.locator("#profileModal").isVisible(), true);
    assert.equal(await rows.first().evaluate((row) => document.activeElement === row), true);

    await rows.nth(1).click();
    assert.equal(await page.locator("#messageDetailSubject").textContent(), "Turnierhinweis");
    assert.equal(await page.locator("#messageDetailActor").textContent(), "Eingetragen durch: Turnierleitung");
    assert.equal(await page.locator("#messageDetailActor").isVisible(), true);
    await page.locator("#messageDetailModal .close").click();

    await rows.nth(2).click();
    await page.locator("#acknowledgeMessageButton").waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("button", { name: "Zur Kenntnis genommen", exact: true }).isHidden(), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#messageDetailModal .close").evaluate((button) => document.activeElement === button), true);
    await page.locator("#messageDetailModal .close").click();

    await rows.first().click();
    await page.getByRole("button", { name: "Zur Kenntnis genommen", exact: true }).click();
    await page.locator("#acknowledgeMessageButton").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#messageDetailStatus").isVisible(), false);
    assert.equal(await page.locator("#messageDetailAnnouncement").textContent(), "Zur Kenntnis genommen.");
    assert.equal(await page.locator("#messageDetailModal .close").evaluate((button) => document.activeElement === button), true);
    assert.deepEqual(await page.evaluate(() => window.__acknowledgeCalls), [{
      operationId: "operation-message:acknowledge:unread-new",
      messageId: "unread-new",
    }]);
    assert.equal(await page.locator("#profileMessagesPanelTab").textContent(), "Meldungen (1)");
    assert.equal(await page.locator("#profileMessagesPanel .message-row.unread").count(), 1);
    assert.equal(await page.locator("#profileButton .message-count-badge").textContent(), "1");
    assert.equal(await page.locator("#profileButtonMobile .message-count-badge").textContent(), "1");
    await page.close();

    const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobilePage.goto(`http://127.0.0.1:${address.port}/messages-test.html?role=player`, { waitUntil: "domcontentloaded" });
    await mobilePage.locator("#hamburgerBtn.has-unread-messages").waitFor({ state: "visible" });
    assert.equal(await mobilePage.locator("#hamburgerBtn").getAttribute("aria-label"), "Menü öffnen, 2 ungelesene Meldungen");
    assert.equal(await mobilePage.locator("#hamburgerBtn").evaluate((button) => getComputedStyle(button).color), "rgb(255, 77, 79)");
    await mobilePage.locator("#hamburgerBtn").click();
    await mobilePage.locator("#profileButtonMobile").waitFor({ state: "visible" });
    assert.equal(await mobilePage.locator("#profileButtonMobile .message-count-badge").textContent(), "2");
    await mobilePage.locator("#profileButtonMobile").click();
    await mobilePage.getByRole("tab", { name: "Meldungen (2)", exact: true }).click();
    assert.deepEqual(await mobilePage.locator("#profileMessagesPanel .message-row").first().locator(":scope > *").evaluateAll((lines) => lines.map((line) => {
      const style = getComputedStyle(line);
      return { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight };
    })), [
      { color: "rgb(0, 0, 0)", fontSize: "14.4px", fontWeight: "400" },
      { color: "rgb(0, 0, 0)", fontSize: "14.4px", fontWeight: "400" },
      { color: "rgb(0, 0, 0)", fontSize: "14.4px", fontWeight: "700" },
      { color: "rgb(0, 0, 0)", fontSize: "12.8px", fontWeight: "400" },
    ]);
    for (let unread = 2; unread > 0; unread--) {
      await mobilePage.locator("#profileMessagesPanel .message-row.unread").first().click();
      await mobilePage.getByRole("button", { name: "Zur Kenntnis genommen", exact: true }).click();
      await mobilePage.locator("#acknowledgeMessageButton").waitFor({ state: "hidden" });
      await mobilePage.locator("#messageDetailModal .close").click();
    }
    await mobilePage.waitForFunction(() => !document.getElementById("hamburgerBtn").classList.contains("has-unread-messages"));
    assert.equal(await mobilePage.locator("#hamburgerBtn").getAttribute("aria-label"), "Menü öffnen");
    assert.equal(await mobilePage.locator("#hamburgerBtn").evaluate((button) => getComputedStyle(button).color), "rgb(255, 255, 255)");
    await mobilePage.close();

    const noChannelsPage = await browser.newPage({ viewport: { width: 600, height: 600 } });
    await noChannelsPage.goto(`http://127.0.0.1:${address.port}/modals-test.html?role=player&noNotifications=1`, { waitUntil: "domcontentloaded" });
    await noChannelsPage.evaluate(() => window.openProfileModal());
    await noChannelsPage.getByRole("tab", { name: "System", exact: true }).waitFor({ state: "visible" });
    assert.match(await noChannelsPage.locator("#profileSystemPanel").textContent(), /Benachrichtigungen:\s*---/);
    await noChannelsPage.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Mobiles Ranglistenprofil bleibt nach horizontalem Scrollen im sichtbaren Viewport", {
  skip: !fs.existsSync(CHROMIUM_PATH) && `Chromium fehlt unter ${CHROMIUM_PATH}`,
  timeout: 30000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${address.port}/ranking-test.html?role=player&id=2`, { waitUntil: "domcontentloaded" });
    await page.locator("#rankingContainer .box").nth(27).waitFor({ state: "visible" });

    const ranking = await page.locator("#rankingContainer").evaluate((scrollport) => {
      scrollport.scrollLeft = scrollport.scrollWidth - scrollport.clientWidth;
      return {
        clientWidth: scrollport.clientWidth,
        scrollWidth: scrollport.scrollWidth,
        scrollLeft: scrollport.scrollLeft,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        pageScrollX: window.scrollX,
      };
    });
    assert.equal(ranking.scrollWidth > ranking.clientWidth, true);
    assert.equal(ranking.scrollLeft > 0, true);
    assert.equal(ranking.documentWidth, ranking.viewportWidth);
    assert.equal(ranking.pageScrollX, 0);

    await page.locator("#rankingContainer .box").nth(27).click();
    await page.locator("#profileModal").waitFor({ state: "visible" });
    const overlay = await page.locator("#profileModal").evaluate((modal) => {
      const modalRect = modal.getBoundingClientRect();
      const dialogRect = modal.querySelector(".profile-dialog").getBoundingClientRect();
      const viewportLeft = window.visualViewport?.offsetLeft || 0;
      const viewportWidth = window.visualViewport?.width || window.innerWidth;
      document.scrollingElement.scrollLeft = 100;
      return {
        modalLeft: modalRect.left,
        modalRight: modalRect.right,
        dialogLeft: dialogRect.left,
        dialogRight: dialogRect.right,
        dialogCenter: dialogRect.left + (dialogRect.width / 2),
        viewportLeft,
        viewportRight: viewportLeft + viewportWidth,
        viewportCenter: viewportLeft + (viewportWidth / 2),
        pageScrollX: window.scrollX,
        rankingScrollLeft: document.getElementById("rankingContainer").scrollLeft,
        pageLocked: getComputedStyle(document.body).overflow === "hidden",
      };
    });
    assert.equal(overlay.modalLeft, overlay.viewportLeft);
    assert.equal(overlay.modalRight, overlay.viewportRight);
    assert.equal(overlay.dialogLeft >= overlay.viewportLeft + 11, true);
    assert.equal(overlay.dialogRight <= overlay.viewportRight - 11, true);
    assert.equal(Math.abs(overlay.dialogCenter - overlay.viewportCenter) <= 1, true);
    assert.equal(overlay.pageScrollX, 0);
    assert.equal(overlay.rankingScrollLeft, ranking.scrollLeft);
    assert.equal(overlay.pageLocked, true);

    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#rankingContainer").evaluate((scrollport) => scrollport.scrollLeft), ranking.scrollLeft);
    await page.close();

    const busyPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await busyPage.goto(`http://127.0.0.1:${address.port}/ranking-test.html?role=player&id=2&ownBusy=1`, { waitUntil: "domcontentloaded" });
    const ownBusyBox = busyPage.locator("#rankingContainer .box.selected");
    await ownBusyBox.waitFor({ state: "visible" });
    assert.equal(await ownBusyBox.evaluate((box) => box.classList.contains("challenged")), true);
    assert.equal(await ownBusyBox.evaluate((box) => box.classList.contains("schonzeit")), false);
    assert.equal(await ownBusyBox.locator(".box-timer").count(), 0);
    assert.equal(await ownBusyBox.evaluate((box) => getComputedStyle(box).backgroundColor), "rgb(255, 246, 204)");
    await busyPage.close();

    const returnPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await returnPage.goto(`http://127.0.0.1:${address.port}/ranking-test.html?role=player&id=2&withdrawn=1`, { waitUntil: "domcontentloaded" });
    await returnPage.locator("#rankingContainer .box.challengeable").first().waitFor({ state: "visible" });
    const returnTargets = await returnPage.locator("#rankingContainer .box").evaluateAll((boxes) => boxes.map((box) => ({
      rank: Number(box.querySelector(".box-rank-bg")?.textContent),
      challengeable: box.classList.contains("challengeable"),
    })).filter(({ rank }) => Number.isInteger(rank)));
    assert.equal(returnTargets.filter(({ challengeable }) => challengeable).length, 25);
    assert.equal(returnTargets.every(({ rank, challengeable }) => challengeable === (rank >= 4)), true);
    await returnPage.close();

    const newcomerPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await newcomerPage.goto(`http://127.0.0.1:${address.port}/ranking-test.html?role=player&id=2&newcomer=1&blockedTarget=1`, { waitUntil: "domcontentloaded" });
    await newcomerPage.locator("#rankingContainer .box.challengeable").first().waitFor({ state: "visible" });
    const legendSections = await newcomerPage.locator("#rankingLegend").evaluate((legend) => {
      const headings = [...legend.querySelectorAll(".legend-subheading")];
      return Object.fromEntries(headings.map((heading) => [
        heading.textContent,
        heading.nextElementSibling?.textContent || "",
      ]));
    });
    assert.doesNotMatch(legendSections.Kästchen, /Forderbar/);
    assert.match(legendSections.Rahmen, /Forderbar/);
    assert.equal(await newcomerPage.locator("#rankingContainer .box.challengeable").count(), 28);
    const blockedTarget = newcomerPage.locator("#rankingContainer .box.challengeable.sperrzeit");
    assert.equal(await blockedTarget.count(), 1);
    assert.deepEqual(await blockedTarget.evaluate((box) => {
      const style = getComputedStyle(box);
      return { backgroundColor: style.backgroundColor, borderColor: style.borderColor, cursor: style.cursor };
    }), {
      backgroundColor: "rgb(220, 199, 232)",
      borderColor: "rgb(25, 135, 84)",
      cursor: "grab",
    });
    await blockedTarget.click();
    await newcomerPage.getByRole("tab", { name: "Aktuell", exact: true }).click();
    await newcomerPage.getByRole("tab", { name: "Mobile Rangliste" }).click();
    await newcomerPage.getByRole("button", { name: "Fordern" }).waitFor({ state: "visible" });
    await newcomerPage.close();

    const inactivePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await inactivePage.goto(`http://127.0.0.1:${address.port}/ranking-test.html?role=player&id=2&newcomer=1&inactivePlayer=1`, { waitUntil: "domcontentloaded" });
    await inactivePage.locator("#rankingContainer .box.challengeable").first().waitFor({ state: "visible" });
    assert.equal(await inactivePage.locator("#rankingContainer .box.challengeable").count(), 27);
    await inactivePage.close();

    const ineligiblePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await ineligiblePage.goto(`http://127.0.0.1:${address.port}/ranking-test.html?role=player&id=2&ineligible=1`, { waitUntil: "domcontentloaded" });
    await ineligiblePage.locator("#rankingContainer .box").first().waitFor({ state: "visible" });
    assert.equal(await ineligiblePage.locator("#rankingContainer .box.challengeable").count(), 0);
    await ineligiblePage.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
