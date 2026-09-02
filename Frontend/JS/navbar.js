import { ready, subscribeAuth } from "./authClient.js";
import { createEndpoint, subscribe } from "./dataClient.js";

const readMyMessageSummary = createEndpoint("myMessageSummary");
let stopMessageSubscription = null;
let messageIdentity = null;
let summaryGeneration = 0;

const currentPath = window.location.pathname.split("/").pop() || "index.html";

function activeClass(file) {
  return currentPath === file ? "active" : "";
}

function renderHeader() {
  const headerContainer = document.getElementById("header-container");
  if (!headerContainer) return;

  headerContainer.innerHTML = `
    <header>
      <a href="index.html" class="header-logo">ASKÖ Piberbach</a>

      <nav id="mainNav" class="main-nav desktop-nav">
        <a href="index.html" class="${activeClass("index.html")}">Dashboard</a>
        <a href="players.html" class="${activeClass("players.html")}" data-auth="required" hidden>Spieler</a>
        <a href="Matches1.html" class="${activeClass("Matches1.html")}">Matches</a>
        <a href="Bewerbe.html" class="${activeClass("Bewerbe.html")}">Bewerbe</a>
        <a href="scoreboard.html" class="${activeClass("scoreboard.html")}">Scoreboard</a>
        <a href="personenNormalisieren.html" class="${activeClass("personenNormalisieren.html")}" data-role="admin" hidden>Datenpflege</a>
        <a href="mitgliederAbgleichen.html" class="${activeClass("mitgliederAbgleichen.html")}" data-role="admin" hidden>Mitgliederabgleich</a>
        <a href="adminLogging.html" class="${activeClass("adminLogging.html")}" data-role="admin" hidden>Logging</a>
        <a href="servicebereich.html" class="${activeClass("servicebereich.html")}" data-role="admin" hidden>Servicebereich</a>
        <a href="https://epiber.at/grafana/" data-role="admin" hidden>Grafana</a>
      </nav>

      <div class="header-center">
        <span class="logo">ASKÖ Piberbach</span>
        <button class="hamburger" id="hamburgerBtn" type="button" aria-label="Menü öffnen">☰</button>
      </div>

      <nav class="auth-nav desktop-auth">
        <a href="#" id="openLogin" class="loggedOut" hidden style="display: none;">Anmelden</a>
        <a href="#" id="profileButton" class="loggedIn profile-link" hidden style="display: none;">Profil<span class="message-count-badge" hidden></span></a>
        <a href="#" id="signOutButton" class="loggedIn" hidden style="display: none;">Abmelden</a>
        <span class="authUnavailable" role="status" hidden></span>
      </nav>
    </header>
  `;
}

function renderMobileNav() {
  const mobileNavContainer = document.getElementById("mobile-nav-container");
  if (!mobileNavContainer) return;

  mobileNavContainer.innerHTML = `
    <div id="mobileNavModal" class="modal hidden">
      <div class="modal-content mobile-nav-content">
        <span class="close" role="button" aria-label="Schließen" tabindex="0">&times;</span>
        <nav class="mobile-auth-section">
          <a href="#" id="openLoginMobile" class="loggedOut" hidden style="display: none;">Anmelden</a>
          <a href="#" id="profileButtonMobile" class="loggedIn profile-link" hidden style="display: none;">Profil<span class="message-count-badge" hidden></span></a>
          <a href="#" id="signOutButtonMobile" class="loggedIn" hidden style="display: none;">Abmelden</a>
          <span class="authUnavailable" role="status" hidden></span>
        </nav>
        <nav class="mobile-nav-links">
          <a href="index.html" class="${activeClass("index.html")}">Dashboard</a>
          <a href="players.html" class="${activeClass("players.html")}" data-auth="required" hidden>Spieler</a>
          <a href="Matches1.html" class="${activeClass("Matches1.html")}">Matches</a>
          <a href="Bewerbe.html" class="${activeClass("Bewerbe.html")}">Bewerbe</a>
          <a href="scoreboard.html" class="${activeClass("scoreboard.html")}">Scoreboard</a>
          <a href="personenNormalisieren.html" class="${activeClass("personenNormalisieren.html")}" data-role="admin" hidden>Datenpflege</a>
          <a href="mitgliederAbgleichen.html" class="${activeClass("mitgliederAbgleichen.html")}" data-role="admin" hidden>Mitgliederabgleich</a>
          <a href="adminLogging.html" class="${activeClass("adminLogging.html")}" data-role="admin" hidden>Logging</a>
          <a href="servicebereich.html" class="${activeClass("servicebereich.html")}" data-role="admin" hidden>Servicebereich</a>
          <a href="https://epiber.at/grafana/" data-role="admin" hidden>Grafana</a>
        </nav>
      </div>
    </div>
  `;
}

function setAuthControlVisibility(element, visible) {
  element.hidden = !visible;
  if (!visible) {
    element.style.display = "none";
    return;
  }
  element.style.display = element.closest(".mobile-auth-section") ? "block" : "inline";
}

function renderAuthState(user, authState = {}) {
  const authenticated = Boolean(user);
  const resolved = ["authenticated", "anonymous"].includes(authState.status);

  document.querySelectorAll(".loggedIn").forEach((element) => {
    setAuthControlVisibility(element, resolved && authenticated);
  });
  document.querySelectorAll(".loggedOut").forEach((element) => {
    setAuthControlVisibility(element, resolved && !authenticated);
  });
  document.querySelectorAll('[data-auth="required"]').forEach((element) => {
    element.hidden = !resolved || !authenticated;
  });
  document.querySelectorAll('[data-role="admin"]').forEach((element) => {
    element.hidden = !resolved || user?.role !== "admin";
  });
  document.querySelectorAll(".authUnavailable").forEach((element) => {
    const visible = !resolved;
    element.hidden = !visible;
    element.style.display = visible ? "inline" : "none";
    element.textContent = authState.status === "unavailable" ? "Anmeldung nicht erreichbar" : "Anmeldung wird geprüft";
  });
}

function setMessageCount(rawCount, revision = null) {
  const count = Math.max(0, Number(rawCount) || 0);
  const hamburgerButton = document.getElementById("hamburgerBtn");
  hamburgerButton?.classList.toggle("has-unread-messages", count > 0);
  hamburgerButton?.setAttribute("aria-label", count ? `Menü öffnen, ${count} ungelesene Meldungen` : "Menü öffnen");
  document.querySelectorAll(".profile-link").forEach((link) => {
    const badge = link.querySelector(".message-count-badge");
    if (badge) {
      badge.textContent = String(count);
      badge.hidden = count === 0;
    }
    link.setAttribute("aria-label", count ? `Profil, ${count} ungelesene Meldungen` : "Profil");
  });
  window.dispatchEvent(new CustomEvent("epiber-message-summary", {
    detail: { unreadCount: count, revision },
  }));
}

async function refreshMessageSummary(identity = messageIdentity) {
  const generation = ++summaryGeneration;
  if (!identity) {
    setMessageCount(0);
    return;
  }
  try {
    const result = await readMyMessageSummary();
    if (generation !== summaryGeneration || identity !== messageIdentity || !result.data?.success) return;
    setMessageCount(result.data.unreadCount, result.data.revision);
  } catch {
    // Keep the last known count during a temporary connection failure.
  }
}

function updateMessageSubscription(user) {
  const identity = user?.id ? String(user.id) : null;
  if (identity === messageIdentity) return;
  stopMessageSubscription?.();
  stopMessageSubscription = null;
  messageIdentity = identity;
  summaryGeneration += 1;
  if (!identity) {
    setMessageCount(0);
    return;
  }
  stopMessageSubscription = subscribe(`messages:${identity}`, () => refreshMessageSummary(identity));
  refreshMessageSummary(identity);
}

function initMobileNavigation() {
  const hamburgerButton = document.getElementById("hamburgerBtn");
  const mobileNavModal = document.getElementById("mobileNavModal");
  if (!hamburgerButton || !mobileNavModal) return;

  hamburgerButton.addEventListener("click", () => {
    mobileNavModal.classList.remove("hidden");
  });

  mobileNavModal.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (
      event.target === mobileNavModal
      || event.target.closest(".mobile-nav-links a")
    ) {
      mobileNavModal.classList.add("hidden");
    }
  });
}

async function initNavigation() {
  renderHeader();
  renderMobileNav();
  initMobileNavigation();

  subscribeAuth((user, authState) => {
    renderAuthState(user, authState);
    updateMessageSubscription(authState.status === "authenticated" ? user : null);
  });
  window.addEventListener("epiber-message-summary-refresh", () => refreshMessageSummary());

  await ready;
}

initNavigation();
