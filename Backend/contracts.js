const { AppError } = require("./errors.js");
const {
  booleanValue,
  idValue,
  integerValue,
  operationId,
  requireObject,
  stringValue,
} = require("./validators.js");
const { validateChanges } = require("./peopleNormalization.js");
const { validateReconciliationRequest } = require("./memberReconciliation.js");

function objectShape(raw, fields) {
  const value = requireObject(raw);
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) throw new AppError("VALIDATION_ERROR", `Unbekanntes Feld: ${key}`);
  }
  return Object.fromEntries(Object.entries(fields).flatMap(([key, validator]) => {
    const result = validator(value[key]);
    return result === undefined ? [] : [[key, result]];
  }));
}

const optional = (validator) => (value) => value === undefined ? undefined : validator(value);
const id = (name) => (value) => idValue(value, name);
const text = (name, options) => (value) => stringValue(value, name, options);
const integer = (name, options) => (value) => integerValue(value, name, options);
const operation = (value) => operationId(value);
const reconciliationWrite = (params) => {
  const value = requireObject(params);
  const { operationId: rawOperationId, ...request } = value;
  return { operationId: operation(rawOperationId), ...validateReconciliationRequest(request) };
};
const empty = (params) => objectShape(params, {});
const competitionFilter = (params) => objectShape(params, { bewerbId: optional(id("bewerbId")) });
const competitionWrite = (params) => objectShape(params, { operationId: operation, bewerbId: id("bewerbId") });
const adminRankingReason = text("reason", { min: 1, max: 500 });
const fingerprint = text("expectedFingerprint", { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/i });
const completionKind = text("kind", { max: 16, pattern: /^(regular|walkover|retirement)$/ });
const optionalMatchEnd = optional(text("matchEnd", { min: 11, max: 11, pattern: /^\d{6}-\d{4}$/ }));
const matchCompletionFields = {
  operationId: operation,
  matchId: id("matchId"),
  kind: completionKind,
  result: optional(text("result", { min: 0, max: 200 })),
  losingSide: optional(integer("losingSide", { min: 1, max: 2 })),
  matchEnd: optionalMatchEnd,
  expectedFingerprint: fingerprint,
};
const matchCorrectionFields = {
  operationId: operation,
  matchId: id("matchId"),
  kind: completionKind,
  result: optional(text("result", { min: 0, max: 200 })),
  losingSide: optional(integer("losingSide", { min: 1, max: 2 })),
  expectedFingerprint: fingerprint,
};
const rankPlan = (value) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10000) {
    throw new AppError("VALIDATION_ERROR", "rankPlan muss ein nichtleeres Array sein");
  }
  const validated = value.map((entry) => objectShape(entry, {
    personId: id("personId"),
    expectedRank: integer("expectedRank", { min: 0, max: 10000 }),
    newRank: integer("newRank", { min: 0, max: 10000 }),
  }));
  const positiveRanks = validated.map(({ newRank }) => newRank).filter((rank) => rank > 0);
  if (validated.some(({ expectedRank, newRank }) => expectedRank > 0 && newRank === 0)) {
    throw new AppError("RANK_PLAN_INVALID", "Aktive Ranglistenmitglieder koennen nicht auf Rang 0 gesetzt werden", 409);
  }
  if (new Set(positiveRanks).size !== positiveRanks.length) {
    throw new AppError("VALIDATION_ERROR", "Positive Zielraenge muessen eindeutig sein");
  }
  return validated;
};
const rankingHour = (name) => text(name, { min: 11, max: 11, pattern: /^\d{6}-(?:[01]\d|2[0-3])00$/ });
const rankingMinute = (name) => text(name, { min: 11, max: 11, pattern: /^\d{6}-(?:[01]\d|2[0-3])[0-5]\d$/ });
const monitorWrite = (params) => objectShape(params, { operationId: operation, monitorId: id("monitorId") });
const playerIds = (name) => (value) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw new AppError("VALIDATION_ERROR", `${name} muss ein Array mit ein bis zwei IDs sein`);
  }
  return value.map((entry) => idValue(entry, name));
};

function courtAssignment(params) {
  const value = objectShape(params, {
    operationId: operation,
    court: id("court"),
    expectedRevision: integer("expectedRevision", { min: 1 }),
    empty: optional((entry) => booleanValue(entry, "empty")),
    matchId: optional(id("matchId")),
    homePlayerIds: optional(playerIds("homePlayerIds")),
    guestPlayerIds: optional(playerIds("guestPlayerIds")),
  });
  const hasMatch = value.matchId !== undefined;
  const hasPlayers = value.homePlayerIds !== undefined || value.guestPlayerIds !== undefined;
  const isEmpty = value.empty === true;
  if (Number(hasMatch) + Number(hasPlayers) + Number(isEmpty) !== 1
    || value.empty === false
    || (hasPlayers && (value.homePlayerIds === undefined || value.guestPlayerIds === undefined))) {
    throw new AppError("VALIDATION_ERROR", "Court-Zuweisung benoetigt genau Match, Spielerpaarung oder empty: true");
  }
  return value;
}

const requestContracts = {
  players: empty,
  adminPeopleNormalization: empty,
  adminMemberReconciliation: empty,
  sheetDataStatus: empty,
  refreshSheetData: (params) => objectShape(params, { operationId: operation }),
  publicProfile: (params) => objectShape(params, { id: id("id") }),
  bewerbe: empty,
  bewerbsart: empty,
  matches1: competitionFilter,
  preMatches: competitionFilter,
  matches: competitionFilter,
  rlPlatzierung: competitionFilter,
  entryList: competitionFilter,
  readMatchRestrictions: competitionFilter,
  withdrawnRankingPlayers: (params) => objectShape(params, { bewerbId: id("bewerbId") }),
  getScoreboardCourts: empty,
  courtScores: empty,
  scoreboardSnapshot: empty,
  memberDirectory: empty,
  myProfile: empty,
  myMessageSummary: empty,
  myMessages: (params) => objectShape(params, {
    cursor: optional(id("cursor")),
    limit: optional(integer("limit", { min: 1, max: 100 })),
  }),
  myMessage: (params) => objectShape(params, { messageId: id("messageId") }),
  acknowledgeMessage: (params) => objectShape(params, { operationId: operation, messageId: id("messageId") }),
  competitionHistory: (params) => objectShape(params, {
    bewerbId: optional(id("bewerbId")),
    cursor: optional(text("cursor", { max: 256, pattern: /^[A-Za-z0-9_-]+$/ })),
    limit: optional(integer("limit", { min: 1, max: 100 })),
  }),
  rankingChallengeState: (params) => objectShape(params, { bewerbId: id("bewerbId") }),
  operationStatus: (params) => objectShape(params, { operationId: operation }),
  normalizePerson: (params) => objectShape(params, {
    operationId: operation,
    personId: id("personId"),
    expectedFingerprint: text("expectedFingerprint", { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/i }),
    changes: validateChanges,
  }),
  reconcilePerson: reconciliationWrite,
  addMatch: (params) => objectShape(params, {
    operationId: operation,
    bewerbId: id("bewerbId"),
    opponentId: id("opponentId"),
  }),
  setRankingMatchDate: (params) => objectShape(params, {
    operationId: operation,
    matchId: id("matchId"),
    matchDate: text("matchDate", { min: 11, max: 11, pattern: /^\d{6}-\d{4}$/ }),
  }),
  matchResultSuggestion: (params) => objectShape(params, {
    matchId: id("matchId"),
    court: text("court", { min: 1, max: 1, pattern: /^[12]$/ }),
  }),
  setMatchResult: (params) => objectShape(params, matchCompletionFields),
  adminSetMatchEnd: (params) => objectShape(params, {
    operationId: operation,
    matchId: id("matchId"),
    matchEnd: text("matchEnd", { min: 11, max: 11, pattern: /^\d{6}-\d{4}$/ }),
    expectedFingerprint: fingerprint,
    reason: adminRankingReason,
  }),
  adminClearMatchResult: (params) => objectShape(params, {
    operationId: operation,
    matchId: id("matchId"),
    expectedFingerprint: fingerprint,
    reason: adminRankingReason,
  }),
  adminCorrectRankingResult: (params) => objectShape(params, {
    ...matchCorrectionFields,
    reason: adminRankingReason,
    rankPlan,
  }),
  adminDeleteRankingChallenge: (params) => objectShape(params, {
    operationId: operation,
    matchId: id("matchId"),
    reason: adminRankingReason,
  }),
  adminSetRankingChallengeDate: (params) => objectShape(params, {
    operationId: operation,
    matchId: id("matchId"),
    challengeDate: rankingMinute("challengeDate"),
    reason: adminRankingReason,
  }),
  adminSetRankingMatchDate: (params) => objectShape(params, {
    operationId: operation,
    matchId: id("matchId"),
    matchDate: rankingHour("matchDate"),
    reason: adminRankingReason,
  }),
  addEntryList: competitionWrite,
  removeEntryList: competitionWrite,
  withdrawFromRanking: (params) => objectShape(params, {
    operationId: operation,
    bewerbId: id("bewerbId"),
    rank: integer("rank", { min: 1, max: 10000 }),
    reason: text("reason", { min: 3, max: 500 }),
  }),
  navigator: (params) => objectShape(params, { profil: optional(text("profil", { max: 32 })) }),
  courtAssign: courtAssignment,
  courtSetActive: (params) => objectShape(params, {
    operationId: operation,
    court: id("court"),
    expectedRevision: integer("expectedRevision", { min: 1 }),
    active: (value) => booleanValue(value, "active"),
  }),
  monitorList: empty,
  monitorNavigate: (params) => objectShape(params, {
    operationId: operation,
    monitorId: id("monitorId"),
    path: text("path", { max: 512 }),
  }),
  monitorScroll: (params) => objectShape(params, {
    operationId: operation,
    monitorId: id("monitorId"),
    direction: text("direction", { max: 4, pattern: /^(up|down)$/ }),
  }),
  monitorProvision: (params) => objectShape(params, {
    operationId: operation,
    label: text("label", { max: 100 }),
  }),
  monitorRotate: monitorWrite,
  monitorRevoke: monitorWrite,
  monitorTarget: empty,
  monitorAck: (params) => objectShape(params, {
    kind: text("kind", { max: 16, pattern: /^(navigate|scroll)$/ }),
    commandId: id("commandId"),
    status: text("status", { max: 16 }),
    errorCode: optional(text("errorCode", { max: 64, pattern: /^[A-Z0-9_]+$/ })),
  }),
};

function validateEndpointRequest(endpoint, params) {
  const contract = requestContracts[endpoint];
  if (!contract) throw new AppError("ENDPOINT_CONTRACT_MISSING", "Endpointvertrag fehlt", 500);
  return contract(params);
}

function validateEndpointResponse(endpoint, result) {
  requireObject(result, `${endpoint} response`);
  if (result.success !== true) throw new AppError("ENDPOINT_RESPONSE_INVALID", "Endpointantwort ist ungueltig", 500);
  return result;
}

module.exports = { requestContracts, validateEndpointRequest, validateEndpointResponse };
