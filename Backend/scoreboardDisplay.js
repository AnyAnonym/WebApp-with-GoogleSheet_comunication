const { headerIndex, headerOf } = require("./tableUtils.js");

const DISPLAY_RULES_SCHEMA_VERSION = 1;

function inspectMatchtypDisplayRules(matchtypen, matchtypId) {
  const id = String(matchtypId || "").trim();
  if (!id) return { rules: null, reason: null };
  const header = headerOf(matchtypen);
  const idIndex = headerIndex(header, "id");
  const tiebreakIndex = headerIndex(header, "satztiebreak");
  const decidingSetIndex = headerIndex(header, "entscheidender satz");
  if (idIndex < 0 || tiebreakIndex < 0 || decidingSetIndex < 0) {
    return { rules: null, reason: "MATCHTYP_SCHEMA_INVALID" };
  }
  const row = matchtypen.slice(1).find((entry) => String(entry[idIndex] || "").trim() === id);
  if (!row) return { rules: null, reason: "MATCHTYP_NOT_FOUND" };
  const trigger = String(row[tiebreakIndex] || "").trim().split("-").map((value) => value.trim());
  const decidingSetValue = String(row[decidingSetIndex] || "").trim();
  const decidingSetKey = decidingSetValue.toUpperCase().replaceAll("Ä", "AE");
  if (trigger.length !== 2 || trigger.some((value) => !/^\d+$/.test(value)) || trigger[0] !== trigger[1]) {
    return { rules: null, reason: "MATCHTYP_RULES_INVALID" };
  }
  if (!new Set(["VOLLSTAENDIGER SATZ", "MT7", "MT10"]).has(decidingSetKey)) {
    return { rules: null, reason: "MATCHTYP_RULES_INVALID" };
  }
  return { rules: {
    schemaVersion: DISPLAY_RULES_SCHEMA_VERSION,
    source: "matchtyp",
    matchtypId: id,
    satztiebreak: trigger.map((value) => String(Number(value))).join("-"),
    entscheidenderSatz: decidingSetKey === "VOLLSTAENDIGER SATZ" ? "vollstaendiger Satz" : decidingSetKey,
  }, reason: null };
}

function snapshotMatchtypDisplayRules(matchtypen, matchtypId) {
  return inspectMatchtypDisplayRules(matchtypen, matchtypId).rules;
}

function projectScoreboardScores(scoreSnapshot, { courts }) {
  if (!scoreSnapshot || !Array.isArray(scoreSnapshot.courts)) return scoreSnapshot;

  const projected = structuredClone(scoreSnapshot);
  projected.courts = projected.courts.map((score) => {
    const court = courts?.[String(score.platz)] || {};
    const candidate = court.displayRules;
    const rules = candidate?.schemaVersion === DISPLAY_RULES_SCHEMA_VERSION
      && candidate.source === "matchtyp"
      && String(candidate.matchtypId || "") === String(court.matchtypId || "")
      ? candidate
      : null;
    const decidingSet = String(rules?.entscheidenderSatz || "").trim().toUpperCase();
    const displayScore = { ...score, satz3matchtiebreak: decidingSet === "MT7" || decidingSet === "MT10" };
    const trigger = String(rules?.satztiebreak || "").trim().split("-").map((value) => value.trim());
    if (trigger.length !== 2 || trigger.some((value) => !/^\d+$/.test(value))) return displayScore;

    const tieBreakActive = [1, 2].some((set) => (
      String(score[`satz${set}home`] ?? "").trim() === trigger[0]
      && String(score[`satz${set}gast`] ?? "").trim() === trigger[1]
    ));
    if (!tieBreakActive) return displayScore;
    return {
      ...displayScore,
      satz3home: "0",
      satz3gast: "0",
      punktehome: score.satz3home,
      punktegast: score.satz3gast,
    };
  });
  return projected;
}

module.exports = {
  DISPLAY_RULES_SCHEMA_VERSION,
  inspectMatchtypDisplayRules,
  projectScoreboardScores,
  snapshotMatchtypDisplayRules,
};
