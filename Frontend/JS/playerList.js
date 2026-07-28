import { createEndpoint, subscribeInvalidations } from "./dataClient.js";
import { ready, getUser, subscribeAuth } from "./authClient.js";
import { signalMonitorReady, signalMonitorFailed } from "./monitorReady.js";

const readMemberDirectory = createEndpoint("memberDirectory");
let directoryRenderGeneration = 0;

function formatTelefon(value) {
  return String(value || "").trim().replace(/^0043/, "+43") || "---";
}

function getElements() {
  return {
    table: document.getElementById("tbl"),
    tbody: document.querySelector("#tbl tbody"),
    message: document.getElementById("playerDirectoryMessage"),
  };
}

function renderAnonymous() {
  const { table, tbody, message } = getElements();
  if (!table || !tbody || !message) return;

  table.hidden = true;
  tbody.replaceChildren();
  message.hidden = false;
  message.replaceChildren();

  const text = document.createElement("p");
  text.textContent = "Bitte melden Sie sich an, um das Spielerverzeichnis zu sehen.";

  const loginButton = document.createElement("button");
  loginButton.type = "button";
  loginButton.className = "btn-login";
  loginButton.textContent = "Anmelden";
  loginButton.addEventListener("click", () => window.openLoginModal?.());

  message.appendChild(text);
  message.appendChild(loginButton);
}

function renderError(error) {
  const { table, tbody, message } = getElements();
  if (!table || !tbody || !message) return;

  table.hidden = true;
  tbody.replaceChildren();
  message.hidden = false;
  message.textContent = error?.message || "Spielerverzeichnis konnte nicht geladen werden.";
}

function appendCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = String(value || "");
  row.appendChild(cell);
}

async function renderDirectory(user = getUser()) {
  const generation = ++directoryRenderGeneration;

  if (!user) {
    renderAnonymous();
    return;
  }

  const { table, tbody, message } = getElements();
  if (!table || !tbody || !message) {
    const error = new Error("Spielerverzeichnis-Elemente fehlen.");
    error.code = "PLAYER_DIRECTORY_CONTAINER_MISSING";
    throw error;
  }

  table.hidden = true;
  message.hidden = false;
  message.textContent = "Spieler werden geladen...";

  let result;
  try {
    result = await readMemberDirectory();
  } catch (error) {
    if (generation !== directoryRenderGeneration) return;
    throw error;
  }
  if (generation !== directoryRenderGeneration) return;

  if (!result.data?.success) {
    if (result.data?.error?.code === "AUTH_REQUIRED") {
      renderAnonymous();
      return;
    }
    const error = new Error(result.data?.error?.message || "Spielerverzeichnis konnte nicht geladen werden.");
    error.code = result.data?.error?.code || "PLAYER_DIRECTORY_LOAD_FAILED";
    throw error;
  }

  const values = result.data.values || [];
  tbody.replaceChildren();

  if (values.length < 2) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.style.textAlign = "center";
    cell.textContent = "Keine Spieler gefunden.";
    row.appendChild(cell);
    tbody.appendChild(row);
  } else {
    const header = values[0].map((value) => String(value || "").trim().toLowerCase());
    const firstNameIndex = header.indexOf("vorname");
    const lastNameIndex = header.indexOf("nachname");
    const phoneIndex = header.indexOf("telefonmobil");
    const activeIndex = header.indexOf("aktiv");

    const rows = values.slice(1)
      .filter((row) => activeIndex < 0 || String(row[activeIndex] || "").trim() === "1")
      .sort((a, b) => {
        const lastNameA = String(a[lastNameIndex] || "").trim().toLocaleLowerCase("de");
        const lastNameB = String(b[lastNameIndex] || "").trim().toLocaleLowerCase("de");
        return lastNameA.localeCompare(lastNameB, "de");
      });

    rows.forEach((valuesRow) => {
      const row = document.createElement("tr");
      appendCell(row, String(valuesRow[lastNameIndex] || "").trim());
      appendCell(row, String(valuesRow[firstNameIndex] || "").trim());
      appendCell(row, formatTelefon(valuesRow[phoneIndex]));
      tbody.appendChild(row);
    });
  }

  message.hidden = true;
  message.replaceChildren();
  table.hidden = false;
}

let directoryInitialized = false;
let observedUserId = null;

subscribeAuth((user) => {
  const nextUserId = String(user?.id || "");
  const authChanged = directoryInitialized && nextUserId !== observedUserId;
  observedUserId = nextUserId;
  if (!authChanged) return;

  if (!user) {
    renderDirectory(null);
    return;
  }

  queueMicrotask(() => {
    if (String(getUser()?.id || "") !== nextUserId) return;
    renderDirectory(getUser()).catch((error) => {
      console.error("Spielerverzeichnis konnte nicht aktualisiert werden:", error);
      renderError(error);
    });
  });
});

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const user = await ready;
    observedUserId = String(user?.id || "");
    directoryInitialized = true;
    await renderDirectory(user);
    subscribeInvalidations(["players"], () => renderDirectory(getUser()));
    signalMonitorReady();
  } catch (error) {
    console.error("Spielerverzeichnis konnte nicht initialisiert werden:", error);
    renderError(error);
    signalMonitorFailed(error.code || "PLAYER_DIRECTORY_LOAD_FAILED");
  }
});
