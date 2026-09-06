export function formatWalkoverResult(winningTeam, losingTeam) {
  const winner = String(winningTeam || "").trim();
  const loser = String(losingTeam || "").trim();
  return winner && loser ? `${winner} gewinnt durch W.O. von ${loser}.` : "";
}
