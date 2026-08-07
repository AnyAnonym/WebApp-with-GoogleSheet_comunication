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
