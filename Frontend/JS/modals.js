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
const readMyMessageSummary = createEndpoint("myMessageSummary");
const readMyMessages = createEndpoint("myMessages");
const readMyMessage = createEndpoint("myMessage");
const acknowledgeMessage = createEndpoint("acknowledgeMessage");
const addMatch = createEndpoint("addMatch");
const setRankingMatchDate = createEndpoint("setRankingMatchDate");
const withdrawFromRanking = createEndpoint("withdrawFromRanking");
const readWithdrawnRankingPlayers = createEndpoint("withdrawnRankingPlayers");
let withdrawContext = null;
let matchDateContext = null;
let matchCalendarMonth = null;
let adminPasswordTarget = null;
let profileRequestGeneration = 0;
let profileActionController = null;
let modalAuthIdentity = null;
let messageState = null;
let messageDetailReturnFocus = null;

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
  if (modal?.id === "profileModal") {
    closeModal(matchDateModal);
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

const withdrawalBlockedModal = createModal("withdrawalBlockedModal", `
  <h2 id="withdrawalBlockedTitle">Raushängen nicht möglich</h2>
  <p>Raushängen ist nur möglich, wenn die offene Forderung gespielt wurde.</p>
`);
withdrawalBlockedModal.setAttribute("role", "dialog");
withdrawalBlockedModal.setAttribute("aria-modal", "true");
withdrawalBlockedModal.setAttribute("aria-labelledby", "withdrawalBlockedTitle");
withdrawalBlockedModal.querySelector(".close")?.setAttribute("aria-label", "Hinweis schließen");

const matchDateModal = createModal("matchDateModal", `
  <h2 id="matchDateTitle">Spieltermin festlegen</h2>
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
    <button type="submit" class="btn-login">Übernehmen</button>
  </form>
`, { explicitDismiss: true });
matchDateModal.setAttribute("role", "dialog");
matchDateModal.setAttribute("aria-modal", "true");
matchDateModal.setAttribute("aria-labelledby", "matchDateTitle");
matchDateModal.querySelector(".close")?.setAttribute("aria-label", "Terminauswahl schließen");
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
  return `${match[3]}.${match[2]}.20${match[1]}, ${match[4]}:${match[5]} Uhr`;
}

function compactDateValue(value) {
  const match = String(value || "").trim().match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!match) return null;
  const date = new Date(2000 + Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isNaN(date.getTime()) ? null : date;
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
    const inOriginalWindow = timestamp >= matchDateContext.challengeDay && timestamp <= matchDateContext.finalDay;
    const selectable = matchDateContext.previousDate
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
      || (matchDateContext?.latestAt && candidate.getTime() > matchDateContext.latestAt);
    if (!option.disabled && !firstEnabled) firstEnabled = option.value;
  }
  if (!firstEnabled) hourInput.value = "";
  else if (!hourInput.value || hourInput.selectedOptions[0]?.disabled) hourInput.value = firstEnabled;
  document.querySelector('#matchDateForm button[type="submit"]').disabled = !firstEnabled;
}

function openMatchDateModal(challenge) {
  const matchId = String(challenge?.matchId || "").trim();
  if (!matchId) {
    window.showToast("Die offene Forderung konnte nicht eindeutig zugeordnet werden.", "error");
    return;
  }
  const currentDate = compactDateValue(challenge.matchDate);
  const dayInput = document.getElementById("rankingMatchDay");
  const hourInput = document.getElementById("rankingMatchHour");
  const today = new Date(Date.now());
  const now = today.getTime();
  today.setHours(0, 0, 0, 0);
  const challengedAt = compactDateValue(challenge.challengedAt);
  const finalDay = challengedAt ? new Date(challengedAt.getFullYear(), challengedAt.getMonth(), challengedAt.getDate() + 14) : today;
  matchDateContext = {
    matchId,
    previousDate: String(challenge.matchDate || ""),
    earliestAt: currentDate ? now : challengedAt?.getTime() || now,
    latestAt: currentDate || !challengedAt ? null : challengedAt.getTime() + 14 * 24 * 60 * 60 * 1000,
    today: calendarDayValue(today),
    challengeDay: challengedAt ? calendarDayValue(challengedAt) : calendarDayValue(today),
    finalDay: calendarDayValue(finalDay),
  };
  if (currentDate) {
    dayInput.value = currentDate >= today ? dateInputValue(currentDate) : dateInputValue(today);
    hourInput.value = String(currentDate.getHours()).padStart(2, "0");
    document.getElementById("matchDateTitle").textContent = "Termin abändern";
  } else {
    dayInput.value = challengedAt ? dateInputValue(challengedAt) : "";
    hourInput.value = "18";
    document.getElementById("matchDateTitle").textContent = "Spieltermin festlegen";
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
  const tabs = [...profileModal.querySelectorAll('[role="tab"]')];
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
    competition.textContent = competitionName;
    const roundName = String(message.roundName || "").trim();
    const subject = document.createElement("span");
    subject.className = "message-row-subject";
    subject.textContent = subjectText;
    row.append(date, competition);
    if (roundName) {
      const round = document.createElement("span");
      round.className = "message-row-round";
      round.textContent = roundName;
      row.appendChild(round);
    }
    row.appendChild(subject);
    const actorName = String(message.actorName || "").trim();
    if (actorName) {
      const actor = document.createElement("span");
      actor.className = "message-row-actor";
      actor.textContent = `Durch: ${actorName}`;
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
      actorElement.textContent = `Durch: ${actorName}`;
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
  const ownProfile = !requestedId || (sessionUser && requestedId === String(sessionUser.id));

  if (ownProfile && !sessionUser) {
    window.showToast("Bitte zuerst anmelden.", "error");
    window.openLoginModal();
    return;
  }

  const nameElement = document.getElementById("profileName");
  const textElement = document.getElementById("profileText");
  const tabsElement = document.getElementById("profileTabs");
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

    const rankings = Array.isArray(profile.rankings) ? profile.rankings : [];
    rankings.forEach((ranking, index) => {
      const panel = document.createElement("section");
      panel.id = `profileRankingPanel${index}`;
      panel.className = "profile-panel";
      panel.setAttribute("role", "tabpanel");
      panel.hidden = true;
      if (ranking.status === "active") appendProfileField(panel, "Ranglistenposition", ranking.rank, "", actionSignal);
      if (ranking.openChallenge) {
        const challenge = ranking.openChallenge;
        const opponentName = String(challenge.opponentName || "Unbekannt");
        const opponentRank = String(challenge.opponentRank ?? "").trim();
        const challengeBlock = document.createElement("div");
        challengeBlock.className = "profile-open-challenge";
        const directionLine = document.createElement("p");
        directionLine.textContent = `Offene Forderung ${challenge.direction === "challenged" ? "von" : "gegen"} ${opponentName}${opponentRank ? ` (${opponentRank})` : ""}`;
        const challengedAtLine = document.createElement("p");
        challengedAtLine.textContent = `Forderung vom ${formatCompactDate(challenge.challengedAt)}`;
        challengeBlock.append(directionLine, challengedAtLine);
        if (challenge.matchDate) {
          const matchDateLine = document.createElement("p");
          matchDateLine.textContent = `Spieltermin fixiert: ${formatCompactDate(challenge.matchDate)}`;
          challengeBlock.appendChild(matchDateLine);
        }
        if (ownProfile) appendMatchDateCountdown(challengeBlock, challenge, actionSignal);
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
        if (ranking.openChallenge) {
          const matchDateButton = document.createElement("button");
          matchDateButton.type = "button";
          matchDateButton.className = "btn-login";
          matchDateButton.textContent = ranking.openChallenge.matchDate ? "Termin abändern" : "Spieltermin festlegen";
          matchDateButton.addEventListener("click", () => openMatchDateModal(ranking.openChallenge), { signal: actionSignal });
          actions.appendChild(matchDateButton);
        }
        const withdrawButton = document.createElement("button");
        withdrawButton.type = "button";
        withdrawButton.className = "btn-login";
        withdrawButton.textContent = "Raushängen";
        withdrawButton.disabled = ranking.canWithdraw !== true && !ranking.openChallenge;
        if (ranking.openChallenge) {
          withdrawButton.addEventListener("click", () => {
            openModal(withdrawalBlockedModal);
            withdrawalBlockedModal.querySelector(".close")?.focus();
          }, { once: true, signal: actionSignal });
        } else if (ranking.canWithdraw === true) {
          withdrawButton.addEventListener("click", () => {
            window.openWithdrawModal({ rank: ranking.rank, bewerbId: ranking.competitionId });
          }, { once: true, signal: actionSignal });
        }
        actions.appendChild(withdrawButton);
      } else if (ranking.canChallenge === true) {
        appendChallengeButton(actions, profile, ranking, actionSignal);
      }
      rankingPanelsElement.appendChild(panel);
    });

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
    appendProfileTab(tabsElement, "System", systemPanel, true, actionSignal);
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
          if (!messageState?.loaded) loadMessages();
        },
      );
    }
    [...rankingPanelsElement.children].forEach((panel, index) => {
      appendProfileTab(tabsElement, rankings[index].competitionName, panel, false, actionSignal);
    });
    if (adminActionsElement.childElementCount) {
      adminPanel.hidden = true;
      appendProfileTab(tabsElement, "Admin", adminPanel, false, actionSignal);
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
  }
  modalAuthIdentity = identity;
  if (user) return;
  withdrawContext = null;
  closeModal(passwordModal);
  closeModal(adminPasswordModal);
  closeModal(resetProofModal);
  closeModal(matchDateModal);
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
  const operationKey = `ranking:match-date:${context.matchId}:${matchDate}`;
  setModalBusy(form, true);
  submitButton.textContent = "Wird übernommen...";
  try {
    const result = await setRankingMatchDate({ operationId: getOperationId(operationKey), matchId: context.matchId, matchDate });
    if (!result.data?.success) throw new Error(errorMessage(result.data, "Spieltermin konnte nicht gespeichert werden."));
    releaseOperationId(operationKey);
    closeModal(matchDateModal);
    window.showToast(context.previousDate ? "Der Spieltermin wurde geändert." : "Der Spieltermin wurde festgelegt.", "success");
    window.openProfileModal();
  } catch (error) {
    releaseOperationId(operationKey, error);
    diagnostic.error("ranking_match_date_failed", error);
    window.showToast(errorMessage(error, "Spieltermin konnte nicht gespeichert werden."), "error");
  } finally {
    setModalBusy(form, false);
    submitButton.textContent = "Übernehmen";
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
