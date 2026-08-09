export function clearProfileModalContent(modal, actionController) {
  actionController?.abort();
  if (!modal) return;
  modal.removeAttribute("data-profile-scope");
  const nameElement = modal.querySelector("#profileName");
  const textElement = modal.querySelector("#profileText");
  const actionsElement = modal.querySelector("#profileActions");
  if (nameElement) nameElement.textContent = "Profil";
  textElement?.replaceChildren();
  actionsElement?.replaceChildren();
  actionsElement?.style.setProperty("display", "none", "important");
}
