const { headerIndex, headerOf } = require("./tableUtils.js");

function projectScoreboardScores(scoreSnapshot, { courts, matchtypen }) {
  if (!scoreSnapshot || !Array.isArray(scoreSnapshot.courts)) return scoreSnapshot;

  const rowsById = (values) => {
    const header = headerOf(values);
    const idIndex = headerIndex(header, "id");
    return {
      header,
      rows: new Map(idIndex < 0 ? [] : values.slice(1).map((row) => [String(row[idIndex] || "").trim(), row])),
    };
  };
  const matchtypData = rowsById(matchtypen);
  const tiebreakIndex = headerIndex(matchtypData.header, "satztiebreak");
  const decidingSetIndex = headerIndex(matchtypData.header, "entscheidender satz");

  const projected = structuredClone(scoreSnapshot);
  projected.courts = projected.courts.map((score) => {
    const court = courts?.[String(score.platz)] || {};
    const matchtyp = matchtypData.rows.get(String(court.matchtypId || "").trim());
    const decidingSet = matchtyp && decidingSetIndex >= 0
      ? String(matchtyp[decidingSetIndex] || "").trim().toUpperCase()
      : "";
    const displayScore = { ...score, satz3matchtiebreak: decidingSet === "MT7" || decidingSet === "MT10" };
    const trigger = matchtyp && tiebreakIndex >= 0
      ? String(matchtyp[tiebreakIndex] || "").trim().split("-").map((value) => value.trim())
      : [];
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

module.exports = { projectScoreboardScores };
