import { functions } from "./SDK.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-functions.js";

const readPreMatches = httpsCallable(functions, "readPreMatches");
const setPreMatchResultFn = httpsCallable(functions, "setPreMatchResult");

function createResultModal() {
  const modal = document.createElement("div");
  modal.id = "resultModal";
  modal.className = "modal hidden";
  modal.innerHTML = `
    <div class="modal-content">
      <span class="close">&times;</span>
      <h2>Ergebnis eintragen</h2>
      <p>Match: <span id="resultMatchInfo" class="name-display"></span></p>
      <form id="resultForm">
        <div class="satz-input-group">
          <label for="satz1">Satz 1:</label>
          <input type="text" id="satz1" placeholder="z.B. 6:4" required pattern="\\d+:\\d+">
        </div>
        <div class="satz-input-group">
          <label for="satz2">Satz 2:</label>
          <input type="text" id="satz2" placeholder="z.B. 3:6" required pattern="\\d+:\\d+">
        </div>
        <div class="satz-input-group">
          <label for="satz3">Satz 3:</label>
          <input type="text" id="satz3" placeholder="z.B. 7:5" pattern="\\d+:\\d+">
        </div>
        <button type="submit" class="btn-login">Ergebnis senden</button>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector(".close").addEventListener("click", () => {
    modal.classList.add("hidden");
  });

  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.classList.add("hidden");
    }
  });

  return modal;
}

const resultModal = createResultModal();
let currentResultRow = null;

window.openResultModal = (row, matchInfo) => {
  currentResultRow = row;
  document.getElementById("resultMatchInfo").textContent = matchInfo;
  document.getElementById("satz1").value = "";
  document.getElementById("satz2").value = "";
  document.getElementById("satz3").value = "";
  resultModal.classList.remove("hidden");
};

window.closeResultModal = () => {
  resultModal.classList.add("hidden");
  currentResultRow = null;
};

document.getElementById("resultForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentResultRow) return;

  const userId = localStorage.getItem("currentUserId");
  if (!userId) {
    alert("Bitte einloggen um das Ergebnis einzutragen.");
    return;
  }

  const satz1 = document.getElementById("satz1").value.trim();
  const satz2 = document.getElementById("satz2").value.trim();
  const satz3 = document.getElementById("satz3").value.trim();
  const submitBtn = e.target.querySelector('button[type="submit"]');

  submitBtn.disabled = true;
  submitBtn.textContent = "Senden...";

  try {
    const result = await setPreMatchResultFn({
      row: currentResultRow,
      satz1,
      satz2,
      satz3,
      userId,
    });

    if (result.data?.success) {
      submitBtn.textContent = "Gesendet!";
      setTimeout(() => {
        window.closeResultModal();
        loadPreMatches();
      }, 500);
    } else {
      throw new Error(result.data?.error || "Fehler");
    }
  } catch (err) {
    console.error("Fehler:", err);
    alert("Fehler: " + err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = "Ergebnis senden";
  }
});

async function loadPreMatches() {
  const container = document.getElementById("preMatches-container");
  if (!container) return;

  const userId = localStorage.getItem("currentUserId") || null;

  container.innerHTML = "<p class='loading-text'>Lade Forderungen...</p>";

  try {
    const result = await readPreMatches({ userId });
    const { success, preMatches = [], error } = result.data || {};

    if (!success) {
      throw new Error(error || "Fehler beim Laden");
    }

    if (preMatches.length === 0) {
      container.innerHTML = "<p>Keine offenen Forderungen.</p>";
      return;
    }

    container.innerHTML = preMatches.map((match) => {
      const team1 = [match.player1, match.player2].filter(Boolean).join(" / ") || "---";
      const team2 = [match.player3, match.player4].filter(Boolean).join(" / ") || "---";
      const statusBadge = getStatusBadge(match.status, match.ergebnis);
      const actionButton = getActionButton(match, userId);

      return `
        <div class="match-card ${match.status === 'offen' ? 'status-offen' : match.status === 'bestaetigt' ? 'status-bestaetigt' : ''}">
          <div class="match-status">${statusBadge}</div>
          <div class="match-date">${match.datum || "Datum nicht festgelegt"} - ${match.platz || "Platz nicht festgelegt"}</div>
          <div class="match-content">
            <div class="team">
              <div class="player main">${team1}</div>
            </div>
            <div class="vs">vs.</div>
            <div class="team">
              <div class="player main">${team2}</div>
            </div>
            <div class="action-area">
              ${actionButton}
            </div>
          </div>
        </div>
      `;
    }).join("");

    document.querySelectorAll(".result-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = parseInt(btn.dataset.row);
        const match = preMatches.find((m) => m.row === row);
        const matchInfo = `${match?.player1 || ""} vs ${match?.player3 || ""}`;
        window.openResultModal(row, matchInfo);
      });
    });

  } catch (err) {
    console.error("Fehler beim Laden:", err);
    container.innerHTML = `<p>Fehler beim Laden der Forderungen: ${err.message}</p>`;
  }
}

function getStatusBadge(status, ergebnis) {
  if (ergebnis) {
    return '<span class="badge badge-ergebnis">Ergebnis eingetragen</span>';
  }
  switch (status) {
    case "offen":
      return '<span class="badge badge-offen">Offen</span>';
    case "bestaetigt":
      return '<span class="badge badge-bestaetigt">Bestätigt</span>';
    case "gespielt":
      return '<span class="badge badge-gespielt">Gespielt</span>';
    case "abgelaufen":
      return '<span class="badge badge-abgelaufen">Abgelaufen</span>';
    default:
      return `<span class="badge">${status}</span>`;
  }
}

function getActionButton(match, userId) {
  if (!userId) {
    return `<span class="waiting-text">Anmelden zum Eintragen</span>`;
  }
  if (match.isForMe && !match.ergebnis) {
    return `<button class="result-btn btn-action" data-row="${match.row}">Ergebnis eintragen</button>`;
  }
  return `<span class="waiting-text">---</span>`;
}

document.addEventListener("DOMContentLoaded", () => {
  loadPreMatches();
});
