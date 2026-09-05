export function clearProfileModalContent(modal, actionController) {
  actionController?.abort();
  if (!modal) return;
  modal.removeAttribute("data-profile-scope");
  const nameElement = modal.querySelector("#profileName");
  const textElement = modal.querySelector("#profileText");
  const tabsElement = modal.querySelector("#profileTabs");
  const rankingPanelsElement = modal.querySelector("#profileRankingPanels");
  const systemActionsElement = modal.querySelector("#profileSystemActions");
  const messagesPanel = modal.querySelector("#profileMessagesPanel");
  const adminActionsElement = modal.querySelector("#profileAdminActions");
  if (nameElement) nameElement.textContent = "Profil";
  textElement?.replaceChildren();
  tabsElement?.replaceChildren();
  rankingPanelsElement?.replaceChildren();
  systemActionsElement?.replaceChildren();
  messagesPanel?.replaceChildren();
  adminActionsElement?.replaceChildren();
}

export function mergedProfileCompetitions(profile) {
  const merged = new Map();
  for (const ranking of Array.isArray(profile?.rankings) ? profile.rankings : []) {
    const competitionId = String(ranking?.competitionId || "");
    if (competitionId) merged.set(competitionId, { ...ranking, matches: [] });
  }
  for (const competition of Array.isArray(profile?.competitions) ? profile.competitions : []) {
    const competitionId = String(competition?.competitionId || "");
    if (!competitionId) continue;
    merged.set(competitionId, {
      ...(merged.get(competitionId) || {}),
      ...competition,
      matches: Array.isArray(competition.matches) ? competition.matches : [],
    });
  }
  return [...merged.values()];
}
