import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./version-workflow.mjs", import.meta.url));

function run(command, args, cwd, expectedStatus = 0) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return result;
}

function git(repo, ...args) {
  return run("git", args, repo).stdout.trim();
}

function workflow(repo, ...args) {
  return run(process.execPath, [script, ...args], repo);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createRepository({ remote = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "epiber-workflow-"));
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Workflow Test");
  git(repo, "config", "user.email", "workflow@example.invalid");

  writeJson(path.join(repo, "Backend/package.json"), { name: "fixture", version: "1.2.3" });
  writeJson(path.join(repo, "Backend/package-lock.json"), {
    name: "fixture",
    version: "1.2.3",
    lockfileVersion: 3,
    packages: { "": { name: "fixture", version: "1.2.3" } },
  });
  fs.mkdirSync(path.join(repo, "Project/ChangeLogs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "Project/ChangeLogs/ChangeLog-main.txt"), "[1.2.3] - 2026-08-01\nCommit: 1.2.3 | Initial\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "1.2.3 | Initial");

  if (remote) {
    const remotePath = path.join(base, "remote.git");
    run("git", ["init", "--bare", remotePath], base);
    git(repo, "remote", "add", "origin", remotePath);
    git(repo, "push", "-u", "origin", "main");
    run("git", ["symbolic-ref", "HEAD", "refs/heads/main"], remotePath);
  }

  return { base, repo };
}

function readVersion(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, "Backend/package.json"), "utf8")).version;
}

test("branch-start is a dry-run by default and creates the complete initial state with --apply", () => {
  const { base, repo } = createRepository();
  try {
    const dryRun = workflow(repo, "branch-start", "--system", "paj");
    assert.match(dryRun.stdout, /PLAN: Seitenbranch 1\.2\.3-paj-1 bestimmen/);
    assert.equal(git(repo, "branch", "--show-current"), "main");
    assert.equal(git(repo, "status", "--porcelain"), "");

    workflow(repo, "branch-start", "--system", "paj", "--apply");
    assert.equal(git(repo, "branch", "--show-current"), "1.2.3-paj-1");
    assert.equal(git(repo, "log", "-1", "--pretty=%s"), "1.2.3-paj-1-1 | Branch-Stand nummeriert initialisiert");
    assert.equal(readVersion(repo), "1.2.3-paj-1-1-x");
    const status = run("git", ["status", "--porcelain"], repo).stdout.trimEnd();
    assert.deepEqual(status.split("\n").sort(), [
      " M Backend/package-lock.json",
      " M Backend/package.json",
      " M Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt",
    ]);
    const log = fs.readFileSync(path.join(repo, "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt"), "utf8");
    assert.match(log, /Zielcommit: 1\.2\.3-paj-1-2\nStatus: uncommitted/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("branch-finalize and branch-commit enforce numbering and explicit paths", () => {
  const { base, repo } = createRepository();
  try {
    workflow(repo, "branch-start", "--system", "paj", "--apply");
    fs.writeFileSync(path.join(repo, "feature.txt"), "implemented\n");
    workflow(repo, "branch-finalize", "--subject", "Testfunktion umgesetzt", "--apply");
    assert.equal(readVersion(repo), "1.2.3-paj-1-2");
    workflow(repo, "branch-reopen", "--apply");
    assert.equal(readVersion(repo), "1.2.3-paj-1-1-x");
    assert.match(
      fs.readFileSync(path.join(repo, "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt"), "utf8"),
      /Zielcommit: 1\.2\.3-paj-1-2\nStatus: uncommitted/,
    );
    workflow(repo, "branch-finalize", "--subject", "Testfunktion umgesetzt", "--apply");

    git(repo, "add", "feature.txt");
    const preStaged = run(
      process.execPath,
      [
        script,
        "branch-commit",
        "--subject",
        "Testfunktion umgesetzt",
        "--path",
        "Backend/package.json",
        "--path",
        "Backend/package-lock.json",
        "--path",
        "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt",
        "--path",
        "feature.txt",
      ],
      repo,
      1,
    );
    assert.match(preStaged.stderr, /Bereits gestagte Dateien blockieren/);
    git(repo, "restore", "--staged", "feature.txt");

    fs.writeFileSync(path.join(repo, "bad.txt"), "trailing whitespace  \n");
    const badDiff = run(
      process.execPath,
      [
        script,
        "branch-commit",
        "--subject",
        "Testfunktion umgesetzt",
        "--path",
        "Backend/package.json",
        "--path",
        "Backend/package-lock.json",
        "--path",
        "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt",
        "--path",
        "feature.txt",
        "--path",
        "bad.txt",
        "--apply",
      ],
      repo,
      1,
    );
    assert.match(badDiff.stderr, /trailing whitespace/);
    assert.equal(git(repo, "diff", "--cached", "--name-only"), "");
    fs.rmSync(path.join(repo, "bad.txt"));

    const missingMandatory = run(
      process.execPath,
      [
        script,
        "branch-commit",
        "--subject",
        "Testfunktion umgesetzt",
        "--path",
        "Backend/package.json",
        "--path",
        "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt",
        "--path",
        "feature.txt",
        "--apply",
      ],
      repo,
      1,
    );
    assert.match(missingMandatory.stderr, /Verpflichtender Pfad ist nicht gestaged/);
    assert.equal(git(repo, "diff", "--cached", "--name-only"), "");

    workflow(
      repo,
      "branch-commit",
      "--subject",
      "Testfunktion umgesetzt",
      "--path",
      "Backend/package.json",
      "--path",
      "Backend/package-lock.json",
      "--path",
      "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt",
      "--path",
      "feature.txt",
      "--apply",
    );
    assert.equal(git(repo, "log", "-1", "--pretty=%s"), "1.2.3-paj-1-2 | Testfunktion umgesetzt");
    assert.equal(git(repo, "status", "--porcelain"), "");

    workflow(repo, "work-start", "--apply");
    assert.equal(readVersion(repo), "1.2.3-paj-1-2-x");
    assert.match(
      fs.readFileSync(path.join(repo, "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt"), "utf8"),
      /Zielcommit: 1\.2\.3-paj-1-3\nStatus: uncommitted/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("commit staging rejects potential secret files", () => {
  const { base, repo } = createRepository();
  try {
    workflow(repo, "branch-start", "--system", "paj", "--apply");
    fs.writeFileSync(path.join(repo, "Backend/.env"), "TOKEN=secret\n");
    workflow(repo, "branch-finalize", "--subject", "Unsicherer Test", "--apply");
    const result = run(
      process.execPath,
      [
        script,
        "branch-commit",
        "--subject",
        "Unsicherer Test",
        "--path",
        "Backend/.env",
        "--path",
        "Backend/package.json",
        "--path",
        "Backend/package-lock.json",
        "--path",
        "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt",
        "--apply",
      ],
      repo,
      1,
    );
    assert.match(result.stderr, /Potenzielles Geheimnis/);
    assert.equal(git(repo, "diff", "--cached", "--name-only"), "");
    fs.rmSync(path.join(repo, "Backend/.env"));
    fs.writeFileSync(path.join(repo, "notes.txt"), `api_${"token"} = "super-secret-value-1234567890"\n`);
    const contentResult = run(
      process.execPath,
      [
        script,
        "branch-commit",
        "--subject",
        "Unsicherer Test",
        "--path",
        "notes.txt",
        "--path",
        "Backend/package.json",
        "--path",
        "Backend/package-lock.json",
        "--path",
        "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt",
        "--apply",
      ],
      repo,
      1,
    );
    assert.match(contentResult.stderr, /Geheimnismuster/);
    assert.equal(git(repo, "diff", "--cached", "--name-only"), "");
    fs.rmSync(path.join(repo, "notes.txt"));
    fs.writeFileSync(path.join(repo, "asset.bin"), Buffer.from([0, 1, 2, 3, 255]));
    const binaryResult = run(
      process.execPath,
      [
        script,
        "branch-commit",
        "--subject",
        "Unsicherer Test",
        "--path",
        "asset.bin",
        "--path",
        "Backend/package.json",
        "--path",
        "Backend/package-lock.json",
        "--path",
        "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt",
        "--apply",
      ],
      repo,
      1,
    );
    assert.match(binaryResult.stderr, /Binaere Aenderungen/);
    assert.equal(git(repo, "diff", "--cached", "--name-only"), "");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("renames require explicit approval of old and new paths", () => {
  const { base, repo } = createRepository();
  try {
    fs.writeFileSync(path.join(repo, "old-name.txt"), "tracked\n");
    git(repo, "add", "old-name.txt");
    git(repo, "commit", "-m", "1.2.3 | Fixture-Datei angelegt");
    workflow(repo, "branch-start", "--system", "paj", "--apply");
    git(repo, "mv", "old-name.txt", "new-name.txt");
    git(repo, "restore", "--staged", "old-name.txt", "new-name.txt");
    workflow(repo, "branch-finalize", "--subject", "Datei umbenannt", "--apply");

    const incomplete = run(
      process.execPath,
      [
        script,
        "branch-commit",
        "--subject",
        "Datei umbenannt",
        "--path",
        "new-name.txt",
        "--path",
        "Backend/package.json",
        "--path",
        "Backend/package-lock.json",
        "--path",
        "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt",
      ],
      repo,
      1,
    );
    assert.match(incomplete.stderr, /Umbenennung muss mit altem und neuem Pfad/);
    assert.equal(git(repo, "diff", "--cached", "--name-only"), "");

    workflow(
      repo,
      "branch-commit",
      "--subject",
      "Datei umbenannt",
      "--path",
      "old-name.txt",
      "--path",
      "new-name.txt",
      "--path",
      "Backend/package.json",
      "--path",
      "Backend/package-lock.json",
      "--path",
      "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt",
      "--apply",
    );
    assert.equal(git(repo, "status", "--porcelain"), "");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("release workflow creates and verifies a real merge commit", () => {
  const { base, repo } = createRepository({ remote: true });
  try {
    const mainSha = git(repo, "rev-parse", "main");
    workflow(repo, "branch-start", "--system", "paj", "--apply");
    fs.writeFileSync(path.join(repo, "feature.txt"), "released\n");
    workflow(repo, "branch-finalize", "--subject", "Releasefunktion umgesetzt", "--apply");
    workflow(
      repo,
      "branch-commit",
      "--subject",
      "Releasefunktion umgesetzt",
      "--path",
      "Backend/package.json",
      "--path",
      "Backend/package-lock.json",
      "--path",
      "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt",
      "--path",
      "feature.txt",
      "--apply",
    );
    const branchSha = git(repo, "rev-parse", "HEAD");
    workflow(repo, "push", "--target", "branch", "--apply");
    const stale = run(
      process.execPath,
      [script, "release-open", "--branch", "1.2.3-paj-1", "--version", "1.3.0", "--main-sha", branchSha, "--branch-sha", branchSha],
      repo,
      1,
    );
    assert.match(stale.stderr, /Main-Stand hat sich/);
    run("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], repo, 1);
    workflow(
      repo,
      "release-open",
      "--branch",
      "1.2.3-paj-1",
      "--version",
      "1.3.0",
      "--main-sha",
      mainSha,
      "--branch-sha",
      branchSha,
      "--apply",
    );
    assert.ok(git(repo, "rev-parse", "MERGE_HEAD"));

    fs.appendFileSync(
      path.join(repo, "Project/ChangeLogs/ChangeLog-main.txt"),
      "\n[1.3.0] - 2026-08-29\nCommit: 1.3.0 | Releasefunktion umgesetzt\nQuelle: 1.2.3-paj-1\n",
    );
    fs.rmSync(path.join(repo, "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt"));
    const versionBeforeFailedRelease = readVersion(repo);
    const indexBeforeFailedRelease = git(repo, "diff", "--cached", "--name-only");
    fs.writeFileSync(path.join(repo, "bad.txt"), "trailing whitespace  \n");
    const failedRelease = run(
      process.execPath,
      [
        script,
        "release-commit",
        "--branch",
        "1.2.3-paj-1",
        "--version",
        "1.3.0",
        "--main-sha",
        mainSha,
        "--branch-sha",
        branchSha,
        "--subject",
        "Releasefunktion umgesetzt",
        "--path",
        "Backend/package.json",
        "--path",
        "Backend/package-lock.json",
        "--path",
        "Project/ChangeLogs/ChangeLog-main.txt",
        "--path",
        "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt",
        "--path",
        "feature.txt",
        "--path",
        "bad.txt",
        "--apply",
      ],
      repo,
      1,
    );
    assert.match(failedRelease.stderr, /trailing whitespace/);
    assert.equal(readVersion(repo), versionBeforeFailedRelease);
    assert.equal(git(repo, "diff", "--cached", "--name-only"), indexBeforeFailedRelease);
    fs.rmSync(path.join(repo, "bad.txt"));
    const wrongMerge = run(
      process.execPath,
      [
        script,
        "release-commit",
        "--branch",
        "1.2.3-paj-1",
        "--version",
        "1.3.0",
        "--main-sha",
        mainSha,
        "--branch-sha",
        mainSha,
        "--subject",
        "Releasefunktion umgesetzt",
        "--path",
        "Backend/package.json",
      ],
      repo,
      1,
    );
    assert.match(wrongMerge.stderr, /MERGE_HEAD entspricht nicht/);
    workflow(
      repo,
      "release-commit",
      "--branch",
      "1.2.3-paj-1",
      "--version",
      "1.3.0",
      "--main-sha",
      mainSha,
      "--branch-sha",
      branchSha,
      "--subject",
      "Releasefunktion umgesetzt",
      "--path",
      "Backend/package.json",
      "--path",
      "Backend/package-lock.json",
      "--path",
      "Project/ChangeLogs/ChangeLog-main.txt",
      "--path",
      "Project/ChangeLogs/ChangeLog-1.2.3-paj-1.txt",
      "--path",
      "feature.txt",
      "--apply",
    );
    assert.equal(readVersion(repo), "1.3.0");
    assert.equal(git(repo, "show", "--no-patch", "--pretty=%s", "HEAD"), "1.3.0 | Releasefunktion umgesetzt");
    assert.equal(git(repo, "show", "--no-patch", "--pretty=%P", "HEAD").split(" ").length, 2);
    workflow(repo, "push", "--target", "main", "--apply");
    assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
