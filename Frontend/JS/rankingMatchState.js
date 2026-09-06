export function parseRankingParticipant(raw) {
  const value = String(raw || "").trim();
  const special = value.endsWith("[wo]") ? "wo" : value.endsWith("[ret]") ? "ret" : null;
  return {
    id: special ? value.slice(0, -special.length - 2).trim() : value,
    special,
  };
}

export function isOpenRankingMatch(row, indexes) {
  const result = indexes.result < 0 ? "" : String(row[indexes.result] || "").trim();
  if (result) return false;
  return [indexes.p1, indexes.p2, indexes.p3, indexes.p4]
    .filter((index) => index >= 0)
    .every((index) => parseRankingParticipant(row[index]).special === null);
}

export function isActiveRankingRank(raw) {
  const rank = Number(raw);
  return Number.isInteger(rank) && rank > 0;
}

export function rankingPlayerState(id, currentPlayerId, busyIds, protection, blocked) {
  const selected = Boolean(currentPlayerId && id === currentPlayerId);
  if (busyIds.has(id)) return { selected, status: "busy" };
  if (protection.has(id)) return { selected, status: "protection" };
  if (blocked.has(id)) return { selected, status: "blocked" };
  return { selected, status: null };
}
