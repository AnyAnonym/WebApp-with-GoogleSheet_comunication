import { createEndpoint, getOperationId, releaseOperationId } from "./dataClient.js";
import {
  ready,
  createPasswordReset,
  login,
  logout as endSession,
  changePassword,
  getUser,
  isAuthenticated,
  refreshSession,
  resetPassword,
  setPasswordSetupAllowed,
  setPasswordForPerson,
  setupPassword,
  subscribeAuth,
} from "./authClient.js";
import { diagnostic } from "./diagnostics.js";
import { clearProfileModalContent } from "./profileModalState.js";

const readPublicProfile = createEndpoint("publicProfile");
const readMyProfile = createEndpoint("myProfile");
const addMatch = createEndpoint("addMatch");
const withdrawFromRanking = createEndpoint("withdrawFromRanking");
let withdrawContext = null;
let adminPasswordTarget = null;
let profileRequestGeneration = 0;
let profileActionController = null;
let modalAuthIdentity = null;

function errorMessage(value, fallback) {
  if (value instanceof Error && value.message) return value.message;
  if (value?.error?.message) return value.error.message;
  if (typeof value?.error === "string") return value.error;
  if (value?.message) return value.message;
  return fallback;
}

window.showToast = function (message, type = "info") {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = String(message || "");
  container.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
};

function createModal(id, content, { explicitDismiss = false } = {}) {
  const modal = document.createElement("div");
  modal.id = id;
  modal.className = `modal hidden${explicitDismiss ? " explicit-dismiss" : ""}`;
  modal.innerHTML = `
    <div class="modal-content">
      <button type="button" class="close" aria-label="Abbrechen">&times;</button>
      ${content}
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function openModal(modal) {
  modal?.classList.remove("hidden");
}

function setModalBusy(form, busy) {
  const modal = form.closest(".explicit-dismiss");
  if (!modal) return;
  modal.dataset.busy = busy ? "true" : "false";
  modal.querySelectorAll("button").forEach((button) => {
    button.disabled = busy;
  });
}

function closeModal(modal) {
  modal?.classList.add("hidden");
  if (modal?.classList.contains("explicit-dismiss")) {
    modal.querySelector("form")?.reset();
    modal.querySelectorAll('input[autocomplete="current-password"], input[autocomplete="new-password"]').forEach((input) => {
      input.type = "password";
    });
    modal.querySelectorAll(".toggle-password").forEach((toggle) => {
      toggle.innerHTML = "&#128065;";
    });
  }
  if (modal?.id === "withdrawModal") withdrawContext = null;
  if (modal?.id === "profileModal") {
    profileRequestGeneration += 1;
    clearProfileModalContent(modal, profileActionController);
    profileActionController = null;
  }
  if (modal?.id === "resetPasswordModal") document.getElementById("resetPasswordForm")?.reset();
  if (modal?.id === "passwordSetupModal") document.getElementById("passwordSetupForm")?.reset();
  if (modal?.id === "adminPasswordModal") {
    adminPasswordTarget = null;
    document.getElementById("adminPasswordForm")?.reset();
  }
  if (modal?.id === "resetProofModal") {
    const token = document.getElementById("resetProofValue");
    const target = document.getElementById("resetProofTarget");
    if (token) token.textContent = "";
    if (target) target.textContent = "";
  }
}

const loginModal = createModal("loginModal", `
  <h2>Login</h2>
  <form id="loginForm" method="post" action="/api/session" autocomplete="on">
    <label for="email">E-Mail:</label>
    <input type="email" id="email" name="username" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false" required>

    <label for="password">Passwort:</label>
    <div style="position: relative; margin-bottom: 16px;">
      <input type="password" id="password" name="password" autocomplete="current-password" required style="width: 100%; padding-right: 40px;">
      <span class="toggle-password" data-target="password" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; user-select: none;">&#128065;</span>
    </div>

    <button type="submit" class="btn-login">Anmelden</button>
    <button type="button" id="openPasswordSetup" class="btn-login">Erstmals Passwort vergeben</button>
    <button type="button" id="openPasswordReset" class="btn-login">Reset-Code verwenden</button>
    <button type="button" class="btn-login modal-cancel">Abbrechen</button>
  </form>
`, { explicitDismiss: true });

const passwordModal = createModal("changePasswordModal", `
  <h2>Passwort ändern</h2>
  <form id="changePasswordForm" method="post" action="/api/password" autocomplete="on">
    <input type="text" id="changePasswordUsername" name="username" autocomplete="username" class="password-manager-username" tabindex="-1" aria-hidden="true" readonly>
    <label for="currentPassword">Aktuelles Passwort:</label>
    <div style="position: relative; margin-bottom: 16px;">
      <input type="password" id="currentPassword" name="currentPassword" autocomplete="current-password" required style="width: 100%; padding-right: 40px;">
      <span class="toggle-password" data-target="currentPassword" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; user-select: none;">&#128065;</span>
    </div>

    <label for="newPassword">Neues Passwort:</label>
    <div style="position: relative; margin-bottom: 16px;">
      <input type="password" id="newPassword" name="newPassword" autocomplete="new-password" minlength="6" required style="width: 100%; padding-right: 40px;">
      <span class="toggle-password" data-target="newPassword" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; user-select: none;">&#128065;</span>
    </div>

    <label for="confirmPassword">Passwort bestätigen:</label>
    <div style="position: relative; margin-bottom: 16px;">
      <input type="password" id="confirmPassword" name="confirmPassword" autocomplete="new-password" minlength="6" required style="width: 100%; padding-right: 40px;">
      <span class="toggle-password" data-target="confirmPassword" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; user-select: none;">&#128065;</span>
    </div>

    <button type="submit" class="btn-login">Speichern</button>
    <button type="button" class="btn-login modal-cancel">Abbrechen</button>
  </form>
`, { explicitDismiss: true });

const resetPasswordModal = createModal("resetPasswordModal", `
  <h2>Passwort zurücksetzen</h2>
  <form id="resetPasswordForm" method="post" action="/api/password-reset" autocomplete="on">
    <label for="resetToken">Einmaliger Reset-Code:</label>
    <input type="text" id="resetToken" name="resetToken" autocomplete="one-time-code" minlength="32" maxlength="128" required>
    <label for="resetNewPassword">Neues Passwort:</label>
    <input type="password" id="resetNewPassword" name="newPassword" autocomplete="new-password" minlength="6" required>
    <label for="resetConfirmPassword">Passwort bestätigen:</label>
    <input type="password" id="resetConfirmPassword" name="confirmPassword" autocomplete="new-password" minlength="6" required>
    <button type="submit" class="btn-login">Passwort setzen</button>
    <button type="button" class="btn-login modal-cancel">Abbrechen</button>
  </form>
`, { explicitDismiss: true });

const passwordSetupModal = createModal("passwordSetupModal", `
  <h2>Erstmals Passwort vergeben</h2>
  <p>Diese Funktion muss zuvor von einem Administrator freigegeben werden.</p>
  <form id="passwordSetupForm" method="post" action="/api/password-setup" autocomplete="on">
    <label for="setupEmail">E-Mail:</label>
    <input type="email" id="setupEmail" name="username" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false" required>
    <label for="setupNewPassword">Neues Passwort:</label>
    <input type="password" id="setupNewPassword" name="newPassword" autocomplete="new-password" minlength="6" required>
    <label for="setupConfirmPassword">Passwort bestätigen:</label>
    <input type="password" id="setupConfirmPassword" name="confirmPassword" autocomplete="new-password" minlength="6" required>
    <button type="submit" class="btn-login">Passwort setzen</button>
    <button type="button" class="btn-login modal-cancel">Abbrechen</button>
  </form>
`, { explicitDismiss: true });

const resetProofModal = createModal("resetProofModal", `
  <h2>Einmaliger Reset-Code</h2>
  <p id="resetProofTarget"></p>
  <p>Dieser Code ist zeitlich begrenzt und wird nur jetzt angezeigt.</p>
  <code id="resetProofValue"></code>
  <button type="button" id="copyResetProof" class="btn-login">Code kopieren</button>
`);

const adminPasswordModal = createModal("adminPasswordModal", `
  <h2>Passwort direkt setzen</h2>
  <p id="adminPasswordTarget"></p>
  <form id="adminPasswordForm" method="post" action="/api/admin/password" autocomplete="off">
    <label for="adminNewPassword">Neues Passwort:</label>
    <input type="password" id="adminNewPassword" name="newPassword" autocomplete="new-password" minlength="6" required>
    <label for="adminConfirmPassword">Passwort bestätigen:</label>
    <input type="password" id="adminConfirmPassword" name="confirmPassword" autocomplete="new-password" minlength="6" required>
    <button type="submit" class="btn-login">Passwort setzen</button>
    <button type="button" class="btn-login modal-cancel">Abbrechen</button>
  </form>
`, { explicitDismiss: true });

const profileModal = createModal("profileModal", `
  <h2 id="profileName">Profil</h2>
  <div id="profileText">Lade Profildaten...</div>
  <div id="profileActions" style="display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; margin-top: 16px;"></div>
`);

const withdrawModal = createModal("withdrawModal", `
  <h2>Raushängen</h2>
  <form id="withdrawForm">
    <label for="withdrawReason">Grund für das Raushängen:</label>
    <textarea id="withdrawReason" name="withdrawReason" minlength="3" maxlength="500" required placeholder="Bitte geben Sie den Grund ein..." style="width: 100%; min-height: 100px; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-family: inherit;"></textarea>

    <div style="display: flex; gap: 10px; margin-top: 12px; justify-content: flex-end;">
      <button type="submit" class="btn-login">Senden</button>
    </div>
  </form>
`);

function formatPhone(value) {
  return String(value || "").trim().replace(/^0043/, "+43") || "---";
}

function formatBirthDate(value) {
  const raw = String(value || "").trim();
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[3]}.${compact[2]}.${compact[1]}`;
  const short = raw.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (short) return `${short[3]}.${short[2]}.${Number(short[1]) >= 50 ? "19" : "20"}${short[1]}`;
  return raw || "---";
}

function profileName(profile) {
  return [profile?.firstName, profile?.lastName]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ") || "Unbekanntes Profil";
}

async function copyProfileValue(value, label) {
  try {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        copied = true;
      } catch {}
    }
    if (!copied) {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.readOnly = true;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      try {
        textarea.select();
        copied = document.execCommand("copy");
      } finally {
        textarea.remove();
      }
      if (!copied) throw new Error("Clipboard unavailable");
    }
    window.showToast(`${label} kopiert.`, "success");
  } catch {
    window.showToast(`${label} konnte nicht kopiert werden.`, "error");
  }
}

function appendProfileField(container, label, value, copyValue = "", signal) {
  const row = document.createElement("p");
  row.className = "profile-field";
  const strong = document.createElement("strong");
  strong.textContent = `${label}: `;
  const valueElement = document.createElement("span");
  valueElement.className = "profile-field-value";
  valueElement.textContent = String(value || "---");
  row.appendChild(strong);
  row.appendChild(valueElement);

  if (copyValue) {
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "profile-copy-button";
    copyButton.setAttribute("aria-label", `${label} kopieren`);
    copyButton.title = `${label} kopieren`;
    const icon = document.createElement("span");
    icon.className = "profile-copy-icon";
    icon.setAttribute("aria-hidden", "true");
    copyButton.appendChild(icon);
    copyButton.addEventListener("click", () => copyProfileValue(copyValue, label), { signal });
    row.appendChild(copyButton);
  }

  container.appendChild(row);
}

function appendContactFields(container, profile, signal) {
  const email = String(profile.email || "").trim();
  const phone = String(profile.phone || "").trim();
  const displayedPhone = formatPhone(phone);
  appendProfileField(container, "E-Mail", email, email, signal);
  appendProfileField(container, "Telefon", displayedPhone, phone ? displayedPhone : "", signal);
  appendProfileField(container, "Geburtsdatum", formatBirthDate(profile.birthDate), "", signal);
}

function openPasswordModal() {
  if (!isAuthenticated()) {
    window.showToast("Bitte zuerst anmelden.", "error");
    window.openLoginModal();
    return;
  }

  const form = document.getElementById("changePasswordForm");
  form?.reset();
  if (form) form.elements.username.value = getUser()?.email || "";
  closeModal(profileModal);
  openModal(passwordModal);
  document.getElementById("currentPassword")?.focus();
}

window.openLoginModal = () => {
  openModal(loginModal);
  document.getElementById("email")?.focus();
};

window.openProfileModal = async (options = {}) => {
  const requestGeneration = ++profileRequestGeneration;
  await ready;
  if (requestGeneration !== profileRequestGeneration) return;

  const requestedId = String(options.playerId || "").trim();
  const sessionUser = getUser();
  const ownProfile = !requestedId || (sessionUser && requestedId === String(sessionUser.id));

  if (ownProfile && !sessionUser) {
    window.showToast("Bitte zuerst anmelden.", "error");
    window.openLoginModal();
    return;
  }

  const nameElement = document.getElementById("profileName");
  const textElement = document.getElementById("profileText");
  const actionsElement = document.getElementById("profileActions");
  profileActionController?.abort();
  profileActionController = new AbortController();
  const actionSignal = profileActionController.signal;
  profileModal.dataset.profileScope = ownProfile ? "private" : "public";
  nameElement.textContent = "Lade Profil...";
  textElement.textContent = "";
  actionsElement.replaceChildren();
  actionsElement.style.setProperty("display", "none", "important");
  openModal(profileModal);

  try {
    const result = ownProfile
      ? await readMyProfile()
      : await readPublicProfile({ id: requestedId });
    if (requestGeneration !== profileRequestGeneration) return;
    const data = result.data;

    if (!data?.success || !data.profile) {
      throw new Error(errorMessage(data, "Profil konnte nicht geladen werden."));
    }

    const profile = data.profile;
    nameElement.textContent = profileName(profile);

    if (ownProfile) {
      appendContactFields(textElement, profile, actionSignal);

      const passwordButton = document.createElement("button");
      passwordButton.type = "button";
      passwordButton.className = "btn-login";
      passwordButton.textContent = "Passwort ändern";
      passwordButton.addEventListener("click", openPasswordModal, { once: true, signal: actionSignal });
      actionsElement.appendChild(passwordButton);
      actionsElement.style.setProperty("display", "flex", "important");
      return;
    }

    if (sessionUser) appendContactFields(textElement, profile, actionSignal);
    else textElement.textContent = "Öffentliches Spielerprofil";
    const canChallenge = options.canChallenge === true
      || options.boxElement?.classList.contains("challengeable");
    const bewerbId = String(options.bewerbId || "").trim();

    if (sessionUser?.role === "admin") {
      const setupButton = document.createElement("button");
      setupButton.type = "button";
      setupButton.className = "btn-login";
      setupButton.textContent = profile.passwordSetupAllowed
        ? "Passwortfreigabe aufheben"
        : "Passwortvergabe freigeben";
      setupButton.addEventListener("click", async () => {
        const allowed = !profile.passwordSetupAllowed;
        setupButton.disabled = true;
        try {
          await setPasswordSetupAllowed(profile.id, allowed);
          profile.passwordSetupAllowed = allowed;
          setupButton.textContent = allowed ? "Passwortfreigabe aufheben" : "Passwortvergabe freigeben";
          window.showToast(
            allowed ? `Passwortvergabe für ${profileName(profile)} ist freigegeben.` : "Passwortfreigabe wurde aufgehoben.",
            "success",
          );
        } catch (error) {
          window.showToast(errorMessage(error, "Passwortfreigabe konnte nicht geändert werden."), "error");
        } finally {
          setupButton.disabled = false;
        }
      }, { signal: actionSignal });
      actionsElement.appendChild(setupButton);

      const resetButton = document.createElement("button");
      resetButton.type = "button";
      resetButton.className = "btn-login";
      resetButton.textContent = "Reset-Code erstellen";
      resetButton.addEventListener("click", async () => {
        const generation = profileRequestGeneration;
        const adminId = sessionUser.id;
        resetButton.disabled = true;
        try {
          const result = await createPasswordReset(profile.id);
          if (!result?.resetToken) throw new Error("Der Server hat keinen Reset-Code geliefert.");
          if (generation !== profileRequestGeneration || getUser()?.id !== adminId || getUser()?.role !== "admin") return;
          document.getElementById("resetProofValue").textContent = result.resetToken;
          document.getElementById("resetProofTarget").textContent = `Für ${profileName(profile)}`;
          closeModal(profileModal);
          openModal(resetProofModal);
        } catch (error) {
          window.showToast(errorMessage(error, "Reset-Code konnte nicht erstellt werden."), "error");
          resetButton.disabled = false;
        }
      }, { signal: actionSignal });
      actionsElement.appendChild(resetButton);

      const setPasswordButton = document.createElement("button");
      setPasswordButton.type = "button";
      setPasswordButton.className = "btn-login";
      setPasswordButton.textContent = "Passwort direkt setzen";
      setPasswordButton.addEventListener("click", () => {
        adminPasswordTarget = { id: profile.id, name: profileName(profile) };
        document.getElementById("adminPasswordForm")?.reset();
        document.getElementById("adminPasswordTarget").textContent = `Für ${adminPasswordTarget.name}`;
        closeModal(profileModal);
        openModal(adminPasswordModal);
        document.getElementById("adminNewPassword")?.focus();
      }, { signal: actionSignal });
      actionsElement.appendChild(setPasswordButton);
      actionsElement.style.setProperty("display", "flex", "important");
    }

    if (!canChallenge || !bewerbId) return;

    const challengeButton = document.createElement("button");
    challengeButton.type = "button";
    challengeButton.className = "btn-login";
    challengeButton.textContent = "Fordern";
    actionsElement.appendChild(challengeButton);
    actionsElement.style.setProperty("display", "flex", "important");

    challengeButton.addEventListener("click", async () => {
      if (!isAuthenticated()) {
        window.showToast("Bitte zuerst anmelden.", "error");
        closeModal(profileModal);
        window.openLoginModal();
        return;
      }

      challengeButton.disabled = true;
      challengeButton.textContent = "Sende...";
      const operationKey = `match:add:${bewerbId}:${profile.id}`;

      try {
        const matchResult = await addMatch({
          operationId: getOperationId(operationKey),
          bewerbId,
          opponentId: String(profile.id),
        });

        if (!matchResult.data?.success) {
          throw new Error(errorMessage(matchResult.data, "Herausforderung konnte nicht gespeichert werden."));
        }

        releaseOperationId(operationKey);
        window.showToast("Herausforderung erfolgreich gesendet!", "success");
        closeModal(profileModal);
        setTimeout(() => window.location.reload(), 1000);
      } catch (error) {
        releaseOperationId(operationKey, error);
        diagnostic.error("profile_challenge_failed", error);
        window.showToast(errorMessage(error, "Herausforderung fehlgeschlagen."), "error");
        challengeButton.disabled = false;
        challengeButton.textContent = "Fordern";
      }
    }, { signal: actionSignal });
  } catch (error) {
    if (requestGeneration !== profileRequestGeneration) return;
    diagnostic.error("profile_load_failed", error);
    nameElement.textContent = "Fehler beim Laden";
    textElement.textContent = errorMessage(error, "Profil konnte nicht geladen werden.");
  }
};

subscribeAuth((user) => {
  const identity = user ? `${user.id || ""}:${user.role || ""}` : "anonymous";
  if (modalAuthIdentity !== null && modalAuthIdentity !== identity) {
    closeModal(profileModal);
    closeModal(resetProofModal);
    closeModal(adminPasswordModal);
  }
  modalAuthIdentity = identity;
  if (user) return;
  withdrawContext = null;
  closeModal(passwordModal);
  closeModal(adminPasswordModal);
  closeModal(resetProofModal);
  closeModal(withdrawModal);
  closeModal(profileModal);
});

window.openWithdrawModal = ({ rank, bewerbId } = {}) => {
  const numericRank = Number(rank);
  const normalizedBewerbId = String(bewerbId || "").trim();

  if (!isAuthenticated()) {
    window.showToast("Bitte zuerst anmelden.", "error");
    window.openLoginModal();
    return;
  }

  if (!Number.isInteger(numericRank) || numericRank < 1 || !normalizedBewerbId) {
    window.showToast("Rang oder Bewerb fehlt.", "error");
    return;
  }

  withdrawContext = { rank: numericRank, bewerbId: normalizedBewerbId };
  document.getElementById("withdrawForm")?.reset();
  openModal(withdrawModal);
  document.getElementById("withdrawReason")?.focus();
};

document.getElementById("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const email = form.elements.username.value.trim();
  const password = form.elements.password.value;

  setModalBusy(form, true);
  submitButton.textContent = "Anmelden...";

  try {
    await login(email, password);
    form.reset();
    closeModal(loginModal);
    window.showToast("Erfolgreich angemeldet.", "success");
  } catch (error) {
    diagnostic.error("login_failed", error);
    const message = error.code === "LOGIN_FAILED"
      ? "E-Mail oder Passwort ist ungültig."
      : errorMessage(error, "Anmeldung fehlgeschlagen.");
    window.showToast(message, "error");
  } finally {
    setModalBusy(form, false);
    submitButton.textContent = "Anmelden";
  }
});

document.getElementById("changePasswordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const currentPassword = form.elements.currentPassword.value;
  const newPassword = form.elements.newPassword.value;
  const confirmation = form.elements.confirmPassword.value;

  if (newPassword.length < 6) {
    window.showToast("Das neue Passwort muss mindestens 6 Zeichen lang sein.", "error");
    return;
  }
  if (newPassword !== confirmation) {
    window.showToast("Die Passwörter stimmen nicht überein.", "error");
    return;
  }

  setModalBusy(form, true);
  submitButton.textContent = "Wird gespeichert...";

  try {
    const result = await changePassword(currentPassword, newPassword);
    if (!result?.success) {
      throw new Error(errorMessage(result, "Passwort konnte nicht geändert werden."));
    }
    form.reset();
    closeModal(passwordModal);
    window.showToast("Passwort wurde erfolgreich geändert.", "success");
  } catch (error) {
    window.showToast(errorMessage(error, "Passwort konnte nicht geändert werden."), "error");
  } finally {
    setModalBusy(form, false);
    submitButton.textContent = "Speichern";
  }
});

document.getElementById("openPasswordReset").addEventListener("click", () => {
  document.getElementById("resetPasswordForm")?.reset();
  closeModal(loginModal);
  openModal(resetPasswordModal);
  document.getElementById("resetToken")?.focus();
});

document.getElementById("openPasswordSetup").addEventListener("click", () => {
  document.getElementById("passwordSetupForm")?.reset();
  const loginEmail = document.getElementById("email")?.value.trim();
  if (loginEmail) document.getElementById("setupEmail").value = loginEmail;
  closeModal(loginModal);
  openModal(passwordSetupModal);
  document.getElementById(loginEmail ? "setupNewPassword" : "setupEmail")?.focus();
});

document.getElementById("passwordSetupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const email = form.elements.username.value.trim();
  const newPassword = form.elements.newPassword.value;
  const confirmation = form.elements.confirmPassword.value;
  if (newPassword.length < 6 || newPassword !== confirmation) {
    window.showToast(
      newPassword.length < 6 ? "Das neue Passwort muss mindestens 6 Zeichen lang sein." : "Die Passwörter stimmen nicht überein.",
      "error",
    );
    return;
  }
  setModalBusy(form, true);
  try {
    await setupPassword(email, newPassword);
    form.reset();
    closeModal(passwordSetupModal);
    window.showToast("Passwort wurde gesetzt. Du kannst dich jetzt anmelden.", "success");
    window.openLoginModal();
    document.getElementById("email").value = email;
  } catch (error) {
    const message = error.code === "PASSWORD_SETUP_INVALID"
      ? "Passwortvergabe ist für diese E-Mail nicht freigegeben."
      : errorMessage(error, "Passwort konnte nicht gesetzt werden.");
    window.showToast(message, "error");
  } finally {
    setModalBusy(form, false);
  }
});

document.getElementById("resetPasswordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const resetToken = form.elements.resetToken.value.trim();
  const newPassword = form.elements.newPassword.value;
  const confirmation = form.elements.confirmPassword.value;
  if (newPassword.length < 6 || newPassword !== confirmation) {
    const message = newPassword.length < 6
      ? "Das neue Passwort muss mindestens 6 Zeichen lang sein."
      : "Die Passwörter stimmen nicht überein.";
    window.showToast(message, "error");
    return;
  }
  setModalBusy(form, true);
  try {
    await resetPassword(resetToken, newPassword);
    form.reset();
    closeModal(resetPasswordModal);
    window.showToast("Passwort wurde gesetzt. Du kannst dich jetzt anmelden.", "success");
    window.openLoginModal();
  } catch (error) {
    window.showToast(errorMessage(error, "Passwort konnte nicht zurückgesetzt werden."), "error");
  } finally {
    setModalBusy(form, false);
  }
});

document.getElementById("adminPasswordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const newPassword = form.elements.newPassword.value;
  const confirmation = form.elements.confirmPassword.value;
  if (!adminPasswordTarget || getUser()?.role !== "admin") {
    window.showToast("Administratorberechtigung fehlt.", "error");
    closeModal(adminPasswordModal);
    return;
  }
  if (newPassword.length < 6 || newPassword !== confirmation) {
    window.showToast(
      newPassword.length < 6 ? "Das neue Passwort muss mindestens 6 Zeichen lang sein." : "Die Passwörter stimmen nicht überein.",
      "error",
    );
    return;
  }

  setModalBusy(form, true);
  const target = { ...adminPasswordTarget };
  try {
    await setPasswordForPerson(target.id, newPassword);
    if (target.id === getUser()?.id) {
      await refreshSession({ reconnect: true, forceReconnect: true });
    }
    window.showToast(`Passwort für ${target.name} wurde gesetzt.`, "success");
    closeModal(adminPasswordModal);
  } catch (error) {
    window.showToast(errorMessage(error, "Passwort konnte nicht gesetzt werden."), "error");
  } finally {
    setModalBusy(form, false);
  }
});

document.getElementById("copyResetProof").addEventListener("click", async () => {
  const token = document.getElementById("resetProofValue").textContent;
  if (!token) return;
  try {
    await navigator.clipboard.writeText(token);
    window.showToast("Reset-Code wurde kopiert.", "success");
  } catch {
    window.showToast("Reset-Code konnte nicht automatisch kopiert werden.", "error");
  }
});

document.getElementById("withdrawForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const reason = form.elements.withdrawReason.value.trim();

  if (!withdrawContext) {
    window.showToast("Rang oder Bewerb fehlt.", "error");
    closeModal(withdrawModal);
    return;
  }
  if (reason.length < 3) {
    window.showToast("Bitte geben Sie einen Grund mit mindestens 3 Zeichen an.", "error");
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Sende...";
  const operationKey = `ranking:withdraw:${withdrawContext.bewerbId}:${withdrawContext.rank}:${reason}`;

  try {
    const result = await withdrawFromRanking({
      operationId: getOperationId(operationKey),
      bewerbId: withdrawContext.bewerbId,
      rank: withdrawContext.rank,
      reason,
    });

    if (!result.data?.success) {
      throw new Error(errorMessage(result.data, "Rückzug konnte nicht gespeichert werden."));
    }

    releaseOperationId(operationKey);
    withdrawContext = null;
    form.reset();
    closeModal(withdrawModal);
    window.showToast("Rückzug wurde erfolgreich gesendet.", "success");
    setTimeout(() => window.location.reload(), 1000);
  } catch (error) {
    releaseOperationId(operationKey, error);
    diagnostic.error("ranking_withdraw_failed", error);
    window.showToast(errorMessage(error, "Rückzug konnte nicht gespeichert werden."), "error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Senden";
  }
});

let logoutInProgress = false;

document.addEventListener("click", async (event) => {
  if (!(event.target instanceof Element)) return;

  const passwordToggle = event.target.closest(".toggle-password");
  if (passwordToggle) {
    const input = document.getElementById(passwordToggle.dataset.target);
    if (input) {
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      passwordToggle.innerHTML = reveal ? "&#128584;" : "&#128065;";
    }
    return;
  }

  const closeButton = event.target.closest(".modal .close");
  if (closeButton) {
    const modal = closeButton.closest(".modal");
    if (modal.dataset.busy !== "true") closeModal(modal);
    return;
  }
  const cancelButton = event.target.closest(".modal-cancel");
  if (cancelButton) {
    const modal = cancelButton.closest(".modal");
    if (modal.dataset.busy !== "true") closeModal(modal);
    return;
  }
  if (event.target.classList.contains("modal")) {
    if (!event.target.classList.contains("explicit-dismiss")) closeModal(event.target);
    return;
  }

  const authAction = event.target.closest(
    "#openLogin, #openLoginMobile, #profileButton, #profileButtonMobile, #signOutButton, #signOutButtonMobile"
  );
  if (!authAction) return;

  event.preventDefault();
  closeModal(document.getElementById("mobileNavModal"));

  if (authAction.id === "openLogin" || authAction.id === "openLoginMobile") {
    window.openLoginModal();
    return;
  }
  if (authAction.id === "profileButton" || authAction.id === "profileButtonMobile") {
    window.openProfileModal();
    return;
  }
  if (logoutInProgress) return;

  logoutInProgress = true;
  document.querySelectorAll("#signOutButton, #signOutButtonMobile").forEach((button) => {
    button.setAttribute("aria-disabled", "true");
  });

  try {
    closeModal(profileModal);
    await endSession();
    closeModal(passwordModal);
    closeModal(adminPasswordModal);
    window.showToast("Erfolgreich abgemeldet.", "success");
  } catch (error) {
    diagnostic.error("logout_failed", error);
    window.showToast(errorMessage(error, "Abmeldung fehlgeschlagen."), "error");
  } finally {
    logoutInProgress = false;
    document.querySelectorAll("#signOutButton, #signOutButtonMobile").forEach((button) => {
      button.removeAttribute("aria-disabled");
    });
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  document.querySelectorAll(".modal:not(.hidden):not(.explicit-dismiss)").forEach(closeModal);
});
