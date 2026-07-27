// ── Konfiguration (hier anpassen) ──
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 10000;

// ── Retry-Logik für asynchrone Backend-Aufrufe ──

export async function callWithRetry(fn, args = {}, opts = {}) {
  const maxAttempts = opts.maxAttempts || RETRY_MAX_ATTEMPTS;
  const baseDelay = opts.baseDelay || RETRY_BASE_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fn(args);
      if (res.data?.success !== false) return res;
      // success === false → behandeln wie Fehler
      if (attempt < maxAttempts) {
        console.warn(`callWithRetry: Versuch ${attempt}/${maxAttempts} fehlgeschlagen (success=false), retry in ${baseDelay}ms...`);
        await delay(baseDelay);
      } else {
        return res; // letzter Versuch, Ergebnis trotzdem zurückgeben
      }
    } catch (err) {
      if (attempt < maxAttempts) {
        console.warn(`callWithRetry: Versuch ${attempt}/${maxAttempts} Fehler: ${err.message}, retry in ${baseDelay}ms...`);
        await delay(baseDelay);
      } else {
        throw err;
      }
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Lade-Overlay ──

let activeOverlay = null;

export function showLoadingOverlay(text = "Daten werden geladen...") {
  if (activeOverlay) return;
  const overlay = document.createElement("div");
  overlay.className = "loading-overlay";
  overlay.innerHTML = `
    <div class="loading-overlay-content">
      <div class="loading-spinner"></div>
      <div class="loading-text">${text}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  activeOverlay = overlay;
}

export function hideLoadingOverlay() {
  if (activeOverlay) {
    activeOverlay.classList.add("fade-out");
    setTimeout(() => {
      if (activeOverlay) {
        activeOverlay.remove();
        activeOverlay = null;
      }
    }, 400);
  }
}

export function showErrorOverlay(message = "Fehler beim Laden der Daten", reloadFn = null) {
  hideLoadingOverlay();
  const overlay = document.createElement("div");
  overlay.className = "loading-overlay error";
  overlay.innerHTML = `
    <div class="loading-overlay-content">
      <div class="loading-error-icon">!</div>
      <div class="loading-text">${message}</div>
      ${reloadFn ? '<button class="loading-retry-btn">Erneut laden</button>' : ""}
    </div>
  `;
  if (reloadFn) {
    overlay.querySelector(".loading-retry-btn").addEventListener("click", () => {
      overlay.remove();
      activeOverlay = null;
      reloadFn();
    });
  }
  document.body.appendChild(overlay);
  activeOverlay = overlay;
}
