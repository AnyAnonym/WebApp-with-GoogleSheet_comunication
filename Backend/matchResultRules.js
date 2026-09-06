class MatchResultRuleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchResultRuleError";
    this.code = code;
  }
}

const MATCHTYPE_COLUMNS = [
  "id",
  "gewinnsaetze",
  "satzlaenge",
  "satztiebreak",
  "entscheidender satz",
  "noad",
];

function text(value) {
  return String(value ?? "").trim();
}

function parseParticipantId(raw) {
  const value = text(raw);
  const marker = value.endsWith("[wo]") ? "wo" : value.endsWith("[ret]") ? "ret" : null;
  const withoutMarker = marker ? value.slice(0, marker === "wo" ? -4 : -5).trim() : value;
  return {
    id: withoutMarker.replace(/\[gesetzt\]/gi, "").trim(),
    marker,
  };
}

function parseMatchTypeTable(values) {
  if (!Array.isArray(values) || !Array.isArray(values[0])) {
    throw new MatchResultRuleError("MATCHTYPE_SCHEMA", "Matchtyp-Tabelle fehlt");
  }
  const header = values[0].map((value) => text(value).toLowerCase());
  const indexes = Object.fromEntries(MATCHTYPE_COLUMNS.map((column) => [column, header.indexOf(column)]));
  const missing = MATCHTYPE_COLUMNS.filter((column) => indexes[column] < 0);
  if (missing.length) {
    throw new MatchResultRuleError("MATCHTYPE_SCHEMA", `Fehlende Matchtyp-Spalten: ${missing.join(", ")}`);
  }

  const result = new Map();
  for (const row of values.slice(1)) {
    if (!Array.isArray(row) || row.every((value) => text(value) === "")) continue;
    const id = text(row[indexes.id]);
    const winningSets = Number(text(row[indexes.gewinnsaetze]));
    const setLength = text(row[indexes.satzlaenge]);
    const setTiebreak = text(row[indexes.satztiebreak]);
    const decidingSet = text(row[indexes["entscheidender satz"]]);
    const noAdValue = text(row[indexes.noad]);

    if (!/^[1-9]\d*$/.test(id) || result.has(id)) {
      throw new MatchResultRuleError("MATCHTYPE_ID", `Ungueltige oder doppelte Matchtyp-ID: ${id}`);
    }
    if (winningSets !== 2 && winningSets !== 3) {
      throw new MatchResultRuleError("MATCHTYPE_RULES", `Ungueltige Gewinnsatzanzahl fuer Matchtyp ${id}`);
    }
    if (setLength !== "0-4" && setLength !== "0-6") {
      throw new MatchResultRuleError("MATCHTYPE_RULES", `Ungueltige Satzlaenge fuer Matchtyp ${id}`);
    }
    const setTarget = setLength === "0-4" ? 4 : 6;
    const expectedTiebreak = setTarget === 4 ? "3-3" : "6-6";
    if (setTiebreak !== expectedTiebreak) {
      throw new MatchResultRuleError("MATCHTYPE_RULES", `Satztiebreak passt nicht zur Satzlaenge fuer Matchtyp ${id}`);
    }
    if (!new Set(["vollstaendiger Satz", "MT7", "MT10"]).has(decidingSet)) {
      throw new MatchResultRuleError("MATCHTYPE_RULES", `Ungueltiger entscheidender Satz fuer Matchtyp ${id}`);
    }
    if (noAdValue !== "J" && noAdValue !== "N") {
      throw new MatchResultRuleError("MATCHTYPE_RULES", `Ungueltiger NoAd-Wert fuer Matchtyp ${id}`);
    }

    result.set(id, Object.freeze({
      id,
      winningSets,
      setLength,
      setTarget,
      setTiebreak,
      decidingSet,
      noAd: noAdValue === "J",
    }));
  }
  return result;
}

function objectValue(object, name) {
  if (!object || typeof object !== "object") return "";
  const wanted = name.toLowerCase();
  const key = Object.keys(object).find((candidate) => candidate.trim().toLowerCase() === wanted);
  return key === undefined ? "" : text(object[key]);
}

function resolveMatchType(match, competition, matchTypes) {
  if (!(matchTypes instanceof Map)) {
    throw new MatchResultRuleError("MATCHTYPE_SCHEMA", "Matchtypen muessen als Map vorliegen");
  }
  const overrideId = objectValue(match, "MatchtypID");
  const defaultId = objectValue(competition, "MatchtypID Standard");
  const id = overrideId || defaultId;
  if (!id) throw new MatchResultRuleError("MATCHTYPE_UNRESOLVED", "Kein Matchtyp zugeordnet");
  const rules = matchTypes.get(id);
  if (!rules) throw new MatchResultRuleError("MATCHTYPE_NOT_FOUND", `Matchtyp ${id} fehlt`);
  return { rules, source: overrideId ? "match" : "competition" };
}

function parseSetToken(token) {
  const match = text(token).match(/^((?:0|[1-9]\d?))-((?:0|[1-9]\d?))(?:\(((?:0|[1-9]\d?))\))?$/);
  if (!match) return null;
  return {
    side1: Number(match[1]),
    side2: Number(match[2]),
    tiebreakLoserPoints: match[3] === undefined ? null : Number(match[3]),
  };
}

function normalSetState(set, rules) {
  const { side1: a, side2: b, tiebreakLoserPoints: tb } = set;
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  const target = rules.setTarget;
  const tiebreakAt = target === 4 ? 3 : 6;
  if (a === b && tb !== null) return "invalid";
  if (high === target && low <= target - 2 && tb === null) return "complete";
  if (target === 6 && high === 7 && low === 5 && tb === null) return "complete";
  if (high === tiebreakAt + 1 && low === tiebreakAt && tb !== null) return "complete";
  if (tb !== null) return "invalid";
  if (target === 6 && high <= 6) return "partial";
  if (target === 4 && high <= 3) return "partial";
  return "invalid";
}

function matchTiebreakState(set, target) {
  const { side1: a, side2: b, tiebreakLoserPoints: tb } = set;
  if (tb !== null || a === b && a >= target) return "invalid";
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  if (high >= target && high - low >= 2) return high - low === 2 || high === target ? "complete" : "invalid";
  return "partial";
}

function invalidCompletion(error) {
  return { valid: false, error };
}

function validateCompletion(completion, rules) {
  if (!rules || ![2, 3].includes(rules.winningSets) || ![4, 6].includes(rules.setTarget)) {
    throw new MatchResultRuleError("MATCHTYPE_RULES", "Ungueltige Matchtyp-Regeln");
  }
  const kind = text(completion?.kind);
  const result = text(completion?.result);
  const losingSide = Number(completion?.losingSide);
  if (!new Set(["regular", "walkover", "retirement"]).has(kind)) {
    return invalidCompletion("COMPLETION_KIND");
  }
  if (kind === "walkover") {
    if (losingSide !== 1 && losingSide !== 2) return invalidCompletion("LOSING_SIDE");
    if (result) return invalidCompletion("WALKOVER_RESULT");
    return { valid: true, kind, result: "", losingSide, winnerSide: 3 - losingSide, sets: [] };
  }
  if (kind === "retirement" && losingSide !== 1 && losingSide !== 2) {
    return invalidCompletion("LOSING_SIDE");
  }
  if (kind === "regular" && !result) return invalidCompletion("RESULT_REQUIRED");

  const tokens = result ? result.split("/") : [];
  if (tokens.some((token) => !token) || tokens.length > rules.winningSets * 2 - 1) {
    return invalidCompletion("RESULT_SYNTAX");
  }
  const sets = [];
  let wins1 = 0;
  let wins2 = 0;
  for (let index = 0; index < tokens.length; index++) {
    const set = parseSetToken(tokens[index]);
    if (!set) {
      return invalidCompletion("RESULT_SYNTAX");
    }
    const deciding = index === rules.winningSets * 2 - 2;
    const state = deciding && rules.decidingSet !== "vollstaendiger Satz"
      ? matchTiebreakState(set, Number(rules.decidingSet.slice(2)))
      : normalSetState(set, rules);
    const last = index === tokens.length - 1;
    if (state === "invalid" || state === "partial" && (kind === "regular" || !last)) {
      return invalidCompletion("SET_INVALID");
    }
    if (state === "complete") {
      if (set.side1 > set.side2) wins1++;
      else wins2++;
    }
    sets.push({ ...set, state, deciding });
    if ((wins1 >= rules.winningSets || wins2 >= rules.winningSets) && !last) {
      return invalidCompletion("SETS_AFTER_MATCH_END");
    }
  }

  if (kind === "regular") {
    const winnerSide = wins1 === rules.winningSets ? 1 : wins2 === rules.winningSets ? 2 : 0;
    if (!winnerSide) return invalidCompletion("MATCH_INCOMPLETE");
    return { valid: true, kind, result, losingSide: 3 - winnerSide, winnerSide, sets };
  }
  if (wins1 >= rules.winningSets || wins2 >= rules.winningSets) {
    return invalidCompletion("MATCH_ALREADY_COMPLETE");
  }
  return { valid: true, kind, result, losingSide, winnerSide: 3 - losingSide, sets };
}

function stripCompletionMarker(raw) {
  const value = text(raw);
  if (value.endsWith("[wo]")) return value.slice(0, -4).trim();
  if (value.endsWith("[ret]")) return value.slice(0, -5).trim();
  return value;
}

function encodeCompletion(match, completion) {
  if (!match || typeof match !== "object" || Array.isArray(match)) {
    throw new MatchResultRuleError("MATCH_ROW", "Match muss ein Objekt sein");
  }
  const kind = text(completion?.kind);
  if (!new Set(["regular", "walkover", "retirement"]).has(kind)) {
    throw new MatchResultRuleError("COMPLETION_KIND", "Ungueltige Abschlussart");
  }
  const losingSide = Number(completion?.losingSide);
  if (kind !== "regular" && losingSide !== 1 && losingSide !== 2) {
    throw new MatchResultRuleError("LOSING_SIDE", "Ungueltige Verliererseite");
  }
  const encoded = { ...match, Ergebnis: kind === "walkover" ? "" : text(completion?.result) };
  for (const field of ["Spieler1ID", "Spieler2ID", "Spieler3ID", "Spieler4ID"]) {
    if (Object.hasOwn(match, field)) encoded[field] = stripCompletionMarker(match[field]);
  }
  if (kind !== "regular") {
    const field = losingSide === 1 ? "Spieler1ID" : "Spieler3ID";
    if (!encoded[field]) throw new MatchResultRuleError("PARTICIPANT_MISSING", "Erster Spieler der Verliererseite fehlt");
    encoded[field] = `${encoded[field]} [${kind === "walkover" ? "wo" : "ret"}]`;
  }
  return encoded;
}

function bracketRounds(playerCount) {
  if (!Number.isInteger(playerCount) || playerCount < 2 || (playerCount & (playerCount - 1)) !== 0) {
    throw new MatchResultRuleError("RASTERFUNKTION", "Rasterfunktion muss eine Zweierpotenz ab 2 sein");
  }
  const roundCount = Math.log2(playerCount);
  const fixedCount = Math.min(roundCount, 4);
  const preliminaryCount = roundCount - fixedCount;
  const rounds = Array.from({ length: preliminaryCount }, (_, index) => `R${index + 1}`);
  return rounds.concat(["AF", "VF", "HF", "F"].slice(4 - fixedCount));
}

function koRoundSuccessor(currentRoundCode, rasterfunktion) {
  const code = text(currentRoundCode).toUpperCase();
  if (code === "F") return null;
  const match = code.match(/^(R[1-9]\d*|AF|VF|HF)-P([1-9]\d*)$/);
  if (!match) throw new MatchResultRuleError("ROUND_CODE", "Ungueltiger Rundencode");
  const rounds = bracketRounds(Number(rasterfunktion));
  const roundIndex = rounds.indexOf(match[1]);
  if (roundIndex < 0 || roundIndex === rounds.length - 1) {
    throw new MatchResultRuleError("ROUND_CODE", "Runde passt nicht zur Rasterfunktion");
  }
  const slot = Number(match[2]);
  const slotsInRound = Number(rasterfunktion) / (2 ** (roundIndex + 1));
  if (slot > slotsInRound) throw new MatchResultRuleError("ROUND_CODE", "Paarung passt nicht zur Rasterfunktion");
  const nextRound = rounds[roundIndex + 1];
  return {
    roundCode: nextRound === "F" ? "F" : `${nextRound}-P${Math.ceil(slot / 2)}`,
    side: slot % 2 === 1 ? 1 : 2,
  };
}

module.exports = {
  MatchResultRuleError,
  encodeCompletion,
  koRoundSuccessor,
  parseMatchTypeTable,
  parseParticipantId,
  resolveMatchType,
  validateCompletion,
};
