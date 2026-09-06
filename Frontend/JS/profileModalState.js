export function clearProfileModalContent(modal, actionController) {
  actionController?.abort();
  if (!modal) return;
  modal.removeAttribute("data-profile-scope");
  const nameElement = modal.querySelector("#profileName");
  const textElement = modal.querySelector("#profileText");
  const tabsElement = modal.querySelector("#profileTabs");
  const currentTabsElement = modal.querySelector("#profileCurrentCompetitionTabs");
  const archiveTabsElement = modal.querySelector("#profileArchiveCompetitionTabs");
  const rankingPanelsElement = modal.querySelector("#profileRankingPanels");
  const systemActionsElement = modal.querySelector("#profileSystemActions");
  const messagesPanel = modal.querySelector("#profileMessagesPanel");
  const adminActionsElement = modal.querySelector("#profileAdminActions");
  if (nameElement) nameElement.textContent = "Profil";
  textElement?.replaceChildren();
  tabsElement?.replaceChildren();
  for (const competitionTabs of [currentTabsElement, archiveTabsElement]) {
    competitionTabs?.replaceChildren();
    if (competitionTabs) competitionTabs.hidden = true;
  }
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

function competitionEndAt(competition) {
  if (competition?.competitionEndAt === null || competition?.competitionEndAt === undefined || competition?.competitionEndAt === "") return null;
  const value = Number(competition?.competitionEndAt);
  return Number.isFinite(value) ? value : null;
}

function compareCompetitionIdentity(left, right) {
  return String(left.competitionName || "").localeCompare(String(right.competitionName || ""), "de")
    || String(left.competitionId || "").localeCompare(String(right.competitionId || ""), "de");
}

export function categorizedProfileCompetitions(profile) {
  const current = [];
  const archive = [];
  for (const competition of mergedProfileCompetitions(profile)) {
    const personallyActive = competition.status === "active"
      || competition.matches.some((match) => match.status === "open");
    (competition.competitionEnded === true || !personallyActive ? archive : current).push(competition);
  }
  current.sort((left, right) => {
    const leftEnd = competitionEndAt(left);
    const rightEnd = competitionEndAt(right);
    if (leftEnd === null && rightEnd !== null) return 1;
    if (leftEnd !== null && rightEnd === null) return -1;
    return (leftEnd ?? 0) - (rightEnd ?? 0) || compareCompetitionIdentity(left, right);
  });
  archive.sort((left, right) => {
    const leftEnd = competitionEndAt(left);
    const rightEnd = competitionEndAt(right);
    if (leftEnd === null && rightEnd !== null) return 1;
    if (leftEnd !== null && rightEnd === null) return -1;
    return (rightEnd ?? 0) - (leftEnd ?? 0) || compareCompetitionIdentity(left, right);
  });
  return { current, archive };
}
