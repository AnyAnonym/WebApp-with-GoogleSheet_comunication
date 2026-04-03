import { functions } from "./SDK.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-functions.js";

//-------------------------------------------------------
// Passwort-Hash-Funktion
//-------------------------------------------------------
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}

//-------------------------------------------------------
// Hilfsfunktion: Modal-HTML erzeugen und ins DOM einfügen
//-------------------------------------------------------
function createModal(id, innerHTML) {
  const div = document.createElement("div");
  div.id = id;
  div.className = "modal hidden";
  div.innerHTML = `
    <div class="modal-content">
      <span class="close">&times;</span>
      ${innerHTML}
    </div>
  `;
  document.body.appendChild(div);

  // Schließen-Button automatisch verdrahten
  div.querySelector(".close").addEventListener("click", () => {
    div.classList.add("hidden");
  });

  return div;
}

//-------------------------------------------------------
// Alle Modals dynamisch erzeugen
//-------------------------------------------------------

// --- Login Modal ---
const modal = createModal("loginModal", `
  <h2>Login</h2>
  <form id="loginForm">
    <label for="email">E-Mail:</label>
    <input type="email" id="email" required>

    <label for="password">Passwort:</label>
    <input type="password" id="password" required>

    <button type="submit" class="btn-login">Anmelden</button>
  </form>
`);

// --- Sign Up Modal ---
const signupModal = createModal("signupModal", `
  <h2>Registrieren</h2>
  <form id="signupForm">
    <label for="signupFirstName">Vorname:</label>
    <input type="text" id="signupFirstName" required>

    <label for="signupLastName">Nachname:</label>
    <input type="text" id="signupLastName" required>

    <label for="signupEmail">E-Mail:</label>
    <input type="email" id="signupEmail" required>

    <label for="signupPassword">Passwort:</label>
    <input type="password" id="signupPassword" required>

    <button type="submit" class="btn-login">Registrieren</button>
  </form>
`);

// --- Profil Modal ---
const profileModal = createModal("profileModal", `
  <h2 id="profileName">Profil</h2>
  <p id="profileText">Lade Profildaten...</p>
`);

// --- Match Modal (nur auf der Rangliste-Seite) ---
const isRanglistePage = !!document.getElementById("rankingContainer");
let matchModal = null;

if (isRanglistePage) {
  matchModal = createModal("matchModal", `
    <h2>Matchanfrage erstellen</h2>
    <form id="matchForm">
      <p>Spieler 1: <span id="player1Display" class="name-display"></span></p>
      <input type="hidden" id="player1" name="player1">
      <input type="hidden" id="player1Id" name="player1Id">

      <p>Spieler 3: <span id="player3Display" class="name-display"></span></p>
      <input type="hidden" id="player3" name="player3">
      <input type="hidden" id="player3Id" name="player3Id">

      <label for="matchDate">Datum:</label>
      <input type="date" id="matchDate" name="matchDate" required>

      <label for="platz">Platz:</label>
      <input type="text" id="platz" name="platz" required>

      <button type="submit" class="btn-login">Speichern</button>
    </form>
  `);
}

//-------------------------------------------------------
// Cloud Function Referenzen
//-------------------------------------------------------
const readPlayerDetails = httpsCallable(functions, "readPlayerDetails");

//-------------------------------------------------------
// Login Modal Logik
//-------------------------------------------------------
const openBtn = document.getElementById("openLogin");

openBtn.addEventListener("click", (e) => {
  e.preventDefault();
  modal.classList.remove("hidden");
});

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = e.target.email.value.trim();
  const password = e.target.password.value;
  const passwordHash = await hashPassword(password);

  console.log("Login attempt (hashed):", { email, passwordHash });

  const verifyFn = httpsCallable(functions, "verifyUserLogin");
  const result = await verifyFn({ email, passwordHash });
  const res = result.data;

  if (res.success && res.valid) {
    alert("Login erfolgreich!");

    localStorage.setItem("loggedInEmail", email);
    localStorage.setItem("currentUserEmail", email);
    localStorage.setItem("isLoggedIn", "true");

    try {
      const profileData = await readPlayerDetails();
      const players = profileData.data?.players || [];
      const currentPlayer = players.find(
        (p) => p.email.trim().toLowerCase() === email.trim().toLowerCase()
      );
      if (currentPlayer) {
        localStorage.setItem("currentUserName", currentPlayer.fullName || "");
        localStorage.setItem("currentUserId", currentPlayer.id || "");
      }
    } catch (err) {
      console.warn("Profil-Daten nach Login nicht geladen:", err);
    }

    window.location.reload();

  } else if (res.success && !res.valid) {
    alert("Falsches Passwort!");
  } else {
    alert("Fehler: " + (res.error ?? res.message));
  }

  modal.classList.add("hidden");
});

//-------------------------------------------------------
// Sign Up Modal Logik
//-------------------------------------------------------
const openSignup = document.getElementById("openSignup");

openSignup.addEventListener("click", (e) => {
  e.preventDefault();
  signupModal.classList.remove("hidden");
});

document.getElementById("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const firstName = e.target.signupFirstName.value.trim();
  const lastName = e.target.signupLastName.value.trim();
  const email = e.target.signupEmail.value.trim();
  const password = e.target.signupPassword.value;
  const hash = await hashPassword(password);

  console.log("Sign-Up-Attempt:", { firstName, lastName, email, hash });

  const upsertFn = httpsCallable(functions, "upsertData");
  const result = await upsertFn({ firstName, lastName, email, hash });
  const { success, error } = result.data;

  if (success) {
    alert("Registrierung erfolgreich! Du bist jetzt eingeloggt.");

    localStorage.setItem("loggedInEmail", email);
    localStorage.setItem("isLoggedIn", "true");
    localStorage.setItem("currentUserEmail", email);

    window.location.reload();

  } else {
    alert("Fehler beim Speichern: " + error);
  }

  signupModal.classList.add("hidden");
});

//-------------------------------------------------------
// Sign Out Button Logik
//-------------------------------------------------------
document.getElementById("signOutButton").addEventListener("click", (e) => {
  e.preventDefault();

  localStorage.removeItem("loggedInEmail");
  localStorage.removeItem("currentUserEmail");
  localStorage.removeItem("currentUserId");
  localStorage.removeItem("currentUserName");
  localStorage.removeItem("isLoggedIn");

  window.location.reload();
});

//-------------------------------------------------------
// Profil Modal Logik
//-------------------------------------------------------
const openProfile = document.getElementById("profileButton");
const profileName = document.getElementById("profileName");
const profileText = document.getElementById("profileText");

openProfile.addEventListener("click", async (e) => {
  e.preventDefault();

  const email = localStorage.getItem("loggedInEmail");
  if (!email) {
    alert("Kein Benutzer eingeloggt!");
    return;
  }

  profileName.textContent = "Lade Profil...";
  profileText.textContent = "";
  profileModal.classList.remove("hidden");

  try {
    const result = await readPlayerDetails();
    const { success, players } = result.data;

    if (!success || !Array.isArray(players)) {
      throw new Error("Spieler-Liste konnte nicht geladen werden.");
    }

    const player = players.find(
      (p) => p.email.trim().toLowerCase() === email.trim().toLowerCase()
    );

    if (!player) {
      profileName.textContent = "Unbekanntes Profil";
      profileText.textContent = "Keine Daten gefunden.";
      localStorage.removeItem("currentUserName");
      return;
    }

    profileName.textContent = player.fullName || "Unbekannter Spieler";
    profileText.innerHTML = `
      <strong>E-Mail:</strong> ${player.email || "-"}<br>
      <strong>Geburtsdatum:</strong> ${player.birthDate || "-"}
    `;

    localStorage.setItem("currentUserName", player.fullName || "");
  } catch (err) {
    console.error("Fehler beim Laden des Profils:", err);
    profileName.textContent = "Fehler beim Laden!";
    profileText.textContent = err.message;
  }
});

//-------------------------------------------------------
// Beim Laden: Auth-Status wiederherstellen
//-------------------------------------------------------
window.addEventListener("DOMContentLoaded", () => {
  const isLoggedIn = localStorage.getItem("isLoggedIn") === "true";
  if (isLoggedIn) {
    document.querySelectorAll(".loggedIn").forEach((el) => {
      el.style.display = "inline";
    });
    document.querySelectorAll(".loggedOut").forEach((el) => {
      el.style.display = "none";
    });
  }
});

//-------------------------------------------------------
// Match-Anfrage Modal Logik (nur auf Rangliste-Seite)
//-------------------------------------------------------
if (isRanglistePage && matchModal) {
  const player1Input = document.getElementById("player1");
  const player1IdInput = document.getElementById("player1Id");
  const player3Input = document.getElementById("player3");
  const player3IdInput = document.getElementById("player3Id");
  const player1Display = document.getElementById("player1Display");
  const player3Display = document.getElementById("player3Display");
  const datumInput = document.getElementById("matchDate");
  const platzInput = document.getElementById("platz");

  document.getElementById("matchForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const matchData = {
      player1: player1Input.value.trim(),
      player1Id: player1IdInput.value.trim(),
      player3: player3Input.value.trim(),
      player3Id: player3IdInput.value.trim(),
      datum: datumInput.value,
      platz: platzInput.value.trim(),
    };

    console.log("Matchanfrage gesendet:", matchData);

    try {
      const addMatchFn = httpsCallable(functions, "addMatch");
      const result = await addMatchFn(matchData);
      const data = result.data;

      if (data?.success) {
        alert("Match erfolgreich gespeichert!");
      } else {
        throw new Error(data?.error || "Unbekannter Fehler beim Speichern");
      }
    } catch (err) {
      console.error("Fehler beim Speichern des Matches:", err);
      alert("Speichern fehlgeschlagen: " + (err.message || err));
    }

    matchModal.classList.add("hidden");
  });

  window.openMatchModal = ({
    player1 = "",
    player1Id = "",
    player3 = "",
    player3Id = "",
    datum = "",
    platz = "",
  } = {}) => {
    player1Input.value = player1;
    player1IdInput.value = player1Id;
    player1Display.textContent = player1;

    player3Input.value = player3 || localStorage.getItem("currentUserName") || "";
    player3IdInput.value = player3Id || localStorage.getItem("currentUserId") || "";
    player3Display.textContent = player3Input.value;

    datumInput.value = datum;
    platzInput.value = platz;

    matchModal.classList.remove("hidden");
  };

  window.closeMatchModal = () => {
    matchModal.classList.add("hidden");
  };
}
