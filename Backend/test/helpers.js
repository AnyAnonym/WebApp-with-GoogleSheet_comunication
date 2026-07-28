function setTestEnvironment() {
  process.env.NODE_ENV = "test";
  process.env.INSTANCE_ID = "test";
  process.env.PORT = "18080";
  process.env.LISTEN_HOST = "127.0.0.1";
  process.env.PUBLIC_ORIGIN = "http://test.local";
  process.env.ALLOW_INSECURE_TRANSPORT = "true";
  process.env.STATE_FILE = ":memory:";
  process.env.SHEET_ID = "test-sheet";
  process.env.COURT_URL = "https://court.invalid/data.json";
}

function peopleFixture(role = "admin", storedHash = "a".repeat(64)) {
  return [
    ["ID", "Vorname", "Nachname", "E-Mail", "PasswdHash", "KennwortVergessen", "TelefonMobil", "Geschlecht", "Aktiv", "Role"],
    ["p1", "Ada", "Admin", "ada@example.test", storedHash, "", "+43123", "2", "1", role],
    ["p2", "Peter", "Player", "peter@example.test", "b".repeat(64), "", "+43456", "1", "1", "player"],
  ];
}

module.exports = { peopleFixture, setTestEnvironment };
