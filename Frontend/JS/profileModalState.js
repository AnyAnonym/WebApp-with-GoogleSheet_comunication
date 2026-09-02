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
