// ══════════════════════════════════════════════════════
// server.js — ePiber-Backend-Hauptserver
// Orchestriert: dataPoller, courtPoller, dataProvider
// HTTP-Endpoints: health, status, set-active
// ══════════════════════════════════════════════════════

const http = require("http");
const { PORT } = require("./config.js");
const { version: APP_VERSION } = require("./package.json");
const dataPoller = require("./dataPoller.js");
const courtPoller = require("./courtPoller.js");
const dataProvider = require("./dataProvider.js");
const dataStore = require("./dataStore.js");

// ── HTTP-Server ──

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health Check (kurz)
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      version: APP_VERSION,
      dataReady: dataStore.isReady(),
      court: courtPoller.getStatus(),
      provider: { clientCount: dataProvider.getStatus().clientCount },
      poller: { running: dataPoller.getStatus().running, tickCount: dataPoller.getStatus().tickCount },
    }));
    return;
  }

  // Version (nur Versionsnummer)
  if (req.url === "/version") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version: APP_VERSION }));
    return;
  }

  // Ausführlicher Status
  if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      dataReady: dataStore.isReady(),
      court: courtPoller.getStatus(),
      provider: dataProvider.getStatus(),
      poller: dataPoller.getStatus(),
    }));
    return;
  }

  // POST /set-active — Signal von Cloud Function
  if (req.url === "/set-active" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (data.courts) {
          courtPoller.setCourtActive(data.courts);
        }
        const status = courtPoller.getStatus();
        console.log(`set-active: Platz1=${status.courtActive["1"]}, Platz2=${status.courtActive["2"]}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, courtActive: status.courtActive, pollingActive: status.pollingActive }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ePiber Backend WebSocket Service running.");
});

// ── Start ──

async function startup() {
  console.log("═══════════════════════════════════════");
  console.log(`  ePiber-Backend v${APP_VERSION} startet...`);
  console.log("═══════════════════════════════════════");

  // 1. Spreadsheet-Daten initial laden
  await dataPoller.initialLoad();

  // 2. WebSocket-Provider initialisieren
  dataProvider.init(server);

  // 3. Daten-Polling starten
  dataPoller.start();

  // 4. Court-Status: bei Neustart sind beide Plätze inaktiv (In-Memory default)
  console.log("Court-Status: beide Plätze inaktiv (Neustart)");

  // 5. HTTP-Server starten
  server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
    console.log(`Health:  http://localhost:${PORT}/health`);
    console.log(`Status:  http://localhost:${PORT}/status`);
    console.log("═══════════════════════════════════════");
  });
}

startup();
