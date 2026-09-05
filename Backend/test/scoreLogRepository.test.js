const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTestEnvironment } = require("./helpers.js");

setTestEnvironment();
const { ScoreLogRepository } = require("../scoreLogRepository.js");

test("ScoreLog vergibt persistente Folgenummern pro Court und dedupliziert Event-IDs", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epiber-scorelog-"));
  const filename = path.join(directory, "scorelog.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let repository = new ScoreLogRepository(filename, { instanceId: "paj", now: () => 1000 });
  repository.init();
  const first = repository.append({
    eventId: "00000000-0000-4000-8000-000000000001", court: "1", score: "1-0/0-0/0-0/0-0", matchId: "m1", courtActive: true, courtRevision: 3,
  });
  const replay = repository.append({
    eventId: first.eventId, court: "1", score: first.score, matchId: "m1", courtActive: true, courtRevision: 3,
  });
  const otherCourt = repository.append({
    eventId: "00000000-0000-4000-8000-000000000002", court: "2", score: "2-0/0-0/0-0/0-0", matchId: "m2", courtActive: true, courtRevision: 4,
  });
  assert.equal(first.sequence, 1);
  assert.equal(replay.sequence, 1);
  assert.equal(otherCourt.sequence, 1);
  assert.equal(repository.list().length, 2);
  assert.throws(() => repository.append({
    eventId: first.eventId, court: "1", score: "9-9/0-0/0-0/0-0", matchId: "m1", courtActive: true, courtRevision: 3,
  }), { code: "SCORE_LOG_EVENT_CONFLICT" });
  repository.close();

  repository = new ScoreLogRepository(filename, { instanceId: "paj", now: () => 2000 });
  repository.init();
  const next = repository.append({
    eventId: "00000000-0000-4000-8000-000000000003", court: "1", score: "1-1/0-0/0-0/0-0", matchId: "m1", courtActive: true, courtRevision: 3,
  });
  assert.equal(next.sequence, 2);
  assert.equal(repository.status().lastSequenceByCourt["1"], 2);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  repository.close();
});

test("ScoreLog lehnt inaktive Courts und ungueltige Events ab", () => {
  const repository = new ScoreLogRepository(":memory:", { instanceId: "test" });
  repository.init();
  assert.throws(() => repository.append({ eventId: "bad", court: "1", score: "0", courtActive: true }), { code: "SCORE_LOG_EVENT_INVALID" });
  assert.throws(() => repository.append({ eventId: "00000000-0000-4000-8000-000000000004", court: "1", score: "0", courtActive: false }), { code: "SCORE_LOG_CONTEXT_INVALID" });
  repository.close();
});

test("ScoreLog findet nur den neuesten Eintrag fuer exakte Instanz, Match-ID und Court", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epiber-scorelog-latest-"));
  const filename = path.join(directory, "scorelog.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new ScoreLogRepository(filename, { instanceId: "paj", now: () => 1000 });
  repository.init();
  repository.append({
    eventId: "00000000-0000-4000-8000-000000000010", court: "1", score: "1-0", matchId: "match-1", courtActive: true,
  });
  const latest = repository.append({
    eventId: "00000000-0000-4000-8000-000000000011", court: "1", score: "2-0", matchId: "match-1", courtActive: true,
  });
  repository.append({
    eventId: "00000000-0000-4000-8000-000000000012", court: "1", score: "3-0", matchId: "match-10", courtActive: true,
  });
  repository.append({
    eventId: "00000000-0000-4000-8000-000000000013", court: "2", score: "4-0", matchId: "match-1", courtActive: true,
  });
  const otherInstance = new ScoreLogRepository(filename, { instanceId: "pk", now: () => 1000 });
  otherInstance.init();
  otherInstance.append({
    eventId: "00000000-0000-4000-8000-000000000014", court: "1", score: "5-0", matchId: "match-1", courtActive: true,
  });

  assert.deepEqual(repository.getLatestByMatchIdAndCourt("match-1", "1"), latest);
  assert.equal(repository.getLatestByMatchIdAndCourt("missing", "1"), null);
  assert.throws(() => repository.getLatestByMatchIdAndCourt("", "1"), { code: "SCORE_LOG_MATCH_ID_INVALID" });
  assert.throws(() => repository.getLatestByMatchIdAndCourt("x".repeat(65), "1"), { code: "SCORE_LOG_MATCH_ID_INVALID" });
  assert.throws(() => repository.getLatestByMatchIdAndCourt("match 1", "1"), { code: "SCORE_LOG_MATCH_ID_INVALID" });
  assert.throws(() => repository.getLatestByMatchIdAndCourt("match-1", "3"), { code: "SCORE_LOG_CONTEXT_INVALID" });
  assert.throws(() => repository.getLatestByMatchIdAndCourt("match-1", 1), { code: "SCORE_LOG_CONTEXT_INVALID" });

  const indexColumns = repository.db.prepare("PRAGMA index_xinfo('score_log_match_latest')").all()
    .filter((column) => Number(column.key) === 1)
    .map((column) => ({ name: column.name, desc: Number(column.desc) }));
  assert.deepEqual(indexColumns, [
    { name: "instance", desc: 0 },
    { name: "match_id", desc: 0 },
    { name: "court", desc: 0 },
    { name: "sequence", desc: 1 },
  ]);
  otherInstance.close();
  repository.close();
});

test("ScoreLog erholt sich nach einem transienten Statusprobefehler", () => {
  const repository = new ScoreLogRepository(":memory:", { instanceId: "test", now: () => 1000 });
  repository.init();
  const prepare = repository.db.prepare.bind(repository.db);
  let fail = true;
  repository.db.prepare = (sql) => {
    if (fail && sql.startsWith("SELECT court")) {
      fail = false;
      throw Object.assign(new Error("probe failed"), { code: "SQLITE_IOERR" });
    }
    return prepare(sql);
  };
  assert.equal(repository.status().ready, false);
  assert.equal(repository.status().ready, true);
  repository.close();
});
