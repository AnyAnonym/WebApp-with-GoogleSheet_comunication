import { functions } from "./SDK.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-functions.js";

//------------------------------------------------------- 
// Passwort-Hash-Funktion
//-------------------------------------------------------
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data); // → ArrayBuffer
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}

//-------------------------------------------------------
// Login Modal
//-------------------------------------------------------
const modal = document.getElementById("loginModal");
const openBtn = document.getElementById("openLogin");
const closeBtn = modal.querySelector(".close");

openBtn.addEventListener("click", (e) => {
  e.preventDefault();
  modal.classList.remove("hidden");
});

closeBtn.addEventListener("click", () => {
  modal.classList.add("hidden");
});

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = e.target.email.value.trim();
  const password = e.target.password.value;
  const passwordHash = await hashPassword(password);

  console.log("🔑 Login attempt (hashed):", { email, passwordHash });

  // 🔹 Firebase Function aufrufen
  const verifyFn = httpsCallable(functions, "verifyUserLogin");
  const result = await verifyFn({ email, passwordHash });
  const res = result.data;

  if (res.success && res.valid) {
    alert("✅ Login erfolgreich!");

    // 💾 Speichere eingeloggt‑Status und E-Mail lokal
    localStorage.setItem("loggedInEmail", email);
    localStorage.setItem("isLoggedIn", "true");

    // UI umschalten
    document.querySelectorAll(".loggedIn").forEach((el) => {
      el.style.display = "inline";
    });
    document.querySelectorAll(".loggedOut").forEach((el) => {
      el.style.display = "none";
    });

  } else if (res.success && !res.valid) {
    alert("❌ Falsches Passwort!");
  } else {
    alert("⚠️ Fehler: " + (res.error ?? res.message));
  }

  modal.classList.add("hidden");
});

//-------------------------------------------------------
// Sign Up Modal
//-------------------------------------------------------
const signupModal = document.getElementById("signupModal");
const openSignup = document.getElementById("openSignup");
const closeSignup = signupModal.querySelector(".close");

openSignup.addEventListener("click", (e) => {
  e.preventDefault();
  signupModal.classList.remove("hidden");
});

closeSignup.addEventListener("click", () => {
  signupModal.classList.add("hidden");
});

document.getElementById("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const firstName = e.target.signupFirstName.value.trim();
  const lastName = e.target.signupLastName.value.trim();
  const email = e.target.signupEmail.value.trim();
  const password = e.target.signupPassword.value;
  const hash = await hashPassword(password);

  console.log("📝 Sign‑Up‑Attempt:", { firstName, lastName, email, hash });

  const upsertFn = httpsCallable(functions, "upsertData");
  const result = await upsertFn({ firstName, lastName, email, hash });
  const { success, error } = result.data;

  if (success) {
    alert("✅ Registrierung erfolgreich gespeichert!");
  } else {
    alert("❌ Fehler beim Speichern: " + error);
  }

  signupModal.classList.add("hidden");
});

//------------------------------------------------------- 
// Sign Out Button Logic
//-------------------------------------------------------
document.getElementById("signOutButton").addEventListener("click", (e) => {
  e.preventDefault();

  // Lösche eingeloggte Infos
  localStorage.removeItem("loggedInEmail");
  localStorage.removeItem("isLoggedIn");
  localStorage.removeItem("currentUserName");

  // UI zurücksetzen
  document.querySelectorAll(".loggedIn").forEach((element) => {
    element.style.display = "none";
  });
  document.querySelectorAll(".loggedOut").forEach((element) => {
    element.style.display = "inline";
  });

  alert("👋 Abgemeldet.");
});

//------------------------------------------------------- 
// Profil Modal Logic
//-------------------------------------------------------
const profileModal = document.getElementById("profileModal");
const openProfile = document.getElementById("profileButton");
const closeProfile = profileModal.querySelector(".close");
const profileName = document.getElementById("profileName");
const profileText = document.getElementById("profileText");

const readPlayerDetails = httpsCallable(functions, "readPlayerDetails");

// Öffnen
openProfile.addEventListener("click", async (e) => {
  e.preventDefault();

  // Hole E-Mail des aktuell eingeloggten Users (aus dem Login)
  // 👉 Du kannst diese beim Login in localStorage speichern:
  const email = localStorage.getItem("loggedInEmail");
  if (!email) {
    alert("⚠️ Kein Benutzer eingeloggt!");
    return;
  }

  // Lade alle Spieler
  profileName.textContent = "Lade Profil...";
  profileText.textContent = "";
  profileModal.classList.remove("hidden");

  try {
    const result = await readPlayerDetails();
    const { success, players } = result.data;

    if (!success || !Array.isArray(players)) {
      throw new Error("Spieler-Liste konnte nicht geladen werden.");
    }

    // Suche Benutzer per E-Mail
    const player = players.find(
      (p) => p.email.trim().toLowerCase() === email.trim().toLowerCase()
    );

    if (!player) {
      profileName.textContent = "Unbekanntes Profil";
      profileText.textContent = "Keine Daten gefunden.";
      localStorage.removeItem("currentUserName");
      return;
    }

    // 🔹 Name in Überschrift, Rest als Text
    profileName.textContent = player.fullName || "Unbekannter Spieler";
    profileText.innerHTML = `
      <strong>E-Mail:</strong> ${player.email || "-"}<br>
      <strong>Geburtsdatum:</strong> ${player.birthDate || "-"}
    `;

    // 🚀 Aktuellen Namen als Vorbelegung speichern
    localStorage.setItem("currentUserName", player.fullName || "");
  } catch (err) {
    console.error("❌ Fehler beim Laden des Profils:", err);
    profileName.textContent = "Fehler beim Laden!";
    profileText.textContent = err.message;
  }
});

// Schließen (X-Button)
closeProfile.addEventListener("click", () => {
  profileModal.classList.add("hidden");
});

// Beim Laden prüfen, ob der User eingeloggt ist
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

//----------------------------------------------------
// Match-Anfrage Modal Logik
//----------------------------------------------------

const matchModal = document.getElementById("matchModal");
const closeMatch = matchModal.querySelector(".close");
const matchForm = document.getElementById("matchForm");

const player1Input = document.getElementById("player1");
const player1IdInput = document.getElementById("player1Id");
const player2Input = null; // nicht benötigt
const player2IdInput = null;
const player3Input = document.getElementById("player3");
const player3IdInput = document.getElementById("player3Id");
const player4Input = null;
const player4IdInput = null;
const player1Display = document.getElementById("player1Display");
const player3Display = document.getElementById("player3Display");
const datumInput = document.getElementById("matchDate");
const platzInput = document.getElementById("platz");

closeMatch.addEventListener("click", () => {
  matchModal.classList.add("hidden");
});

matchForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const matchData = {
    player1: player1Input.value.trim(),
    player1Id: player1IdInput.value.trim(),
    player3: player3Input.value.trim(),
    player3Id: player3IdInput.value.trim(),
    datum: datumInput.value,
    platz: platzInput.value.trim(),
  };

  console.log("🎾 Matchanfrage gesendet:", matchData);

  try {
    const addMatchFn = httpsCallable(functions, "addMatch");
    const result = await addMatchFn(matchData);
    const data = result.data;

    if (data?.success) {
      alert("✅ Match erfolgreich gespeichert!");
    } else {
      throw new Error(data?.error || "Unbekannter Fehler beim Speichern");
    }
  } catch (err) {
    console.error("❌ Fehler beim Speichern des Matches:", err);
    alert("❌ Speichern fehlgeschlagen: " + (err.message || err));
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

