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

window.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.add("hidden");
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

window.addEventListener("click", (e) => {
  if (e.target === signupModal) signupModal.classList.add("hidden");
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
      return;
    }

    // 🔹 Name in Überschrift, Rest als Text
    profileName.textContent = player.fullName || "Unbekannter Spieler";
    profileText.innerHTML = `
      <strong>E-Mail:</strong> ${player.email || "-"}<br>
      <strong>Geburtsdatum:</strong> ${player.birthDate || "-"}
    `;
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

// Schließen bei Klick auf Hintergrund
window.addEventListener("click", (e) => {
  if (e.target === profileModal) profileModal.classList.add("hidden");
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