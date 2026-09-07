import { createEndpoint, getOperationId, releaseOperationId } from "./dataClient.js";
import { formatWalkoverResult } from "./matchCompletionText.js";
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
import { categorizedProfileCompetitions, clearProfileModalContent } from "./profileModalState.js";

const readPublicProfile = createEndpoint("publicProfile");
const readMyProfile = createEndpoint("myProfile");
const readMyMessageSummary = createEndpoint("myMessageSummary");
const readMyMessages = createEndpoint("myMessages");
const readMyMessage = createEndpoint("myMessage");
const acknowledgeMessage = createEndpoint("acknowledgeMessage");
const addMatch = createEndpoint("addMatch");
const setMatchAppointment = createEndpoint("setMatchAppointment");
const adminDeleteRankingChallenge = createEndpoint("adminDeleteRankingChallenge");
const adminSetRankingChallengeDate = createEndpoint("adminSetRankingChallengeDate");
const adminSetMatchAppointment = createEndpoint("adminSetMatchAppointment");
const matchResultSuggestion = createEndpoint("matchResultSuggestion");
const setMatchResult = createEndpoint("setMatchResult");
const adminSetMatchEnd = createEndpoint("adminSetMatchEnd");
const adminClearMatchResult = createEndpoint("adminClearMatchResult");
const adminCorrectRankingResult = createEndpoint("adminCorrectRankingResult");
const withdrawFromRanking = createEndpoint("withdrawFromRanking");
const readWithdrawnRankingPlayers = createEndpoint("withdrawnRankingPlayers");
let withdrawContext = null;
let matchDateContext = null;
let matchCalendarMonth = null;
let adminRankingActionContext = null;
let matchResultContext = null;
let adminPasswordTarget = null;
let profileRequestGeneration = 0;
let profileActionController = null;
let modalAuthIdentity = null;
let messageState = null;
let messageDetailReturnFocus = null;
let adminRankingReturnFocus = null;
let matchResultReturnFocus = null;
let matchResultScore = [];
let matchResultStatusTimer = null;

function errorMessage(value, fallback) {
  if (value instanceof Error && value.message) return value.message;
  if (value?.error?.message) return value.error.message;
  if (typeof value?.error === "string") return value.error;
  if (value?.message) return value.message;
  return fallback;
}

function setLoginStatus(message = "") {
  const status = document.getElementById("loginStatus");
  if (!status) return;
  status.textContent = message;
  status.hidden = !message;
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
  if (modal) document.body.classList.add("modal-open");
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
  if (modal?.id === "matchDateModal") matchDateContext = null;
  if (modal?.id === "adminRankingActionModal") adminRankingActionContext = null;
  if (modal?.id === "matchResultModal") {
    matchResultContext = null;
    matchResultScore = [];
    clearTimeout(matchResultStatusTimer);
  }
  if (modal?.id === "profileModal") {
    closeModal(matchDateModal);
    closeModal(adminRankingActionModal);
    closeModal(matchResultModal);
    closeModal(messageDetailModal);
    profileRequestGeneration += 1;
    clearProfileModalContent(modal, profileActionController);
    profileActionController = null;
    messageState = null;
  }
  if (modal?.id === "messageDetailModal") {
    const returnFocus = messageDetailReturnFocus;
    messageDetailReturnFocus = null;
    profileModal.inert = false;
    profileModal.removeAttribute("aria-hidden");
    if (returnFocus?.isConnected && !profileModal.classList.contains("hidden")) returnFocus.focus();
  }
  if (modal?.id === "adminRankingActionModal") {
    const returnFocus = adminRankingReturnFocus;
    adminRankingReturnFocus = null;
    profileModal.inert = false;
    profileModal.removeAttribute("aria-hidden");
    if (returnFocus?.isConnected && !profileModal.classList.contains("hidden")) returnFocus.focus();
  }
  if (modal?.id === "matchResultModal") {
    const returnFocus = matchResultReturnFocus;
    matchResultReturnFocus = null;
    profileModal.inert = false;
    profileModal.removeAttribute("aria-hidden");
    if (returnFocus?.isConnected && !profileModal.classList.contains("hidden")) returnFocus.focus();
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
  if (!document.querySelector(".modal:not(.hidden)")) document.body.classList.remove("modal-open");
}

const loginModal = createModal("loginModal", `
  <h2>Login</h2>
  <form id="loginForm" method="post" action="/api/session" autocomplete="on">
    <label for="login">Login:</label>
    <input type="text" id="login" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required>

    <label for="password">Passwort:</label>
    <div style="position: relative; margin-bottom: 16px;">
      <input type="password" id="password" name="password" autocomplete="current-password" required style="width: 100%; padding-right: 40px;">
      <span class="toggle-password" data-target="password" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; user-select: none;">&#128065;</span>
    </div>

    <p id="loginStatus" class="login-status" role="alert" aria-live="assertive" aria-atomic="true" hidden></p>

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
    <label for="setupLogin">Login:</label>
    <input type="text" id="setupLogin" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required>
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
  <div id="profileTabs" class="profile-tabs" role="tablist" aria-label="Profilbereiche"></div>
  <div id="profileCurrentCompetitionTabs" class="profile-tabs profile-competition-tabs" role="tablist" aria-label="Aktuelle Bewerbe" hidden></div>
  <div id="profileArchiveCompetitionTabs" class="profile-tabs profile-competition-tabs" role="tablist" aria-label="Archivierte Bewerbe" hidden></div>
  <div id="profileBody" class="profile-body" aria-live="polite">
    <section id="profileSystemPanel" class="profile-panel" role="tabpanel">
      <div id="profileText">Lade Profildaten...</div>
      <div id="profileSystemActions" class="profile-actions"></div>
    </section>
    <section id="profileMessagesPanel" class="profile-panel" role="tabpanel" hidden></section>
    <div id="profileRankingPanels"></div>
    <section id="profileAdminPanel" class="profile-panel" role="tabpanel" hidden>
      <div id="profileAdminActions" class="profile-actions"></div>
    </section>
  </div>
`);
profileModal.classList.add("profile-modal");
profileModal.setAttribute("role", "dialog");
profileModal.setAttribute("aria-modal", "true");
profileModal.setAttribute("aria-labelledby", "profileName");
profileModal.querySelector(".modal-content")?.classList.add("profile-dialog");
profileModal.querySelector(".close")?.setAttribute("aria-label", "Profil schließen");

const messageDetailModal = createModal("messageDetailModal", `
  <h2 id="messageDetailSubject">Meldung</h2>
  <p id="messageDetailDate" class="message-detail-date"></p>
  <p id="messageDetailCompetition" class="message-detail-competition"></p>
  <p id="messageDetailActor" class="message-detail-actor" hidden></p>
  <div id="messageDetailBody" class="message-detail-body"></div>
  <button type="button" id="acknowledgeMessageButton" class="btn-login">Zur Kenntnis genommen</button>
  <p id="messageDetailStatus" class="message-detail-status" role="status" aria-live="polite"></p>
  <p id="messageDetailAnnouncement" class="sr-only" role="status" aria-live="polite"></p>
`);
messageDetailModal.classList.add("message-detail-modal");
messageDetailModal.setAttribute("role", "dialog");
messageDetailModal.setAttribute("aria-modal", "true");
messageDetailModal.setAttribute("aria-labelledby", "messageDetailSubject");
messageDetailModal.querySelector(".modal-content")?.classList.add("message-detail-dialog");
messageDetailModal.querySelector(".close")?.setAttribute("aria-label", "Meldung schließen");

const withdrawModal = createModal("withdrawModal", `
  <h2>Raushängen</h2>
  <form id="withdrawForm">
    <label for="withdrawReason">Grund für das Raushängen:</label>
    <textarea id="withdrawReason" name="withdrawReason" minlength="3" maxlength="500" required placeholder="Bitte geben Sie den Grund ein..." style="width: 100%; min-height: 100px; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-family: inherit;"></textarea>

    <div style="display: flex; gap: 10px; margin-top: 12px; justify-content: flex-end;">
      <button type="submit" class="btn-login">Verbindlich raushängen</button>
    </div>
  </form>
`, { explicitDismiss: true });

const matchDateModal = createModal("matchDateModal", `
  <h2 id="matchDateTitle">Termin eintragen</h2>
  <form id="matchDateForm">
    <span class="match-date-label">Datum:</span>
    <input type="hidden" id="rankingMatchDay" name="rankingMatchDay">
    <div class="match-date-calendar" aria-label="Spieltermin-Datum auswählen">
      <div class="match-date-calendar-header">
        <button type="button" id="matchDatePreviousMonth" class="match-date-month-button" aria-label="Vorheriger Monat">‹</button>
        <strong id="matchDateCalendarMonth" aria-live="polite"></strong>
        <button type="button" id="matchDateNextMonth" class="match-date-month-button" aria-label="Nächster Monat">›</button>
      </div>
      <div class="match-date-weekdays" aria-hidden="true"><span>Mo</span><span>Di</span><span>Mi</span><span>Do</span><span>Fr</span><span>Sa</span><span>So</span></div>
      <div id="matchDateCalendarDays" class="match-date-calendar-days" role="grid"></div>
    </div>
    <label for="rankingMatchHour">Uhrzeit:</label>
    <select id="rankingMatchHour" name="rankingMatchHour" required>
      ${Array.from({ length: 18 }, (_, index) => `<option value="${String(index + 6).padStart(2, "0")}">${String(index + 6).padStart(2, "0")}:00 Uhr</option>`).join("")}
    </select>
    <div id="matchDateReasonFields" hidden>
      <label for="matchDateReason">Grund:</label>
      <textarea id="matchDateReason" name="reason" maxlength="500" placeholder="Bitte geben Sie den Grund ein..."></textarea>
    </div>
    <button type="submit" class="btn-login">Übernehmen</button>
  </form>
`, { explicitDismiss: true });
matchDateModal.setAttribute("role", "dialog");
matchDateModal.setAttribute("aria-modal", "true");
matchDateModal.setAttribute("aria-labelledby", "matchDateTitle");
matchDateModal.querySelector(".close")?.setAttribute("aria-label", "Terminauswahl schließen");

const adminRankingActionModal = createModal("adminRankingActionModal", `
  <h2 id="adminRankingActionTitle">Forderung bearbeiten</h2>
  <p id="adminRankingActionTarget"></p>
  <form id="adminRankingActionForm">
    <div id="adminRankingDateFields">
      <label for="adminRankingDay">Datum:</label>
      <input type="date" id="adminRankingDay" name="adminRankingDay" min="1950-01-01" max="2049-12-31" required>
      <label for="adminRankingTime">Uhrzeit:</label>
      <input type="time" id="adminRankingTime" name="adminRankingTime" min="00:00" max="23:59" step="60" required>
    </div>
    <label for="adminRankingReason">Grund:</label>
    <textarea id="adminRankingReason" name="adminRankingReason" maxlength="500" required placeholder="Bitte geben Sie den Grund ein..."></textarea>
    <button type="submit" class="btn-login admin-ranking-danger" id="adminRankingActionSubmit">Übernehmen</button>
  </form>
`, { explicitDismiss: true });
adminRankingActionModal.classList.add("ranking-admin-modal");
adminRankingActionModal.setAttribute("role", "dialog");
adminRankingActionModal.setAttribute("aria-modal", "true");
adminRankingActionModal.setAttribute("aria-labelledby", "adminRankingActionTitle");
adminRankingActionModal.querySelector(".close")?.setAttribute("aria-label", "Adminaktion abbrechen");

const matchResultModal = createModal("matchResultModal", `
  <h2 id="matchResultTitle">Ergebnis erfassen</h2>
  <div id="matchResultTarget" class="match-result-target">
    <strong id="matchResultCompetition"></strong>
    <span id="matchResultEncounter"></span>
  </div>
  <form id="matchResultForm" novalidate>
    <div id="matchResultCompletionFields">
      <div class="match-result-field-row">
        <label for="matchResultKind">Abschlussart:</label>
        <select id="matchResultKind" name="kind">
          <option value="regular">Regulär</option>
          <option value="walkover">WO</option>
          <option value="retirement">RET</option>
        </select>
      </div>
      <div id="matchResultValueFields">
        <div id="matchResultScoreEditor" class="match-result-score-editor" aria-label="Satzergebnis bearbeiten"></div>
        <div class="match-result-suggestions" aria-label="Ergebnis vom Platz übernehmen">
          <button type="button" class="btn-login match-result-suggestion">Match vom Scoreboard übernehmen</button>
        </div>
      </div>
      <div id="matchResultLosingFields" hidden>
        <label for="matchResultLosingSide">Verliererseite:</label>
        <select id="matchResultLosingSide" name="losingSide">
          <option value="">Bitte Verliererseite auswählen</option>
        </select>
      </div>
    </div>
    <div id="matchResultStartFields">
      <div class="match-result-field-row">
        <label for="matchResultStart">Matchstart:</label>
        <input id="matchResultStart" name="matchStart" type="datetime-local">
      </div>
    </div>
    <div id="matchResultEndFields">
      <div class="match-result-field-row">
        <label for="matchResultEnd">Matchende:</label>
        <input id="matchResultEnd" name="matchEnd" type="datetime-local">
      </div>
    </div>
    <div id="matchResultReasonFields" hidden>
      <label for="matchResultReason">Grund:</label>
      <textarea id="matchResultReason" name="reason" maxlength="500"></textarea>
    </div>
    <fieldset id="matchResultRankPlanFields" hidden>
      <legend>Vollständiger Rangplan</legend>
      <p>Rang 0 bleibt bestehenden rausgehängten Mitgliedern vorbehalten und darf dort mehrfach vorkommen.</p>
      <div id="matchResultRankPlan"></div>
    </fieldset>
    <p id="matchResultStatus" class="match-result-status" role="status" aria-live="polite" hidden></p>
    <button type="submit" id="matchResultSubmit" class="btn-login">Speichern</button>
  </form>
`, { explicitDismiss: true });
matchResultModal.classList.add("match-result-modal");
matchResultModal.setAttribute("role", "dialog");
matchResultModal.setAttribute("aria-modal", "true");
matchResultModal.setAttribute("aria-labelledby", "matchResultTitle");
matchResultModal.querySelector(".close")?.setAttribute("aria-label", "Ergebnisdialog abbrechen");
document.getElementById("matchDatePreviousMonth").addEventListener("click", () => {
  if (!matchCalendarMonth) return;
  matchCalendarMonth = new Date(matchCalendarMonth.getFullYear(), matchCalendarMonth.getMonth() - 1, 1);
  renderMatchDateCalendar();
});
document.getElementById("matchDateNextMonth").addEventListener("click", () => {
  if (!matchCalendarMonth) return;
  matchCalendarMonth = new Date(matchCalendarMonth.getFullYear(), matchCalendarMonth.getMonth() + 1, 1);
  renderMatchDateCalendar();
});

const withdrawnPlayersModal = createModal("withdrawnPlayersModal", `
  <h2 id="withdrawnPlayersTitle">Rausgehängte Spieler</h2>
  <div id="withdrawnPlayersBody" class="withdrawn-players-list" aria-live="polite"></div>
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

function formatCompactDate(value) {
  const match = String(value || "").trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!match) return String(value || "").trim() || "---";
  const century = Number(match[1]) >= 50 ? "19" : "20";
  return `${match[3]}.${match[2]}.${century}${match[1]}, ${match[4]}:${match[5]} Uhr`;
}

function compactDateValue(value) {
  const match = String(value || "").trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]) >= 50 ? 1900 + Number(match[1]) : 2000 + Number(match[1]);
  const date = new Date(year, Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function compactWallTimeParts(value) {
  const match = String(value || "").trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]) >= 50 ? 1900 + Number(match[1]) : 2000 + Number(match[1]);
  const probe = new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[3])));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== Number(match[2]) - 1 || probe.getUTCDate() !== Number(match[3])) return null;
  return { year, month: match[2], day: match[3], hour: match[4], minute: match[5] };
}

function dateInputValue(date) {
  const part = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

function compactMatchDate(dayValue, hourValue) {
  const day = String(dayValue || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const hour = String(hourValue || "").match(/^(0[6-9]|1\d|2[0-3])$/);
  return day && hour ? `${day[1].slice(2)}${day[2]}${day[3]}-${hour[1]}00` : "";
}

function compactAdminRankingDate(dayValue, timeValue, fullHour = false) {
  const day = String(dayValue || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const time = String(timeValue || "").match(/^((?:[01]\d|2[0-3])):([0-5]\d)$/);
  return day && time && (!fullHour || time[2] === "00")
    ? `${day[1].slice(2)}${day[2]}${day[3]}-${time[1]}${time[2]}`
    : "";
}

function localDateTimeValue(date) {
  const part = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

function compactResultDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T([0-2]\d):([0-5]\d)$/);
  return match ? `${match[1].slice(2)}${match[2]}${match[3]}-${match[4]}${match[5]}` : "";
}

function endpointResultError(data, fallback) {
  const error = new Error(errorMessage(data, fallback));
  error.code = data?.error?.code || "UNEXPECTED_ERROR";
  error.supportId = data?.supportId || "";
  return error;
}

function showMatchResultStatus(message, type = "error") {
  const status = document.getElementById("matchResultStatus");
  clearTimeout(matchResultStatusTimer);
  status.textContent = String(message || "");
  status.className = `match-result-status ${type}`;
  status.hidden = !message;
  if (message) matchResultStatusTimer = setTimeout(() => {
    status.hidden = true;
    status.textContent = "";
  }, 3000);
}

function matchResultRules() {
  const rules = matchResultContext?.match?.resultRules || {};
  const winningSets = rules.winningSets === 3 ? 3 : 2;
  const setTarget = rules.setTarget === 4 ? 4 : 6;
  return {
    winningSets,
    setTarget,
    setTiebreak: String(rules.setTiebreak || `${setTarget - 1}-${setTarget - 1}`),
    decidingSet: String(rules.decidingSet || "vollstaendiger Satz"),
  };
}

function matchResultSetCount() {
  return matchResultRules().winningSets * 2 - 1;
}

function isMatchTiebreakSet(index) {
  const rules = matchResultRules();
  return index === matchResultSetCount() - 1 && ["MT7", "MT10"].includes(rules.decidingSet.toUpperCase());
}

function parseMatchResultScore(result) {
  const count = matchResultSetCount();
  const parsed = String(result || "").trim().split("/").filter(Boolean).slice(0, count).map((token) => {
    const match = token.match(/^(\d{1,2})-(\d{1,2})(?:\((\d{1,2})\))?$/);
    if (!match) return { side1: 0, side2: 0, touched: false, tiebreak: null };
    const side1 = Number(match[1]);
    const side2 = Number(match[2]);
    let tiebreak = null;
    if (match[3] !== undefined && side1 !== side2) {
      const loserPoints = Number(match[3]);
      const winnerPoints = Math.max(7, loserPoints + 2);
      tiebreak = side1 > side2
        ? { side1: winnerPoints, side2: loserPoints }
        : { side1: loserPoints, side2: winnerPoints };
    }
    return { side1, side2, touched: true, tiebreak };
  });
  const sets = Array.from({ length: count }, (_, index) => parsed[index] || ({ side1: 0, side2: 0, touched: false, tiebreak: null }));
  sets.forEach((set, index) => {
    if (!set.tiebreak && normalSetNeedsTiebreak(set, index)) set.tiebreak = { side1: 0, side2: 0 };
  });
  return sets;
}

function normalSetNeedsTiebreak(set, index) {
  if (isMatchTiebreakSet(index)) return false;
  const trigger = Number(matchResultRules().setTiebreak.split("-")[0]);
  const high = Math.max(set.side1, set.side2);
  const low = Math.min(set.side1, set.side2);
  return Number.isInteger(trigger) && (set.side1 === trigger && set.side2 === trigger || high === trigger + 1 && low === trigger);
}

function clampMatchResultNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(99, Math.trunc(number))) : 0;
}

function createMatchResultStepper(setIndex, side, { tiebreak = false } = {}) {
  const set = matchResultScore[setIndex];
  const valueTarget = tiebreak ? set.tiebreak : set;
  const row = document.createElement("div");
  row.className = "match-result-score-row";
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.max = "99";
  input.step = "1";
  input.inputMode = "numeric";
  input.value = String(valueTarget[side]);
  const teamName = matchResultContext?.match?.teams?.[side === "side1" ? 0 : 1]?.names?.join(" / ") || (side === "side1" ? "Seite 1" : "Seite 2");
  const scoreName = tiebreak ? `Tie-Break in Set ${setIndex + 1}` : `Set ${setIndex + 1}`;
  input.setAttribute("aria-label", `${scoreName}, ${teamName}`);
  input.addEventListener("change", () => {
    valueTarget[side] = clampMatchResultNumber(input.value);
    set.touched = true;
    if (!tiebreak) {
      if (normalSetNeedsTiebreak(set, setIndex) && !set.tiebreak) set.tiebreak = { side1: 0, side2: 0 };
      if (!normalSetNeedsTiebreak(set, setIndex)) set.tiebreak = null;
    }
    renderMatchResultScore();
  });
  const controls = document.createElement("div");
  controls.className = "match-result-score-controls";
  for (const [label, change] of [["+", 1], ["-", -1]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "match-result-score-step";
    button.textContent = label;
    button.setAttribute("aria-label", `${scoreName}, ${teamName}: ${change > 0 ? "Plus" : "Minus"}`);
    button.addEventListener("click", () => {
      valueTarget[side] = clampMatchResultNumber(valueTarget[side] + change);
      set.touched = true;
      if (!tiebreak) {
        if (normalSetNeedsTiebreak(set, setIndex) && !set.tiebreak) set.tiebreak = { side1: 0, side2: 0 };
        if (!normalSetNeedsTiebreak(set, setIndex)) set.tiebreak = null;
      }
      renderMatchResultScore();
    });
    controls.appendChild(button);
  }
  row.append(input, controls);
  return row;
}

function createMatchResultScoreColumn(setIndex, { tiebreak = false } = {}) {
  const column = document.createElement("section");
  column.className = `match-result-score-column${tiebreak ? " tiebreak" : isMatchTiebreakSet(setIndex) ? " match-tiebreak" : ""}`;
  const heading = document.createElement("h3");
  heading.textContent = tiebreak ? "TB" : `Set ${setIndex + 1}`;
  column.append(heading, createMatchResultStepper(setIndex, "side1", { tiebreak }), createMatchResultStepper(setIndex, "side2", { tiebreak }));
  return column;
}

function renderMatchResultScore() {
  const editor = document.getElementById("matchResultScoreEditor");
  editor.replaceChildren();
  for (let index = 0; index < matchResultScore.length; index++) {
    editor.appendChild(createMatchResultScoreColumn(index));
    if (matchResultScore[index].tiebreak) editor.appendChild(createMatchResultScoreColumn(index, { tiebreak: true }));
  }
}

function setMatchResultScore(result) {
  matchResultScore = parseMatchResultScore(result);
  renderMatchResultScore();
}

function serializeMatchResultScore() {
  const lastSet = matchResultScore.findLastIndex((set) => set.touched || set.side1 !== 0 || set.side2 !== 0 || set.tiebreak);
  if (lastSet < 0) return "";
  return matchResultScore.slice(0, lastSet + 1).map((set, index) => {
    let token = `${set.side1}-${set.side2}`;
    if (set.tiebreak && !isMatchTiebreakSet(index)) {
      const winnerSide = set.side1 > set.side2 ? "side1" : set.side2 > set.side1 ? "side2" : "";
      const loserSide = winnerSide === "side1" ? "side2" : winnerSide === "side2" ? "side1" : "";
      const high = Math.max(set.tiebreak.side1, set.tiebreak.side2);
      const low = Math.min(set.tiebreak.side1, set.tiebreak.side2);
      if (!winnerSide || set.tiebreak[winnerSide] <= set.tiebreak[loserSide] || high < 7 || high !== 7 && high - low !== 2) {
        throw new Error(`Bitte geben Sie für den Tie-Break in Set ${index + 1} einen vollständigen Punktestand ein.`);
      }
      token += `(${set.tiebreak[loserSide]})`;
    }
    return token;
  }).join("/");
}

function updateMatchResultKind() {
  const kind = document.getElementById("matchResultKind").value;
  const regular = kind === "regular";
  const valueFields = document.getElementById("matchResultValueFields");
  const losingFields = document.getElementById("matchResultLosingFields");
  const losingInput = document.getElementById("matchResultLosingSide");
  valueFields.hidden = kind === "walkover";
  losingFields.hidden = regular;
  losingInput.disabled = regular;
  losingInput.required = !regular;
  const openMatch = matchResultContext?.action === "result" && matchResultContext.match?.status === "open";
  if (openMatch) {
    const startFields = document.getElementById("matchResultStartFields");
    const endFields = document.getElementById("matchResultEndFields");
    const startInput = document.getElementById("matchResultStart");
    const endInput = document.getElementById("matchResultEnd");
    const needsTimes = kind !== "walkover";
    startFields.hidden = !needsTimes;
    endFields.hidden = !needsTimes;
    startInput.disabled = !needsTimes;
    startInput.required = needsTimes;
    endInput.disabled = !needsTimes;
    endInput.required = needsTimes;
  }
}

function setMatchResultLosingSides(match) {
  const select = document.getElementById("matchResultLosingSide");
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Bitte Verliererseite auswählen";
  select.replaceChildren(placeholder, ...(match.teams || []).slice(0, 2).map((team, index) => {
    const option = document.createElement("option");
    option.value = String(index + 1);
    option.textContent = team.names?.join(" / ") || `Seite ${index + 1}`;
    return option;
  }));
  select.value = match.losingSide ? String(match.losingSide) : "";
}

function openMatchResultModal(action, profile, competition, match) {
  const rankingRepair = action === "rankingRepair";
  const adminAction = action === "matchEnd" || action === "clear" || rankingRepair;
  if (!match?.matchId || adminAction && getUser()?.role !== "admin" || action === "result" && !match.canSetResult
    || rankingRepair && (match.status !== "completed" || competition.ranking !== true || !Array.isArray(competition.rankingMembers))) return;
  matchResultContext = {
    action,
    playerId: String(profile.id),
    competitionId: String(competition.competitionId),
    match: { ...match },
    rankingMembers: rankingRepair ? competition.rankingMembers.map((member) => ({ ...member })) : [],
  };
  const form = document.getElementById("matchResultForm");
  form.reset();
  const completionFields = document.getElementById("matchResultCompletionFields");
  const startFields = document.getElementById("matchResultStartFields");
  const endFields = document.getElementById("matchResultEndFields");
  const reasonFields = document.getElementById("matchResultReasonFields");
  const rankPlanFields = document.getElementById("matchResultRankPlanFields");
  const rankPlan = document.getElementById("matchResultRankPlan");
  const startInput = document.getElementById("matchResultStart");
  const endInput = document.getElementById("matchResultEnd");
  const reasonInput = document.getElementById("matchResultReason");
  const submit = document.getElementById("matchResultSubmit");
  startInput.readOnly = false;
  endInput.readOnly = false;
  delete startInput.dataset.defaultValue;
  delete endInput.dataset.defaultValue;
  showMatchResultStatus("");
  document.getElementById("matchResultCompetition").textContent = competition.competitionName;
  document.getElementById("matchResultEncounter").textContent = match.teams.map((team) => team.names.join(" / ")).join(" gegen ");
  completionFields.hidden = action !== "result" && !rankingRepair;
  startFields.hidden = rankingRepair || action !== "result" || match.status === "completed";
  endFields.hidden = rankingRepair || action === "clear" || action === "result" && match.status === "completed";
  reasonFields.hidden = !adminAction;
  rankPlanFields.hidden = !rankingRepair;
  rankPlan.replaceChildren();
  if (rankingRepair) {
    for (const member of matchResultContext.rankingMembers) {
      const row = document.createElement("label");
      row.className = "match-result-rank-row";
      row.textContent = `${member.name} (bisher Rang ${member.rank})`;
      const input = document.createElement("input");
      input.type = "number";
      input.min = Number(member.rank) === 0 ? "0" : "1";
      input.max = "10000";
      input.step = "1";
      input.required = true;
      input.value = String(member.rank);
      input.dataset.personId = String(member.personId);
      input.dataset.expectedRank = String(member.rank);
      input.setAttribute("aria-label", `Zielrang für ${member.name}`);
      row.appendChild(input);
      rankPlan.appendChild(row);
    }
  }
  startInput.disabled = startFields.hidden;
  startInput.required = !startFields.hidden;
  endInput.disabled = endFields.hidden;
  endInput.required = !endFields.hidden;
  reasonInput.disabled = !adminAction;
  reasonInput.required = adminAction;
  if (action === "result" || rankingRepair) {
    document.getElementById("matchResultTitle").textContent = rankingRepair ? "Mit Rangplan korrigieren" : match.status === "completed" ? "Ergebnis korrigieren" : "Ergebnis erfassen";
    document.getElementById("matchResultKind").value = match.completionType || "regular";
    setMatchResultScore(match.result || "");
    document.querySelector(".match-result-suggestion").hidden = action !== "result";
    setMatchResultLosingSides(match);
    submit.textContent = rankingRepair ? "Mit Rangplan korrigieren" : match.status === "completed" ? "Ergebnis korrigieren" : "Ergebnis speichern";
    if (match.status === "open") {
      const now = new Date();
      const scheduled = compactDateValue(match.matchDate);
      const defaultStart = scheduled && scheduled <= now ? scheduled : new Date(now.getTime() - 90 * 60 * 1000);
      startInput.max = localDateTimeValue(now);
      startInput.value = localDateTimeValue(defaultStart);
      endInput.min = "";
      endInput.max = localDateTimeValue(now);
      endInput.value = localDateTimeValue(now);
      startInput.dataset.defaultValue = startInput.value;
      endInput.dataset.defaultValue = endInput.value;
    }
    updateMatchResultKind();
    if (match.correctionBlockReason === "RANKING_REPAIR_REQUIRED") {
      showMatchResultStatus("Für diese Korrektur ist ein vollständiger administrativer Rangplan erforderlich.", "info");
    }
  } else if (action === "matchEnd") {
    document.getElementById("matchResultTitle").textContent = "Matchende korrigieren";
    endInput.min = "";
    endInput.max = localDateTimeValue(new Date());
    const current = compactDateValue(match.matchEnd);
    if (current) endInput.value = localDateTimeValue(current);
    submit.textContent = "Matchende setzen";
  } else {
    document.getElementById("matchResultTitle").textContent = "Ergebnis löschen";
    submit.textContent = "Ergebnis löschen";
  }
  submit.classList.toggle("admin-danger", getUser()?.role === "admin");
  matchResultReturnFocus = document.activeElement;
  profileModal.inert = true;
  profileModal.setAttribute("aria-hidden", "true");
  openModal(matchResultModal);
  matchResultModal.querySelector("select:not(:disabled), input:not(:disabled), textarea:not(:disabled)")?.focus();
}

function appendMatchCard(panel, profile, competition, match, signal) {
  const card = document.createElement("article");
  card.className = "profile-match-card";
  card.dataset.matchId = String(match.matchId || "");
  const heading = document.createElement("h3");
  heading.textContent = formatProfileRound(match.round);
  const matchDate = document.createElement("span");
  matchDate.className = "profile-match-date";
  matchDate.textContent = `(${match.matchDate ? formatCompactDate(match.matchDate) : match.bye ? "ohne Datum" : "noch kein Termin festgelegt"})`;
  heading.append(" ", matchDate);
  const teams = document.createElement("p");
  teams.className = "profile-match-teams";
  const teamText = (team) => {
    const names = team.names.join(" / ") || "Offen";
    return competition.ranking === true && Number.isInteger(team.rankAtResult) && team.rankAtResult >= 0
      ? `${names} (${team.rankAtResult})`
      : names;
  };
  teams.textContent = match.bye
    ? `Freilos für ${match.teams.flatMap((team) => team.names).join(" / ")}`
    : match.teams.map(teamText).join(" gegen ");
  const actions = document.createElement("div");
  actions.className = "profile-match-actions";
  if (match.canSetResult) {
    const resultButton = document.createElement("button");
    resultButton.type = "button";
    resultButton.className = `btn-login${getUser()?.role === "admin" ? " admin-danger" : ""}`;
    resultButton.textContent = match.status === "completed" ? "Ergebnis korrigieren" : "Ergebnis eintragen";
    resultButton.addEventListener("click", () => openMatchResultModal("result", profile, competition, match), { signal });
    actions.appendChild(resultButton);
  }
  if (match.canSetMatchAppointment) {
    const appointmentButton = document.createElement("button");
    appointmentButton.type = "button";
    appointmentButton.className = `btn-login${getUser()?.role === "admin" ? " admin-danger" : ""}`;
    appointmentButton.textContent = match.matchDate ? "Termin abändern" : "Termin eintragen";
    appointmentButton.addEventListener("click", () => openMatchDateModal(match, profile, competition), { signal });
    actions.appendChild(appointmentButton);
  }
  if (getUser()?.role === "admin" && competition.ranking === true && match.status === "completed") {
    const repairButton = document.createElement("button");
    repairButton.type = "button";
    repairButton.className = "btn-login admin-ranking-danger";
    repairButton.textContent = "Mit Rangplan korrigieren";
    repairButton.addEventListener("click", () => openMatchResultModal("rankingRepair", profile, competition, match), { signal });
    actions.appendChild(repairButton);
  }
  if (match.canAdminSetMatchEnd) {
    const endButton = document.createElement("button");
    endButton.type = "button";
    endButton.className = "btn-login admin-danger";
    endButton.textContent = "Matchende setzen";
    endButton.addEventListener("click", () => openMatchResultModal("matchEnd", profile, competition, match), { signal });
    actions.appendChild(endButton);
  }
  if (match.canAdminClear) {
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "btn-login admin-danger";
    clearButton.textContent = "Ergebnis löschen";
    clearButton.addEventListener("click", () => openMatchResultModal("clear", profile, competition, match), { signal });
    actions.appendChild(clearButton);
  }
  card.append(heading, teams);
  if (match.status === "completed") {
    const status = document.createElement("p");
    status.className = "profile-match-status";
    const losingTeam = match.losingSide ? match.teams[match.losingSide - 1]?.names.join(" / ") : "";
    const winningTeam = match.losingSide ? match.teams[2 - match.losingSide]?.names.join(" / ") : "";
    status.textContent = match.completionType === "walkover" && losingTeam
      ? formatWalkoverResult(winningTeam, losingTeam)
      : match.completionType === "retirement" && losingTeam
        ? `Aufgabe durch ${losingTeam}${match.result ? `: ${match.result}` : ""}`
        : `${match.completionType === "walkover" ? "Walkover" : match.completionType === "retirement" ? "Aufgabe" : "Ergebnis"}: ${match.result || "ohne Satzergebnis"}`;
    card.appendChild(status);
  }
  card.appendChild(actions);
  panel.appendChild(card);
}

function formatProfileRound(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Match";
  const code = raw.toUpperCase().match(/^(R\d+|AF|VF|HF|F|G\d+)(?:-P\d+)?$/)?.[1] || "";
  if (/^R\d+$/.test(code)) {
    const roundNames = ["", "Erste", "Zweite", "Dritte", "Vierte", "Fünfte", "Sechste", "Siebte", "Achte", "Neunte", "Zehnte"];
    const number = Number(code.slice(1));
    return `${roundNames[number] || `${number}.`} Runde`;
  }
  if (code === "AF") return "Achtelfinale";
  if (code === "VF") return "Viertelfinale";
  if (code === "HF") return "Halbfinale";
  if (code === "F") return "Finale";
  if (/^G\d+$/.test(code)) return `${code.slice(1)}. Gruppe`;
  return `Runde ${raw}`;
}

document.getElementById("matchResultKind").addEventListener("change", updateMatchResultKind);
matchResultModal.querySelector(".match-result-suggestion").addEventListener("click", async (event) => {
  if (!matchResultContext || matchResultContext.action !== "result") return;
  const button = event.currentTarget;
  button.disabled = true;
  showMatchResultStatus("Scoreboard-Ergebnis wird geladen...", "info");
  try {
    const matchId = matchResultContext.match.matchId;
    const responses = await Promise.all(["1", "2"].map((court) => matchResultSuggestion({ matchId, court })));
    const candidates = responses.flatMap((response, index) => {
      const court = String(index + 1);
      const data = response.data;
      if (!data?.success) throw endpointResultError(data, "Ergebnisvorschlag konnte nicht geladen werden.");
      if (String(data.matchId || "") !== matchId
        || String(data.source?.court || "") !== court
        || !["court", "scoreLog", "none"].includes(data.source?.type)) {
        const error = new Error("Ergebnisvorschlag stammt aus einer unbekannten Quelle.");
        error.code = "SUGGESTION_SOURCE_INVALID";
        throw error;
      }
      const result = String(data.suggestion?.result || "").trim();
      return data.source.type === "none" || !result ? [] : [{ court, result }];
    });
    if (!candidates.length) {
      showMatchResultStatus("Für Platz 1 und Platz 2 ist kein Ergebnis verfügbar.", "info");
      return;
    }
    if (candidates.length > 1) {
      showMatchResultStatus("Das Match wurde auf Platz 1 und Platz 2 gefunden. Bitte Ergebnis manuell eingeben.");
      return;
    }
    setMatchResultScore(candidates[0].result);
    showMatchResultStatus(`Vorschlag von Platz ${candidates[0].court} wurde übernommen. Bitte prüfen und speichern.`, "success");
  } catch (error) {
    diagnostic.warn("match_result_suggestion_failed", error);
    showMatchResultStatus(errorMessage(error, "Ergebnisvorschlag konnte nicht geladen werden."));
  } finally {
    button.disabled = false;
  }
});

function openAdminRankingAction(action, profile, ranking) {
  if (getUser()?.role !== "admin" || !ranking?.openChallenge?.matchId) {
    window.showToast("Administratorberechtigung oder Forderung fehlt.", "error");
    return;
  }
  const definitions = {
    delete: { title: "Forderung löschen", submit: "Forderung löschen", value: "" },
    challengeDate: { title: "Forderungsdatum ändern", submit: "Forderungsdatum ändern", value: ranking.openChallenge.challengedAt },
  };
  const definition = definitions[action];
  if (!definition) return;
  adminRankingActionContext = {
    action,
    matchId: String(ranking.openChallenge.matchId),
    playerId: String(profile.id),
    competitionId: String(ranking.competitionId),
  };
  const form = document.getElementById("adminRankingActionForm");
  form.reset();
  document.getElementById("adminRankingActionTitle").textContent = definition.title;
  document.getElementById("adminRankingActionTarget").textContent = `${ranking.competitionName}: ${profileName(profile)} und ${ranking.openChallenge.opponentName}`;
  document.getElementById("adminRankingActionSubmit").textContent = definition.submit;
  const dateFields = document.getElementById("adminRankingDateFields");
  const dayInput = document.getElementById("adminRankingDay");
  const timeInput = document.getElementById("adminRankingTime");
  const date = compactWallTimeParts(definition.value);
  dateFields.hidden = action === "delete";
  dayInput.disabled = action === "delete";
  timeInput.disabled = action === "delete";
  timeInput.step = "60";
  timeInput.max = "23:59";
  if (date) {
    dayInput.value = `${date.year}-${date.month}-${date.day}`;
    timeInput.value = `${date.hour}:${date.minute}`;
  }
  adminRankingReturnFocus = document.activeElement;
  profileModal.inert = true;
  profileModal.setAttribute("aria-hidden", "true");
  openModal(adminRankingActionModal);
  document.getElementById(action === "delete" ? "adminRankingReason" : "adminRankingDay")?.focus();
}

function calendarDayValue(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function renderMatchDateCalendar() {
  if (!matchCalendarMonth || !matchDateContext) return;
  const monthLabel = document.getElementById("matchDateCalendarMonth");
  const daysElement = document.getElementById("matchDateCalendarDays");
  const selectedValue = document.getElementById("rankingMatchDay").value;
  monthLabel.textContent = new Intl.DateTimeFormat("de-AT", { month: "long", year: "numeric" }).format(matchCalendarMonth);
  daysElement.replaceChildren();
  const firstDay = new Date(matchCalendarMonth.getFullYear(), matchCalendarMonth.getMonth(), 1);
  const leadingDays = (firstDay.getDay() + 6) % 7;
  for (let index = 0; index < leadingDays; index++) {
    const spacer = document.createElement("span");
    spacer.className = "match-date-calendar-spacer";
    daysElement.appendChild(spacer);
  }
  const dayCount = new Date(matchCalendarMonth.getFullYear(), matchCalendarMonth.getMonth() + 1, 0).getDate();
  for (let day = 1; day <= dayCount; day++) {
    const date = new Date(matchCalendarMonth.getFullYear(), matchCalendarMonth.getMonth(), day);
    const value = dateInputValue(date);
    const timestamp = calendarDayValue(date);
    const inOriginalWindow = matchDateContext.ranking
      && timestamp >= matchDateContext.challengeDay && timestamp <= matchDateContext.finalDay;
    const selectable = matchDateContext.previousDate || !matchDateContext.ranking
      ? timestamp >= matchDateContext.today
      : inOriginalWindow;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "match-date-calendar-day";
    button.textContent = String(day);
    button.disabled = !selectable;
    button.setAttribute("role", "gridcell");
    button.setAttribute("aria-label", new Intl.DateTimeFormat("de-AT", { dateStyle: "long" }).format(date));
    button.classList.toggle("in-window", inOriginalWindow);
    button.classList.toggle("challenge-start", timestamp === matchDateContext.challengeDay);
    button.classList.toggle("challenge-end", timestamp === matchDateContext.finalDay);
    button.classList.toggle("selected", value === selectedValue);
    if (selectable) button.addEventListener("click", () => {
      document.getElementById("rankingMatchDay").value = value;
      renderMatchDateCalendar();
      updateMatchDateHours();
    });
    daysElement.appendChild(button);
  }
}

function updateMatchDateHours() {
  const dayInput = document.getElementById("rankingMatchDay");
  const hourInput = document.getElementById("rankingMatchHour");
  const selectedDay = String(dayInput.value || "");
  let firstEnabled = "";
  for (const option of hourInput.options) {
    const candidate = new Date(`${selectedDay}T${option.value}:00`);
    option.disabled = !selectedDay
      || Number.isNaN(candidate.getTime())
      || candidate.getTime() < Number(matchDateContext?.earliestAt || 0)
      || (matchDateContext?.earliestExclusive && candidate.getTime() === Number(matchDateContext.earliestAt))
      || (matchDateContext?.latestAt && candidate.getTime() > matchDateContext.latestAt);
    if (!option.disabled && !firstEnabled) firstEnabled = option.value;
  }
  if (!firstEnabled) hourInput.value = "";
  else if (!hourInput.value || hourInput.selectedOptions[0]?.disabled) hourInput.value = firstEnabled;
  document.querySelector('#matchDateForm button[type="submit"]').disabled = !firstEnabled;
}

function openMatchDateModal(match, profile, competition) {
  const matchId = String(match?.matchId || "").trim();
  if (!matchId) {
    window.showToast("Das Match konnte nicht eindeutig zugeordnet werden.", "error");
    return;
  }
  const currentDate = compactDateValue(match.matchDate);
  const dayInput = document.getElementById("rankingMatchDay");
  const hourInput = document.getElementById("rankingMatchHour");
  const reasonFields = document.getElementById("matchDateReasonFields");
  const reasonInput = document.getElementById("matchDateReason");
  const admin = getUser()?.role === "admin";
  const today = new Date(Date.now());
  const now = today.getTime();
  today.setHours(0, 0, 0, 0);
  const ranking = competition?.ranking === true;
  const challengedAt = ranking ? compactDateValue(match.challengeDate) : null;
  const finalDay = challengedAt ? new Date(challengedAt.getFullYear(), challengedAt.getMonth(), challengedAt.getDate() + 14) : today;
  matchDateContext = {
    matchId,
    playerId: String(profile?.id || ""),
    competitionId: String(competition?.competitionId || ""),
    previousDate: String(match.matchDate || ""),
    ranking,
    admin,
    earliestAt: currentDate ? now : challengedAt?.getTime() || now,
    earliestExclusive: Boolean(currentDate || !ranking),
    latestAt: currentDate || !challengedAt ? null : challengedAt.getTime() + 14 * 24 * 60 * 60 * 1000,
    today: calendarDayValue(today),
    challengeDay: challengedAt ? calendarDayValue(challengedAt) : calendarDayValue(today),
    finalDay: calendarDayValue(finalDay),
  };
  reasonFields.hidden = !admin;
  reasonInput.disabled = !admin;
  reasonInput.required = admin;
  reasonInput.value = "";
  if (currentDate) {
    dayInput.value = currentDate >= today ? dateInputValue(currentDate) : dateInputValue(today);
    hourInput.value = String(currentDate.getHours()).padStart(2, "0");
    document.getElementById("matchDateTitle").textContent = "Termin abändern";
  } else {
    dayInput.value = challengedAt ? dateInputValue(challengedAt) : "";
    hourInput.value = "18";
    document.getElementById("matchDateTitle").textContent = "Termin eintragen";
  }
  const visibleDate = compactDateValue(`${dayInput.value.replaceAll("-", "").slice(2)}-0000`) || today;
  matchCalendarMonth = new Date(visibleDate.getFullYear(), visibleDate.getMonth(), 1);
  renderMatchDateCalendar();
  updateMatchDateHours();
  openModal(matchDateModal);
  matchDateModal.querySelector(".match-date-calendar-day.selected:not(:disabled), .match-date-calendar-day:not(:disabled)")?.focus();
}

function appendMatchDateCountdown(container, challenge, signal) {
  if (challenge.matchDate) return;
  const challengedAt = compactDateValue(challenge.challengedAt);
  if (!challengedAt) return;
  const countdown = document.createElement("p");
  countdown.className = "profile-match-date-countdown";
  const deadline = challengedAt.getTime() + 7 * 24 * 60 * 60 * 1000;
  const update = () => {
    const remaining = deadline - Date.now();
    const totalMinutes = Math.floor(Math.abs(remaining) / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    countdown.textContent = `Terminfrist: ${remaining >= 0 ? "-" : "+"}${days} Tage, ${hours} Stunden, ${minutes} Minuten`;
    countdown.classList.toggle("warning", remaining >= 0 && remaining <= 2 * 24 * 60 * 60 * 1000);
    countdown.classList.toggle("overdue", remaining < 0);
  };
  update();
  const timer = setInterval(update, 30000);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  container.appendChild(countdown);
}

function formatMessageDate(value) {
  const compact = String(value || "").trim();
  if (/^\d{6}-\d{4}$/.test(compact)) return formatCompactDate(compact);
  const date = new Date(typeof value === "number" ? value : compact);
  if (Number.isNaN(date.getTime())) return compact || "---";
  return new Intl.DateTimeFormat("de-AT", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Vienna",
  }).format(date).replace(",", ",") + " Uhr";
}

function messageId(message) {
  return String(message?.messageId || message?.id || "").trim();
}

function messageDate(message) {
  return message?.createdAt || message?.sentAt || message?.date || "";
}

function isMessageAcknowledged(message) {
  return message?.acknowledged === true || Boolean(message?.acknowledgedAt);
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

function activateProfileTab(tab) {
  const tablist = tab.closest('[role="tablist"]');
  if (!tablist) return;
  const tabs = [...tablist.children].filter((candidate) => candidate.getAttribute("role") === "tab");
  for (const candidate of tabs) {
    const selected = candidate === tab;
    candidate.setAttribute("aria-selected", String(selected));
    const panel = document.getElementById(candidate.getAttribute("aria-controls"));
    if (panel) panel.hidden = !selected;
  }
  tab.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

function appendProfileTab(container, label, panel, selected, signal, onActivate = null) {
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "profile-tab";
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-controls", panel.id);
  tab.setAttribute("aria-selected", String(selected));
  panel.hidden = !selected;
  tab.textContent = label;
  panel.setAttribute("aria-labelledby", `${panel.id}Tab`);
  tab.id = `${panel.id}Tab`;
  tab.addEventListener("click", () => {
    activateProfileTab(tab);
    onActivate?.();
  }, { signal });
  container.appendChild(tab);
  return tab;
}

function updateMessagesTabLabel() {
  if (!messageState?.tab) return;
  messageState.tab.textContent = `Meldungen (${messageState.unreadCount})`;
}

function renderMessageList({ append = false } = {}) {
  if (!messageState) return;
  const panel = document.getElementById("profileMessagesPanel");
  if (!append) panel.replaceChildren();
  if (!messageState.messages.length) {
    const empty = document.createElement("p");
    empty.className = "message-list-empty";
    empty.textContent = "Keine Meldungen vorhanden.";
    panel.appendChild(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "message-list";
  for (const message of messageState.messages) {
    const id = messageId(message);
    if (!id) continue;
    const row = document.createElement("button");
    row.type = "button";
    row.className = `message-row${isMessageAcknowledged(message) ? "" : " unread"}`;
    row.dataset.messageId = id;
    const competitionName = String(message.competitionName || "Allgemeine Meldung");
    const subjectText = String(message.subject || "Ohne Betreff");
    row.setAttribute("aria-label", `${isMessageAcknowledged(message) ? "Gelesene" : "Ungelesene"} Meldung, ${competitionName}: ${subjectText}`);
    const date = document.createElement("time");
    date.className = "message-row-date";
    date.textContent = formatMessageDate(messageDate(message));
    const competition = document.createElement("span");
    competition.className = "message-row-competition";
    const roundName = String(message.roundName || "").trim();
    competition.textContent = competitionName;
    if (roundName) {
      const round = document.createElement("span");
      round.className = "message-row-round";
      round.textContent = ` - ${roundName}`;
      competition.appendChild(round);
    }
    const subject = document.createElement("span");
    subject.className = "message-row-subject";
    subject.textContent = subjectText;
    row.append(date, competition);
    row.appendChild(subject);
    const actorName = String(message.actorName || "").trim();
    if (actorName) {
      const actor = document.createElement("span");
      actor.className = "message-row-actor";
      actor.textContent = `Eingetragen durch: ${actorName}`;
      row.appendChild(actor);
    }
    row.addEventListener("click", () => openMessageDetail(id, row), { signal: profileActionController?.signal });
    list.appendChild(row);
  }
  panel.appendChild(list);
  if (messageState.nextCursor) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "btn-login message-load-more";
    more.textContent = "Weitere Meldungen laden";
    more.addEventListener("click", () => loadMessages({ append: true }), { once: true, signal: profileActionController?.signal });
    panel.appendChild(more);
  }
}

async function loadMessages({ append = false } = {}) {
  if (!messageState || messageState.loading) return;
  messageState.loading = true;
  const generation = profileRequestGeneration;
  const panel = document.getElementById("profileMessagesPanel");
  if (!append) panel.textContent = "Lade Meldungen...";
  try {
    const params = { limit: 50 };
    if (append && messageState.nextCursor) params.cursor = messageState.nextCursor;
    const result = await readMyMessages(params);
    if (generation !== profileRequestGeneration || !messageState || !result.data?.success) return;
    const messages = Array.isArray(result.data.messages) ? result.data.messages : [];
    messageState.messages = append ? [...messageState.messages, ...messages] : messages;
    messageState.nextCursor = result.data.nextCursor || null;
    if (result.data.unreadCount !== undefined) {
      messageState.unreadCount = Math.max(0, Number(result.data.unreadCount) || 0);
    }
    messageState.revision = result.data.revision ?? messageState.revision;
    messageState.loaded = true;
    updateMessagesTabLabel();
    renderMessageList();
  } catch (error) {
    if (generation === profileRequestGeneration && messageState) {
      panel.textContent = errorMessage(error, "Meldungen konnten nicht geladen werden.");
    }
  } finally {
    if (messageState) messageState.loading = false;
  }
}

async function openMessageDetail(id, returnFocus) {
  const generation = profileRequestGeneration;
  messageDetailReturnFocus = returnFocus;
  document.getElementById("messageDetailSubject").textContent = "Meldung wird geladen...";
  document.getElementById("messageDetailDate").textContent = "";
  document.getElementById("messageDetailCompetition").textContent = "";
  const actorElement = document.getElementById("messageDetailActor");
  actorElement.textContent = "";
  actorElement.hidden = true;
  document.getElementById("messageDetailBody").textContent = "";
  document.getElementById("messageDetailStatus").textContent = "";
  document.getElementById("messageDetailAnnouncement").textContent = "";
  const acknowledgeButton = document.getElementById("acknowledgeMessageButton");
  acknowledgeButton.hidden = false;
  acknowledgeButton.disabled = true;
  acknowledgeButton.onclick = null;
  profileModal.inert = true;
  profileModal.setAttribute("aria-hidden", "true");
  openModal(messageDetailModal);
  messageDetailModal.querySelector(".close")?.focus();
  try {
    const result = await readMyMessage({ messageId: id });
    if (generation !== profileRequestGeneration || messageDetailModal.classList.contains("hidden")) return;
    const message = result.data?.message;
    if (!result.data?.success || !message) throw new Error("Meldung konnte nicht geladen werden.");
    document.getElementById("messageDetailSubject").textContent = String(message.subject || "Ohne Betreff");
    document.getElementById("messageDetailDate").textContent = formatMessageDate(messageDate(message));
    document.getElementById("messageDetailCompetition").textContent = String(message.competitionName || "Allgemeine Meldung");
    const actorName = String(message.actorName || "").trim();
    if (actorName) {
    actorElement.textContent = `Eingetragen durch: ${actorName}`;
      actorElement.hidden = false;
    }
    document.getElementById("messageDetailBody").textContent = String(message.body || "");
    acknowledgeButton.hidden = isMessageAcknowledged(message);
    acknowledgeButton.disabled = false;
    acknowledgeButton.onclick = () => acknowledgeOpenMessage(id, message, acknowledgeButton);
  } catch (error) {
    document.getElementById("messageDetailSubject").textContent = "Fehler beim Laden";
    document.getElementById("messageDetailStatus").textContent = errorMessage(error, "Meldung konnte nicht geladen werden.");
  }
}

async function acknowledgeOpenMessage(id, message, button) {
  const operationKey = `message:acknowledge:${id}`;
  button.hidden = false;
  button.disabled = true;
  const status = document.getElementById("messageDetailStatus");
  const announcement = document.getElementById("messageDetailAnnouncement");
  announcement.textContent = "";
  status.textContent = "Wird gespeichert...";
  try {
    const result = await acknowledgeMessage({ operationId: getOperationId(operationKey), messageId: id });
    if (!result.data?.success) throw new Error(errorMessage(result.data, "Meldung konnte nicht bestätigt werden."));
    releaseOperationId(operationKey);
    message.acknowledged = true;
    status.textContent = "";
    button.hidden = true;
    messageDetailModal.querySelector(".close")?.focus();
    announcement.textContent = "Zur Kenntnis genommen.";
    if (messageState) {
      messageState.messages = messageState.messages.map((entry) => (
        messageId(entry) === id ? { ...entry, acknowledged: true } : entry
      ));
      messageState.unreadCount = Math.max(0, Number(result.data.unreadCount ?? messageState.unreadCount - 1));
      messageState.revision = result.data.revision ?? messageState.revision;
      updateMessagesTabLabel();
      renderMessageList();
      await loadMessages();
      messageDetailReturnFocus = [...document.querySelectorAll("#profileMessagesPanel .message-row")]
        .find((row) => row.dataset.messageId === id) || null;
    }
    window.dispatchEvent(new CustomEvent("epiber-message-summary-refresh"));
  } catch (error) {
    releaseOperationId(operationKey, error);
    status.textContent = errorMessage(error, "Meldung konnte nicht bestätigt werden.");
    button.hidden = false;
    button.disabled = false;
  }
}

function appendChallengeButton(container, profile, ranking, signal) {
  const challengeButton = document.createElement("button");
  challengeButton.type = "button";
  challengeButton.className = "btn-login";
  challengeButton.textContent = "Fordern";
  container.appendChild(challengeButton);

  challengeButton.addEventListener("click", async () => {
    if (!isAuthenticated()) {
      window.showToast("Bitte zuerst anmelden.", "error");
      closeModal(profileModal);
      window.openLoginModal();
      return;
    }

    challengeButton.disabled = true;
    challengeButton.textContent = "Sende...";
    const operationKey = `match:add:${ranking.competitionId}:${profile.id}`;

    try {
      const matchResult = await addMatch({
        operationId: getOperationId(operationKey),
        bewerbId: ranking.competitionId,
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
  }, { signal });
}

function openPasswordModal() {
  if (!isAuthenticated()) {
    window.showToast("Bitte zuerst anmelden.", "error");
    window.openLoginModal();
    return;
  }

  const form = document.getElementById("changePasswordForm");
  form?.reset();
  if (form) form.elements.username.value = getUser()?.login || "";
  closeModal(profileModal);
  openModal(passwordModal);
  document.getElementById("currentPassword")?.focus();
}

window.openLoginModal = () => {
  setLoginStatus();
  openModal(loginModal);
  document.getElementById("login")?.focus();
};

window.openProfileModal = async (options = {}) => {
  const requestGeneration = ++profileRequestGeneration;
  await ready;
  if (requestGeneration !== profileRequestGeneration) return;

  const requestedId = String(options.playerId || "").trim();
  const sessionUser = getUser();
  if (!sessionUser) return;
  const ownProfile = !requestedId || (sessionUser && requestedId === String(sessionUser.id));

  const nameElement = document.getElementById("profileName");
  const textElement = document.getElementById("profileText");
  const tabsElement = document.getElementById("profileTabs");
  const currentCompetitionTabs = document.getElementById("profileCurrentCompetitionTabs");
  const archiveCompetitionTabs = document.getElementById("profileArchiveCompetitionTabs");
  const messagesPanel = document.getElementById("profileMessagesPanel");
  const rankingPanelsElement = document.getElementById("profileRankingPanels");
  const systemActionsElement = document.getElementById("profileSystemActions");
  const adminPanel = document.getElementById("profileAdminPanel");
  const adminActionsElement = document.getElementById("profileAdminActions");
  profileActionController?.abort();
  profileActionController = new AbortController();
  const actionSignal = profileActionController.signal;
  profileModal.dataset.profileScope = ownProfile ? "private" : "public";
  nameElement.textContent = "Lade Profil...";
  textElement.textContent = "";
  tabsElement.replaceChildren();
  currentCompetitionTabs.replaceChildren();
  currentCompetitionTabs.hidden = true;
  archiveCompetitionTabs.replaceChildren();
  archiveCompetitionTabs.hidden = true;
  messagesPanel.replaceChildren();
  rankingPanelsElement.replaceChildren();
  systemActionsElement.replaceChildren();
  adminActionsElement.replaceChildren();
  adminPanel.hidden = true;
  document.getElementById("profileSystemPanel").hidden = false;
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
      appendProfileField(textElement, "Login", profile.login, "", actionSignal);
      appendContactFields(textElement, profile, actionSignal);
      const configuredNotifications = profile.notifications ?? profile.notificationChannels;
      const notifications = Array.isArray(configuredNotifications)
        ? configuredNotifications.map((channel) => String(channel || "").trim()).filter(Boolean)
        : [];
      appendProfileField(textElement, "Benachrichtigungen", notifications.join(" | ") || "---", "", actionSignal);

      const passwordButton = document.createElement("button");
      passwordButton.type = "button";
      passwordButton.className = "btn-login";
      passwordButton.textContent = "Passwort ändern";
      passwordButton.addEventListener("click", openPasswordModal, { once: true, signal: actionSignal });
      systemActionsElement.appendChild(passwordButton);
    } else {
      if (profile.login) appendProfileField(textElement, "Login", profile.login, "", actionSignal);
      if (sessionUser) appendContactFields(textElement, profile, actionSignal);
      else textElement.textContent = "Öffentliches Spielerprofil";
    }

    const categorizedCompetitions = categorizedProfileCompetitions(profile);
    const rankings = [...categorizedCompetitions.current, ...categorizedCompetitions.archive];
    const currentCategoryPanel = document.createElement("section");
    currentCategoryPanel.id = "profileCurrentCompetitionsPanel";
    currentCategoryPanel.className = "profile-panel profile-competition-category";
    currentCategoryPanel.setAttribute("role", "tabpanel");
    currentCategoryPanel.hidden = true;
    const archiveCategoryPanel = document.createElement("section");
    archiveCategoryPanel.id = "profileArchiveCompetitionsPanel";
    archiveCategoryPanel.className = "profile-panel profile-competition-category";
    archiveCategoryPanel.setAttribute("role", "tabpanel");
    archiveCategoryPanel.hidden = true;
    rankingPanelsElement.append(currentCategoryPanel, archiveCategoryPanel);
    rankings.forEach((ranking, index) => {
      const panel = document.createElement("section");
      panel.id = `profileRankingPanel${index}`;
      panel.className = "profile-panel";
      panel.dataset.competitionId = String(ranking.competitionId || "");
      panel.setAttribute("role", "tabpanel");
      panel.hidden = true;
      if (ranking.status === "active" && Number(ranking.rank) > 0) appendProfileField(panel, "Ranglistenposition", ranking.rank, "", actionSignal);
      if (ranking.openChallenge) {
        const challenge = ranking.openChallenge;
        const challengeBlock = document.createElement("div");
        challengeBlock.className = "profile-open-challenge";
        const challengedAtLine = document.createElement("p");
        challengedAtLine.textContent = `Forderung vom ${formatCompactDate(challenge.challengedAt)}`;
        challengeBlock.append(challengedAtLine);
        if (ownProfile || sessionUser?.role === "admin") appendMatchDateCountdown(challengeBlock, challenge, actionSignal);
        panel.appendChild(challengeBlock);
      }
      if (ranking.status === "withdrawn" && ranking.withdrawal) {
        appendProfileField(panel, "Rausgehängt am", formatCompactDate(ranking.withdrawal.withdrawnAt), "", actionSignal);
        appendProfileField(panel, "Grund", ranking.withdrawal.reason, "", actionSignal);
      }
      const actions = document.createElement("div");
      actions.className = "profile-actions";
      panel.appendChild(actions);
      if (ownProfile && ranking.status === "active") {
        if (ranking.canWithdraw === true) {
          const withdrawButton = document.createElement("button");
          withdrawButton.type = "button";
          withdrawButton.className = "btn-login";
          withdrawButton.textContent = "Raushängen";
          withdrawButton.addEventListener("click", () => {
            window.openWithdrawModal({ rank: ranking.rank, bewerbId: ranking.competitionId });
          }, { once: true, signal: actionSignal });
          actions.appendChild(withdrawButton);
        }
      } else if (ranking.canChallenge === true) {
        appendChallengeButton(actions, profile, ranking, actionSignal);
      }
      if (sessionUser?.role === "admin" && ranking.openChallenge) {
        for (const [action, label] of [
          ["delete", "Forderung löschen"],
          ["challengeDate", "Forderungsdatum ändern"],
        ]) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "btn-login admin-ranking-danger";
          button.textContent = label;
          button.addEventListener("click", () => openAdminRankingAction(action, profile, ranking), { signal: actionSignal });
          actions.appendChild(button);
        }
      }
      for (const match of Array.isArray(ranking.matches) ? ranking.matches : []) {
        appendMatchCard(panel, profile, ranking, match, actionSignal);
      }
      const current = index < categorizedCompetitions.current.length;
      const categoryPanel = current ? currentCategoryPanel : archiveCategoryPanel;
      const categoryTabs = current ? currentCompetitionTabs : archiveCompetitionTabs;
      const categoryIndex = current ? index : index - categorizedCompetitions.current.length;
      categoryPanel.appendChild(panel);
      appendProfileTab(categoryTabs, ranking.competitionName, panel, categoryIndex === 0, actionSignal);
    });
    for (const [competitions, panel] of [
      [categorizedCompetitions.current, currentCategoryPanel],
      [categorizedCompetitions.archive, archiveCategoryPanel],
    ]) {
      if (competitions.length) continue;
      const empty = document.createElement("p");
      empty.className = "profile-competition-empty";
      empty.textContent = "Keine Bewerbe enthalten";
      panel.appendChild(empty);
    }

    if (!ownProfile && sessionUser?.role === "admin") {
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
      adminActionsElement.appendChild(setupButton);

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
      adminActionsElement.appendChild(resetButton);

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
      adminActionsElement.appendChild(setPasswordButton);
    }

    const systemPanel = document.getElementById("profileSystemPanel");
    const hideCompetitionTabs = () => {
      currentCompetitionTabs.hidden = true;
      archiveCompetitionTabs.hidden = true;
    };
    const showCompetitionTabs = (tabs) => {
      currentCompetitionTabs.hidden = tabs !== currentCompetitionTabs || !currentCompetitionTabs.childElementCount;
      archiveCompetitionTabs.hidden = tabs !== archiveCompetitionTabs || !archiveCompetitionTabs.childElementCount;
    };
    appendProfileTab(tabsElement, "System", systemPanel, true, actionSignal, hideCompetitionTabs);
    if (ownProfile) {
      let unreadCount = 0;
      let revision = null;
      try {
        const summaryResult = await readMyMessageSummary();
        if (requestGeneration !== profileRequestGeneration) return;
        if (summaryResult.data?.success) {
          unreadCount = Math.max(0, Number(summaryResult.data.unreadCount) || 0);
          revision = summaryResult.data.revision;
        }
      } catch {}
      messageState = {
        loaded: false,
        loading: false,
        messages: [],
        nextCursor: null,
        revision,
        tab: null,
        unreadCount,
      };
      messageState.tab = appendProfileTab(
        tabsElement,
        `Meldungen (${unreadCount})`,
        messagesPanel,
        false,
        actionSignal,
        () => {
          hideCompetitionTabs();
          if (!messageState?.loaded) loadMessages();
        },
      );
    }
    const currentCategoryTab = appendProfileTab(
      tabsElement,
      "Aktuell",
      currentCategoryPanel,
      false,
      actionSignal,
      () => showCompetitionTabs(currentCompetitionTabs),
    );
    const archiveCategoryTab = appendProfileTab(
      tabsElement,
      "Archiv",
      archiveCategoryPanel,
      false,
      actionSignal,
      () => showCompetitionTabs(archiveCompetitionTabs),
    );
    if (adminActionsElement.childElementCount) {
      adminPanel.hidden = true;
      appendProfileTab(tabsElement, "Admin", adminPanel, false, actionSignal, hideCompetitionTabs);
    }
    const requestedCompetitionId = String(options.competitionId || "");
    if (requestedCompetitionId) {
      const requestedPanel = [...rankingPanelsElement.querySelectorAll("[data-competition-id]")]
        .find((panel) => panel.dataset.competitionId === requestedCompetitionId);
      const requestedTab = requestedPanel && document.getElementById(`${requestedPanel.id}Tab`);
      if (requestedTab) {
        const current = currentCategoryPanel.contains(requestedPanel);
        activateProfileTab(current ? currentCategoryTab : archiveCategoryTab);
        showCompetitionTabs(current ? currentCompetitionTabs : archiveCompetitionTabs);
        activateProfileTab(requestedTab);
      }
    }
  } catch (error) {
    if (requestGeneration !== profileRequestGeneration) return;
    diagnostic.error("profile_load_failed", error);
    nameElement.textContent = "Fehler beim Laden";
    textElement.textContent = errorMessage(error, "Profil konnte nicht geladen werden.");
  }
};

window.addEventListener("epiber-message-summary", (event) => {
  if (!messageState || profileModal.dataset.profileScope !== "private") return;
  const nextRevision = event.detail?.revision;
  messageState.unreadCount = Math.max(0, Number(event.detail?.unreadCount) || 0);
  updateMessagesTabLabel();
  if (messageState.loaded && nextRevision !== messageState.revision) loadMessages();
});

subscribeAuth((user) => {
  const identity = user ? `${user.id || ""}:${user.role || ""}` : "anonymous";
  if (modalAuthIdentity !== null && modalAuthIdentity !== identity) {
    closeModal(profileModal);
    closeModal(resetProofModal);
    closeModal(adminPasswordModal);
    closeModal(adminRankingActionModal);
    closeModal(matchResultModal);
  }
  modalAuthIdentity = identity;
  if (user) return;
  withdrawContext = null;
  closeModal(passwordModal);
  closeModal(adminPasswordModal);
  closeModal(resetProofModal);
  closeModal(matchDateModal);
  closeModal(adminRankingActionModal);
  closeModal(matchResultModal);
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

window.openWithdrawnRankingPlayers = async (bewerbId) => {
  const normalizedBewerbId = String(bewerbId || "").trim();
  if (!isAuthenticated()) {
    window.showToast("Bitte zuerst anmelden.", "error");
    window.openLoginModal();
    return;
  }
  if (!normalizedBewerbId) return;
  const title = document.getElementById("withdrawnPlayersTitle");
  const body = document.getElementById("withdrawnPlayersBody");
  title.textContent = "Rausgehängte Spieler";
  body.textContent = "Lade Daten...";
  openModal(withdrawnPlayersModal);
  try {
    const result = await readWithdrawnRankingPlayers({ bewerbId: normalizedBewerbId });
    const data = result.data;
    if (!data?.success) throw new Error(errorMessage(data, "Liste konnte nicht geladen werden."));
    if (data.competitionName) {
      title.replaceChildren(
        document.createTextNode("Rausgehängt aus"),
        document.createElement("br"),
        document.createTextNode(data.competitionName),
      );
    } else {
      title.textContent = "Rausgehängte Spieler";
    }
    body.replaceChildren();
    if (!data.players?.length) {
      body.textContent = "Derzeit ist niemand rausgehängt.";
      return;
    }
    for (const player of data.players) {
      const entry = document.createElement("article");
      entry.className = "withdrawn-player";
      const heading = document.createElement("strong");
      heading.textContent = player.name;
      const date = document.createElement("span");
      date.textContent = `Datum: ${formatCompactDate(player.withdrawnAt)}`;
      const previousRank = document.createElement("span");
      previousRank.textContent = `Position: ${player.previousRank}`;
      const reason = document.createElement("p");
      reason.textContent = `Grund: ${player.reason}`;
      entry.append(heading, date, previousRank, reason);
      if (player.returnChallenge) {
        const challenge = document.createElement("p");
        const opponentRank = Number.isInteger(Number(player.returnChallenge.opponentRank))
          && Number(player.returnChallenge.opponentRank) > 0
          ? ` (Position ${player.returnChallenge.opponentRank})`
          : "";
        challenge.textContent = `Eingefordert am ${formatCompactDate(player.returnChallenge.challengedAt)} gegen ${player.returnChallenge.opponentName}${opponentRank}`;
        entry.appendChild(challenge);
      }
      body.appendChild(entry);
    }
  } catch (error) {
    body.textContent = errorMessage(error, "Liste konnte nicht geladen werden.");
  }
};

document.getElementById("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const loginName = form.elements.username.value.trim();
  const password = form.elements.password.value;

  setLoginStatus();
  setModalBusy(form, true);
  submitButton.textContent = "Anmelden...";

  try {
    await login(loginName, password);
    form.reset();
    closeModal(loginModal);
    window.showToast("Erfolgreich angemeldet.", "success");
  } catch (error) {
    diagnostic.error("login_failed", error);
    let message = errorMessage(error, "Anmeldung fehlgeschlagen.");
    if (error.code === "LOGIN_FAILED") {
      message = "Login oder Passwort ist ungültig.";
    } else if (error.code === "LOGIN_RATE_LIMIT") {
      const retryAfterMs = Number(error.details?.retryAfterMs);
      const minutes = Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.max(1, Math.ceil(retryAfterMs / 60000))
        : 0;
      message = minutes === 1
        ? "Zu viele Anmeldeversuche. Bitte in einer Minute erneut versuchen."
        : minutes > 1
          ? `Zu viele Anmeldeversuche. Bitte in ${minutes} Minuten erneut versuchen.`
          : "Zu viele Anmeldeversuche. Bitte später erneut versuchen.";
    }
    setLoginStatus(message);
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
  const loginName = document.getElementById("login")?.value.trim();
  if (loginName) document.getElementById("setupLogin").value = loginName;
  closeModal(loginModal);
  openModal(passwordSetupModal);
  document.getElementById(loginName ? "setupNewPassword" : "setupLogin")?.focus();
});

document.getElementById("passwordSetupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const loginName = form.elements.username.value.trim();
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
    await setupPassword(loginName, newPassword);
    form.reset();
    closeModal(passwordSetupModal);
    window.showToast("Passwort wurde gesetzt. Du kannst dich jetzt anmelden.", "success");
    window.openLoginModal();
    document.getElementById("login").value = loginName;
  } catch (error) {
    const message = error.code === "PASSWORD_SETUP_INVALID"
      ? "Passwortvergabe ist für diesen Login nicht freigegeben."
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

  setModalBusy(form, true);
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
    window.showToast("Du wurdest erfolgreich rausgehängt.", "success");
    setTimeout(() => window.location.reload(), 1000);
  } catch (error) {
    releaseOperationId(operationKey, error);
    diagnostic.error("ranking_withdraw_failed", error);
    window.showToast(errorMessage(error, "Rückzug konnte nicht gespeichert werden."), "error");
  } finally {
    setModalBusy(form, false);
    submitButton.textContent = "Verbindlich raushängen";
  }
});

document.getElementById("matchDateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const matchDate = compactMatchDate(form.elements.rankingMatchDay.value, form.elements.rankingMatchHour.value);
  if (!matchDateContext || !matchDate) {
    window.showToast("Bitte wähle einen gültigen Spieltermin aus.", "error");
    return;
  }
  const context = { ...matchDateContext };
  const reason = form.elements.reason.value.trim();
  if (context.admin && !reason) {
    window.showToast("Bitte gib einen Grund an.", "error");
    form.elements.reason.focus();
    return;
  }
  const operationKey = `match:appointment:${context.matchId}:${matchDate}:${context.admin ? reason : ""}`;
  setModalBusy(form, true);
  submitButton.textContent = "Wird übernommen...";
  try {
    const request = { operationId: getOperationId(operationKey), matchId: context.matchId, matchDate };
    if (context.admin) request.reason = reason;
    const result = await (context.admin ? adminSetMatchAppointment : setMatchAppointment)(request);
    if (!result.data?.success) throw new Error(errorMessage(result.data, "Spieltermin konnte nicht gespeichert werden."));
    releaseOperationId(operationKey);
    closeModal(matchDateModal);
    window.showToast(context.previousDate ? "Der Spieltermin wurde geändert." : "Der Spieltermin wurde festgelegt.", "success");
    window.openProfileModal({ playerId: context.playerId, competitionId: context.competitionId });
  } catch (error) {
    releaseOperationId(operationKey, error);
    diagnostic.error("match_date_action_failed", error);
    window.showToast(errorMessage(error, "Spieltermin konnte nicht gespeichert werden."), "error");
  } finally {
    setModalBusy(form, false);
    submitButton.textContent = "Übernehmen";
  }
});

document.getElementById("matchResultForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!matchResultContext) return;
  const form = event.currentTarget;
  const context = { ...matchResultContext, match: { ...matchResultContext.match } };
  const payload = {
    matchId: context.match.matchId,
    expectedFingerprint: context.match.fingerprint,
  };
  let endpoint;
  if (context.action === "result" || context.action === "rankingRepair") {
    payload.kind = form.elements.kind.value;
    if (payload.kind !== "walkover") {
      try {
        payload.result = serializeMatchResultScore();
      } catch (error) {
        showMatchResultStatus(error.message);
        return;
      }
      if (payload.kind === "regular" && !payload.result) {
        showMatchResultStatus("Bitte geben Sie ein vollständiges Ergebnis ein.");
        return;
      }
    }
    if (payload.kind !== "regular") {
      payload.losingSide = Number(form.elements.losingSide.value);
      if (![1, 2].includes(payload.losingSide)) {
        showMatchResultStatus("Bitte wählen Sie die Verliererseite aus.");
        return;
      }
    }
    if (context.match.status === "open" && payload.kind !== "walkover") {
      payload.matchStart = compactResultDate(form.elements.matchStart.value);
      payload.matchEnd = compactResultDate(form.elements.matchEnd.value);
      if (!payload.matchStart || !payload.matchEnd) {
        showMatchResultStatus("Bitte geben Sie einen gültigen Matchstart und ein gültiges Matchende an.");
        return;
      }
    }
    if (context.action === "rankingRepair") {
      payload.reason = form.elements.reason.value.trim();
      if (!payload.reason) {
        showMatchResultStatus("Bitte geben Sie einen Grund an.");
        return;
      }
      payload.rankPlan = [...document.querySelectorAll("#matchResultRankPlan input")].map((input) => ({
        personId: input.dataset.personId,
        expectedRank: Number(input.dataset.expectedRank),
        newRank: Number(input.value),
      }));
      if (payload.rankPlan.length !== context.rankingMembers.length
        || payload.rankPlan.some(({ expectedRank, newRank }) => !Number.isInteger(newRank) || newRank < (expectedRank === 0 ? 0 : 1) || newRank > 10000)) {
        showMatchResultStatus("Aktive Mitglieder benötigen einen Zielrang von 1 bis 10000; bereits Rausgehängte dürfen auf Rang 0 bleiben.");
        return;
      }
      const positiveRanks = payload.rankPlan.map(({ newRank }) => newRank).filter((rank) => rank > 0);
      if (new Set(positiveRanks).size !== positiveRanks.length) {
        showMatchResultStatus("Positive Zielränge müssen eindeutig sein.");
        return;
      }
      endpoint = adminCorrectRankingResult;
    } else endpoint = setMatchResult;
  } else {
    payload.reason = form.elements.reason.value.trim();
    if (!payload.reason) {
      showMatchResultStatus("Bitte geben Sie einen Grund an.");
      return;
    }
    if (context.action === "matchEnd") {
      payload.matchEnd = compactResultDate(form.elements.matchEnd.value);
      if (!payload.matchEnd) {
        showMatchResultStatus("Bitte geben Sie ein gültiges Matchende an.");
        return;
      }
      endpoint = adminSetMatchEnd;
    } else {
      endpoint = adminClearMatchResult;
    }
  }
  const operationKey = `match-result:${context.action}:${context.match.matchId}:${JSON.stringify(payload)}`;
  payload.operationId = getOperationId(operationKey);
  const submit = document.getElementById("matchResultSubmit");
  const originalLabel = submit.textContent;
  setModalBusy(form, true);
  submit.textContent = "Wird gespeichert...";
  try {
    const response = await endpoint(payload);
    if (!response.data?.success) throw endpointResultError(response.data, "Matchänderung konnte nicht gespeichert werden.");
    releaseOperationId(operationKey);
    closeModal(matchResultModal);
    window.showToast("Matchänderung wurde gespeichert.", "success");
    await window.openProfileModal({ playerId: context.playerId, competitionId: context.competitionId });
  } catch (error) {
    releaseOperationId(operationKey, error);
    diagnostic.error("match_result_action_failed", error);
    showMatchResultStatus(error?.code === "RANKING_REPAIR_REQUIRED"
      ? "Ranglistenstand muss mit einem vollständigen Rangplan administrativ repariert werden."
      : errorMessage(error, "Matchänderung konnte nicht gespeichert werden."));
  } finally {
    setModalBusy(form, false);
    if (matchResultContext) submit.textContent = originalLabel;
  }
});

document.getElementById("adminRankingActionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const reason = form.elements.adminRankingReason.value.trim();
  if (!adminRankingActionContext || getUser()?.role !== "admin") {
    window.showToast("Administratorberechtigung oder Forderung fehlt.", "error");
    closeModal(adminRankingActionModal);
    return;
  }
  if (!reason) {
    window.showToast("Bitte geben Sie einen Grund an.", "error");
    form.elements.adminRankingReason.focus();
    return;
  }
  const context = { ...adminRankingActionContext };
  const date = context.action === "delete"
    ? ""
    : compactAdminRankingDate(form.elements.adminRankingDay.value, form.elements.adminRankingTime.value, false);
  if (context.action !== "delete" && !date) {
    window.showToast("Bitte wählen Sie einen gültigen Zeitpunkt aus.", "error");
    return;
  }
  const operationKey = `ranking:admin:${context.action}:${context.matchId}:${date}:${reason}`;
  const request = { operationId: getOperationId(operationKey), matchId: context.matchId, reason };
  const endpoint = context.action === "delete"
    ? adminDeleteRankingChallenge
    : adminSetRankingChallengeDate;
  if (context.action === "challengeDate") request.challengeDate = date;
  const submitButton = form.querySelector('button[type="submit"]');
  setModalBusy(form, true);
  submitButton.textContent = "Wird ausgeführt...";
  try {
    const result = await endpoint(request);
    if (!result.data?.success) throw new Error(errorMessage(result.data, "Adminaktion konnte nicht ausgeführt werden."));
    releaseOperationId(operationKey);
    closeModal(adminRankingActionModal);
    window.showToast(context.action === "delete" ? "Die Forderung wurde gelöscht." : "Der Zeitpunkt wurde geändert.", "success");
    await window.openProfileModal({ playerId: context.playerId, competitionId: context.competitionId });
  } catch (error) {
    releaseOperationId(operationKey, error);
    diagnostic.error("ranking_admin_action_failed", error);
    window.showToast(errorMessage(error, "Adminaktion konnte nicht ausgeführt werden."), "error");
  } finally {
    setModalBusy(form, false);
    if (adminRankingActionContext) submitButton.textContent = context.action === "delete"
      ? "Forderung löschen"
      : "Forderungsdatum ändern";
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
  if (event.key === "Tab" && !matchResultModal.classList.contains("hidden")) {
    const focusable = [...matchResultModal.querySelectorAll("button:not([hidden]):not(:disabled), input:not([hidden]):not(:disabled), select:not([hidden]):not(:disabled), textarea:not([hidden]):not(:disabled)")]
      .filter((element) => !element.closest("[hidden]"));
    if (!focusable.length) return;
    const currentIndex = focusable.indexOf(document.activeElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    focusable[nextIndex].focus();
    return;
  }
  if (event.key === "Tab" && !adminRankingActionModal.classList.contains("hidden")) {
    const focusable = [...adminRankingActionModal.querySelectorAll("button:not([hidden]):not(:disabled), input:not([hidden]):not(:disabled), select:not([hidden]):not(:disabled), textarea:not([hidden]):not(:disabled)")];
    if (!focusable.length) return;
    const currentIndex = focusable.indexOf(document.activeElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    focusable[nextIndex].focus();
    return;
  }
  if (event.key === "Tab" && !messageDetailModal.classList.contains("hidden")) {
    const focusable = [...messageDetailModal.querySelectorAll("button:not([hidden]):not(:disabled)")];
    if (!focusable.length) return;
    const currentIndex = focusable.indexOf(document.activeElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    focusable[nextIndex].focus();
    return;
  }
  if (event.key !== "Escape") return;
  const openModals = [...document.querySelectorAll(".modal:not(.hidden):not(.explicit-dismiss)")];
  const topModal = openModals.at(-1);
  if (topModal) closeModal(topModal);
});
