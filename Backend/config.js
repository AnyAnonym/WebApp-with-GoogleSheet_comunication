// ══════════════════════════════════════════════════════
// ePiber-Backend-Konfiguration
// Umgebungsspezifische Werte werden aus Umgebungs-
// variablen gelesen (z.B. aus .env via systemd)
// ══════════════════════════════════════════════════════

// ── Spreadsheet ──
// Wird pro System (piber/paj/pk) über Umgebungsvariable gesetzt
const SHEET_ID = process.env.SHEET_ID;

// ── Court Scores (externe JSON-Ressource) ──
const COURT_URL = process.env.COURT_URL;
const COURT_POLL_INTERVAL = 2000;

// ── Server ──
const PORT = process.env.PORT || 8080;

// ── Daten-Polling (Spreadsheet) ──
const POLL_BASE_INTERVAL = 5000;    // Grundtakt: 5 Sekunden
const POLL_FAST_MULTIPLIER = 2;     // fast = alle 10 Sekunden (2 × Grundtakt)
const POLL_SLOW_MULTIPLIER = 6;     // slow = alle 30 Sekunden (6 × Grundtakt)

// Tabellen und ihre Polling-Kategorie
const TABLE_CONFIG = {
  players:       { range: "Personen",       category: "slow" },
  bewerbe:       { range: "Bewerb",         category: "slow" },
  bewerbsart:    { range: "Bewerbsart",     category: "slow" },
  matches1:      { range: "Matches1",       category: "fast" },
  matchTyp:      { range: "MatchTyp",        category: "slow" },
  rlPlatzierung: { range: "RL-Platzierung",  category: "fast" },
  navigator:     { range: "Navigator",       category: "slow" },
  entryList:     { range: "EntryList",       category: "fast" },
};

module.exports = {
  SHEET_ID,
  COURT_URL,
  COURT_POLL_INTERVAL,
  PORT,
  POLL_BASE_INTERVAL,
  POLL_FAST_MULTIPLIER,
  POLL_SLOW_MULTIPLIER,
  TABLE_CONFIG,
};
