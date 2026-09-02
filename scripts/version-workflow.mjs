#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const BRANCH_RE = /^(\d+\.\d+\.\d+)-(paj|pk)-(\d+)$/;
const SECRET_RE = /(^|\/)(\.env(?:\.[^/]*)?|[^/]*service[-_.]?account[^/]*\.json|[^/]*private[^/]*key[^/]*|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx))$/i;
const SECRET_CONTENT_RES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"private_key"\s*:\s*"-----BEGIN/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\b(?:password|passwd|token|secret|client[_-]?secret|api[_-]?(?:key|token)|session[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{20,}/i,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { apply: false, json: false, paths: [], binaryPaths: [] };

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--path") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) fail("--path benoetigt einen Wert");
      options.paths.push(value);
      index += 1;
    } else if (argument === "--binary-path") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) fail("--binary-path benoetigt einen Wert");
      options.binaryPaths.push(value);
      index += 1;
    } else if (["--system", "--subject", "--branch", "--version", "--target", "--main-sha", "--branch-sha"].includes(argument)) {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) fail(`${argument} benoetigt einen Wert`);
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      fail(`Unbekanntes Argument: ${argument}`);
    }
  }

  return { command, options };
}

function run(command, args, { cwd, allowFailure = false, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || `${command} fehlgeschlagen`).trim();
    fail(detail);
  }
  return result;
}

function discoverRoot() {
  return run("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() }).stdout.trim();
}

const { command, options } = parseArgs(process.argv.slice(2));
const root = discoverRoot();

function git(args, settings = {}) {
  return run("git", args, { cwd: root, ...settings });
}

function gitText(args) {
  return git(args).stdout.trim();
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function packagePaths() {
  return {
    packageFile: path.join(root, "Backend/package.json"),
    lockFile: path.join(root, "Backend/package-lock.json"),
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function versions() {
  const { packageFile, lockFile } = packagePaths();
  const packageJson = readJson(packageFile);
  const packageLock = readJson(lockFile);
  return {
    packageVersion: packageJson.version,
    lockVersion: packageLock.version,
    lockRootVersion: packageLock.packages?.[""]?.version,
  };
}

function assertSynchronizedVersions(expected) {
  const current = versions();
  if (current.packageVersion !== current.lockVersion || current.packageVersion !== current.lockRootVersion) {
    fail(`Paketversionen sind nicht synchron: ${JSON.stringify(current)}`);
  }
  if (expected && current.packageVersion !== expected) {
    fail(`Erwartete Version ${expected}, gefunden ${current.packageVersion}`);
  }
  return current.packageVersion;
}

function setVersions(version) {
  const { packageFile, lockFile } = packagePaths();
  const packageJson = readJson(packageFile);
  const packageLock = readJson(lockFile);
  packageJson.version = version;
  packageLock.version = version;
  if (!packageLock.packages?.[""]) fail("Root-Paket fehlt in Backend/package-lock.json");
  packageLock.packages[""].version = version;
  writeJson(packageFile, packageJson);
  writeJson(lockFile, packageLock);
}

function currentBranch() {
  return gitText(["branch", "--show-current"]);
}

function statusPaths(mode = "all") {
  const args = mode === "staged"
    ? ["diff", "--cached", "--name-only", "-z"]
    : ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  const output = git(args).stdout;
  if (mode === "staged") return output.split("\0").filter(Boolean);
  const records = output.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    paths.push(record.slice(3));
    if (record[0] === "R" || record[0] === "C" || record[1] === "R" || record[1] === "C") {
      index += 1;
      if (records[index]) paths.push(records[index]);
    }
  }
  return [...new Set(paths)];
}

function assertClean() {
  const status = gitText(["status", "--porcelain=v1"]);
  if (status) fail("Arbeitsbaum ist nicht sauber");
}

function mergeHead() {
  return git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowFailure: true }).stdout.trim() || null;
}

function unmergedPaths() {
  return gitText(["diff", "--name-only", "--diff-filter=U"]);
}

function assertNoMergeState() {
  if (mergeHead()) fail("Unerwarteter offener Merge blockiert diese Branch-Aktion");
  if (unmergedPaths()) fail("Ungeloeste Konflikte blockieren diese Aktion");
}

function assertSideBranch(branch = currentBranch()) {
  const match = branch.match(BRANCH_RE);
  if (!match) fail(`Kein gueltiger Seitenbranch: ${branch || "detached HEAD"}`);
  return { branch, baseVersion: match[1], system: match[2], branchId: Number(match[3]) };
}

function headIdentity(branch = currentBranch()) {
  const subject = gitText(["log", "-1", "--pretty=%s"]);
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = subject.match(new RegExp(`^(${escaped}-(\\d+)) \\| (.+)$`));
  if (!match) fail(`HEAD-Betreff entspricht nicht dem Branchformat: ${subject}`);
  return { id: match[1], number: Number(match[2]), subject: match[3], fullSubject: subject };
}

function changelogPath(branch) {
  return path.join(root, `Project/ChangeLogs/ChangeLog-${branch}.txt`);
}

function today() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function plan(lines) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ command, apply: options.apply, actions: lines }, null, 2)}\n`);
  } else {
    for (const line of lines) process.stdout.write(`${options.apply ? "OK" : "PLAN"}: ${line}\n`);
    if (!options.apply && command !== "inspect") {
      process.stdout.write("Dry-Run: Fuer Aenderungen denselben Aufruf mit --apply ausfuehren.\n");
    }
  }
}

function inspect() {
  const branch = currentBranch();
  const data = {
    root,
    branch: branch || null,
    head: gitText(["rev-parse", "HEAD"]),
    subject: gitText(["log", "-1", "--pretty=%s"]),
    versions: versions(),
    changedPaths: statusPaths(),
    mergeHead: mergeHead(),
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    process.stdout.write(`Branch: ${data.branch ?? "detached HEAD"}\n`);
    process.stdout.write(`HEAD: ${data.head} ${data.subject}\n`);
    process.stdout.write(`Version: ${data.versions.packageVersion}\n`);
    process.stdout.write(`Arbeitsbaum: ${data.changedPaths.length ? `${data.changedPaths.length} geaenderte Pfade` : "sauber"}\n`);
    process.stdout.write(`Merge: ${data.mergeHead ?? "keiner"}\n`);
  }
}

function usedBranchIds(baseVersion, system) {
  const prefix = `${baseVersion}-${system}-`;
  const sources = [
    gitText(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]),
    gitText(["log", "--all", "--format=%D%n%s"]),
  ];
  const mainLog = path.join(root, "Project/ChangeLogs/ChangeLog-main.txt");
  if (fs.existsSync(mainLog)) sources.push(fs.readFileSync(mainLog, "utf8"));
  const ids = new Set();
  const expression = new RegExp(`${prefix.replace(/\./g, "\\.")}(\\d+)`, "g");
  for (const source of sources) {
    for (const match of source.matchAll(expression)) ids.add(Number(match[1]));
  }
  return ids;
}

function initialChangelog(branch, initialId) {
  return `[${initialId}] - ${today()}\nCommit: ${initialId} | Branch-Stand nummeriert initialisiert\n\n  Added\n  - [Dokumentation] Temporaeres Branch-Changelog fuer den Seitenbranch \`${branch}\` angelegt.\n\n  Changed\n  - [Repository] Paketversion in \`Backend/package.json\` und \`Backend/package-lock.json\` auf \`${initialId}\` gesetzt.\n`;
}

function openSection(currentId, targetId) {
  return `\n[${currentId}-x] - In Arbeit seit ${today()}\nZielcommit: ${targetId}\nStatus: uncommitted\n\n  Changed\n  - [Repository] Paketversion in \`Backend/package.json\` und \`Backend/package-lock.json\` auf \`${currentId}-x\` gesetzt.\n`;
}

function branchStart() {
  if (!options.system || !["paj", "pk"].includes(options.system)) fail("--system muss paj oder pk sein");
  if (currentBranch() !== "main") fail("branch-start ist nur auf main zulaessig");
  assertNoMergeState();
  assertClean();
  const baseVersion = assertSynchronizedVersions();
  if (!SEMVER_RE.test(baseVersion)) fail(`Main-Paketversion ist keine SemVer-Version: ${baseVersion}`);
  const mainSubject = gitText(["log", "-1", "--pretty=%s"]);
  if (!mainSubject.startsWith(`${baseVersion} | `)) fail("Main-Version und letzter Commit-Betreff stimmen nicht ueberein");
  const used = usedBranchIds(baseVersion, options.system);
  let branchId = 1;
  while (used.has(branchId)) branchId += 1;
  const branch = `${baseVersion}-${options.system}-${branchId}`;
  const initialId = `${branch}-1`;

  if (options.apply) {
    git(["switch", "-c", branch]);
    setVersions(initialId);
    fs.writeFileSync(changelogPath(branch), initialChangelog(branch, initialId));
    git(["add", "--", "Backend/package.json", "Backend/package-lock.json", relative(changelogPath(branch))]);
    git(["diff", "--cached", "--check"]);
    git(["commit", "-m", `${initialId} | Branch-Stand nummeriert initialisiert`]);
    setVersions(`${initialId}-x`);
    fs.appendFileSync(changelogPath(branch), openSection(initialId, `${branch}-2`));
  }

  plan([
    `Seitenbranch ${branch} bestimmen`,
    `Initialstand ${initialId} in Paketdateien und Branch-Changelog anlegen`,
    `Initialcommit ${initialId} | Branch-Stand nummeriert initialisiert erstellen`,
    `Uncommittierten Arbeitsstand ${initialId}-x mit Zielcommit ${branch}-2 anlegen`,
  ]);
}

function workStart() {
  const { branch } = assertSideBranch();
  assertNoMergeState();
  assertClean();
  const head = headIdentity(branch);
  assertSynchronizedVersions(head.id);
  const logFile = changelogPath(branch);
  if (!fs.existsSync(logFile)) fail(`Branch-Changelog fehlt: ${relative(logFile)}`);
  const content = fs.readFileSync(logFile, "utf8");
  if (content.includes("Status: uncommitted")) fail("Branch-Changelog enthaelt bereits einen offenen Abschnitt");
  const targetId = `${branch}-${head.number + 1}`;

  if (options.apply) {
    setVersions(`${head.id}-x`);
    fs.appendFileSync(logFile, openSection(head.id, targetId));
  }
  plan([`Paketversionen auf ${head.id}-x setzen`, `Offenen Changelogabschnitt mit Zielcommit ${targetId} anlegen`]);
}

function requireSubject() {
  const subject = options.subject?.trim();
  if (!subject || subject.includes("\n") || subject.includes("|")) {
    fail("--subject muss ein einzeiliger Kurzkommentar ohne | sein");
  }
  return subject;
}

function branchFinalize() {
  const { branch } = assertSideBranch();
  assertNoMergeState();
  const subject = requireSubject();
  const head = headIdentity(branch);
  assertSynchronizedVersions(`${head.id}-x`);
  const targetId = `${branch}-${head.number + 1}`;
  const logFile = changelogPath(branch);
  const content = fs.readFileSync(logFile, "utf8");
  const marker = `[${head.id}-x] - In Arbeit seit `;
  if (!content.includes(marker) || !content.includes(`Zielcommit: ${targetId}\nStatus: uncommitted`)) {
    fail("Offener Branch-Changelogabschnitt passt nicht zum aktuellen Entwicklungsstand");
  }

  if (options.apply) {
    const escapedId = head.id.replace(/\./g, "\\.");
    const expression = new RegExp(`\\[${escapedId}-x\\] - In Arbeit seit [^\\n]+\\nZielcommit: ${targetId.replace(/\./g, "\\.")}\\nStatus: uncommitted\\n`);
    const finalized = content.replace(expression, `[${targetId}] - ${today()}\nCommit: ${targetId} | ${subject}\n`);
    if (finalized === content) fail("Branch-Changelog konnte nicht finalisiert werden");
    fs.writeFileSync(logFile, finalized);
    setVersions(targetId);
  }
  plan([`Paketversionen auf ${targetId} finalisieren`, `Changelogabschnitt als ${targetId} | ${subject} finalisieren`]);
}

function branchReopen() {
  const { branch } = assertSideBranch();
  assertNoMergeState();
  const head = headIdentity(branch);
  const targetId = `${branch}-${head.number + 1}`;
  assertSynchronizedVersions(targetId);
  const logFile = changelogPath(branch);
  const content = fs.readFileSync(logFile, "utf8");
  const escapedTarget = targetId.replace(/\./g, "\\.");
  const expression = new RegExp(`\\[${escapedTarget}\\] - [^\\n]+\\nCommit: ${escapedTarget} \\| [^\\n]+\\n`);
  if (!expression.test(content)) fail("Finalisierter Branch-Changelogabschnitt passt nicht zum erwarteten Zielcommit");

  if (options.apply) {
    const reopened = content.replace(
      expression,
      `[${head.id}-x] - In Arbeit seit ${today()}\nZielcommit: ${targetId}\nStatus: uncommitted\n`,
    );
    fs.writeFileSync(logFile, reopened);
    setVersions(`${head.id}-x`);
  }
  plan([`Paketversionen auf ${head.id}-x zurueckstellen`, `Changelogabschnitt fuer Zielcommit ${targetId} wieder oeffnen`]);
}

function normalizeAllowedPaths() {
  if (!options.paths.length) fail("Mindestens ein --path ist erforderlich");
  return options.paths.map((entry) => {
    const absolute = path.resolve(root, entry);
    const normalized = relative(absolute);
    if (normalized.startsWith("../") || normalized === "..") fail(`Pfad liegt ausserhalb des Repositorys: ${entry}`);
    if (!normalized || normalized === ".") fail("Repository-Root ist kein zulaessiger --path");
    if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
      fail(`--path muss eine einzelne Datei bezeichnen, kein Verzeichnis: ${entry}`);
    }
    return normalized.replace(/\/$/, "");
  });
}

function isAllowed(file, allowed) {
  return allowed.includes(file);
}

function assertNoSecrets(files) {
  const matchedFile = files.find((file) => SECRET_RE.test(file) && path.basename(file) !== ".env.example");
  if (matchedFile) fail(`Potenzielles Geheimnis darf nicht gestaged werden: ${matchedFile}`);
}

function assertNoSecretContent(indexFile, approvedBinaries) {
  const numstat = run("git", ["diff", "--cached", "--numstat", "--no-renames"], {
    cwd: root,
    env: { ...process.env, GIT_INDEX_FILE: indexFile },
  }).stdout;
  const binaries = numstat.split("\n").flatMap((line) => {
    const match = line.match(/^-\t-\t(.+)$/);
    return match ? [match[1]] : [];
  });
  const unapproved = binaries.find((file) => !approvedBinaries.includes(file));
  if (unapproved) fail(`Binaere Aenderung benoetigt --binary-path: ${unapproved}`);
  const unnecessaryApproval = approvedBinaries.find((file) => !binaries.includes(file));
  if (unnecessaryApproval) fail(`--binary-path bezeichnet keine binaere Aenderung: ${unnecessaryApproval}`);
  const diff = run("git", ["diff", "--cached", "--no-ext-diff", "--unified=0", "--no-color"], {
    cwd: root,
    env: { ...process.env, GIT_INDEX_FILE: indexFile },
  }).stdout;
  const textDiff = diff.replace(/^Binary files .* differ\n?/gm, "");
  const matchedPattern = SECRET_CONTENT_RES.find((expression) => expression.test(textDiff));
  if (matchedPattern) fail(`Gestagter Inhalt entspricht einem Geheimnismuster: ${matchedPattern}`);
}

function parseRenamePairs(output) {
  const fields = output.split("\0").filter(Boolean);
  const pairs = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[index + 1];
      const to = fields[index + 2];
      if (from && to) pairs.push([from, to]);
      index += 2;
    } else {
      index += 1;
    }
  }
  return pairs;
}

function assertRenamePairsAllowed(output, allowed) {
  for (const [from, to] of parseRenamePairs(output)) {
    if (!allowed.includes(from) || !allowed.includes(to)) {
      fail(`Umbenennung muss mit altem und neuem Pfad freigegeben sein: ${from} -> ${to}`);
    }
  }
}

function stageAllowed(allowed, { rejectPreStaged = false, mandatory = [] } = {}) {
  const approvedBinaries = options.binaryPaths.map((entry) => relative(path.resolve(root, entry)));
  const binaryOutsideAllowed = approvedBinaries.find((file) => !allowed.includes(file));
  if (binaryOutsideAllowed) fail(`--binary-path muss auch mit --path freigegeben sein: ${binaryOutsideAllowed}`);
  const preStaged = statusPaths("staged");
  if (rejectPreStaged && preStaged.length) {
    fail(`Bereits gestagte Dateien blockieren den Branch-Commit: ${preStaged.join(", ")}`);
  }
  const unexpected = preStaged.find((file) => !isAllowed(file, allowed));
  if (unexpected) fail(`Bereits gestagter Pfad ist nicht freigegeben: ${unexpected}`);
  assertNoSecrets(allowed);
  const candidates = statusPaths().filter((file) => isAllowed(file, allowed));
  assertNoSecrets(candidates);
  const gitDirectory = path.resolve(root, gitText(["rev-parse", "--git-dir"]));
  const realIndex = path.join(gitDirectory, "index");
  const temporaryIndex = path.join(gitDirectory, `index.version-workflow-${process.pid}`);
  const temporaryGit = (args) => run("git", args, {
    cwd: root,
    env: { ...process.env, GIT_INDEX_FILE: temporaryIndex },
  });

  try {
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, temporaryIndex);
    const deletedPaths = git(["diff", "--name-only", "--diff-filter=D", "-z"]).stdout.split("\0").filter(Boolean);
    if (deletedPaths.length) {
      temporaryGit(["add", "-A", "--", ...new Set([...allowed, ...deletedPaths])]);
      const analysisRenames = temporaryGit(["diff", "--cached", "--name-status", "-z", "-M"]).stdout;
      assertRenamePairsAllowed(analysisRenames, allowed);
      fs.copyFileSync(realIndex, temporaryIndex);
    }
    temporaryGit(["add", "-A", "--", ...allowed]);
    const staged = temporaryGit(["diff", "--cached", "--name-only", "-z"]).stdout.split("\0").filter(Boolean);
    if (!staged.length) fail("Keine Aenderungen zum Committen gestaged");
    const outside = staged.find((file) => !isAllowed(file, allowed));
    if (outside) fail(`Gestagter Pfad ist nicht freigegeben: ${outside}`);
    const renameOutput = temporaryGit(["diff", "--cached", "--name-status", "-z", "-M"]).stdout;
    assertRenamePairsAllowed(renameOutput, allowed);
    assertNoSecrets(staged);
    temporaryGit(["diff", "--cached", "--check"]);
    assertNoSecretContent(temporaryIndex, approvedBinaries);
    assertMandatoryStaged(staged, mandatory);
    if (options.apply) fs.copyFileSync(temporaryIndex, realIndex);
    return staged;
  } finally {
    fs.rmSync(temporaryIndex, { force: true });
  }
}

function assertMandatoryStaged(staged, mandatory) {
  const missing = mandatory.find((file) => !staged.includes(file));
  if (missing) fail(`Verpflichtender Pfad ist nicht gestaged: ${missing}`);
}

function branchCommit() {
  const { branch } = assertSideBranch();
  assertNoMergeState();
  const subject = requireSubject();
  const allowed = normalizeAllowedPaths();
  const head = headIdentity(branch);
  const targetId = `${branch}-${head.number + 1}`;
  assertSynchronizedVersions(targetId);
  const logPath = relative(changelogPath(branch));
  const log = fs.readFileSync(changelogPath(branch), "utf8");
  if (!log.includes(`[${targetId}]`) || !log.includes(`Commit: ${targetId} | ${subject}`) || log.includes("Status: uncommitted")) {
    fail("Branch-Changelog ist nicht passend finalisiert");
  }

  stageAllowed(allowed, {
    rejectPreStaged: true,
    mandatory: ["Backend/package.json", "Backend/package-lock.json", logPath],
  });
  if (options.apply) {
    git(["commit", "-m", `${targetId} | ${subject}`]);
    const created = headIdentity(branch);
    if (created.id !== targetId) fail("Erstellter Branch-Commit hat eine unerwartete Commit-ID");
  }
  plan([`Nur freigegebene Pfade stagen: ${allowed.join(", ")}`, `Branch-Commit ${targetId} | ${subject} erstellen`]);
}

function requireReleaseOptions() {
  const branch = options.branch;
  const version = options.version;
  if (!branch || !BRANCH_RE.test(branch)) fail("--branch muss ein gueltiger Seitenbranch sein");
  if (!version || !SEMVER_RE.test(version)) fail("--version muss eine konkrete SemVer-Version sein");
  if (!options["main-sha"] || !/^[0-9a-f]{40}$/.test(options["main-sha"])) fail("--main-sha muss ein vollstaendiger Git-SHA sein");
  if (!options["branch-sha"] || !/^[0-9a-f]{40}$/.test(options["branch-sha"])) fail("--branch-sha muss ein vollstaendiger Git-SHA sein");
  return { branch, version, mainSha: options["main-sha"], branchSha: options["branch-sha"] };
}

function compareSemver(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function versionAt(ref) {
  const content = gitText(["show", `${ref}:Backend/package.json`]);
  return JSON.parse(content).version;
}

function assertReleaseRefs({ branch, version, mainSha, branchSha }) {
  const refs = {
    main: gitText(["rev-parse", "main"]),
    remoteMain: gitText(["rev-parse", "origin/main"]),
    branch: gitText(["rev-parse", branch]),
    remoteBranch: gitText(["rev-parse", `origin/${branch}`]),
  };
  if (refs.main !== mainSha || refs.remoteMain !== mainSha) {
    fail(`Main-Stand hat sich seit der Versionsbestaetigung geaendert: ${JSON.stringify(refs)}`);
  }
  if (refs.branch !== branchSha || refs.remoteBranch !== branchSha) {
    fail(`Branch-Stand hat sich seit der Versionsbestaetigung geaendert: ${JSON.stringify(refs)}`);
  }
  const mainVersion = versionAt(mainSha);
  if (!SEMVER_RE.test(mainVersion) || compareSemver(version, mainVersion) <= 0) {
    fail(`Zielversion ${version} muss groesser als Main-Version ${mainVersion} sein`);
  }
  const branchVersion = versionAt(branchSha);
  const branchSubject = gitText(["show", "--no-patch", "--pretty=%s", branchSha]);
  const escapedBranch = branch.replace(/\./g, "\\.");
  if (!new RegExp(`^${escapedBranch}-\\d+$`).test(branchVersion) || !branchSubject.startsWith(`${branchVersion} | `)) {
    fail("Branch-Paketversion und Branch-Commit-Betreff stimmen nicht ueberein");
  }
}

function releaseOpen() {
  const release = requireReleaseOptions();
  const { branch, version, mainSha, branchSha } = release;
  assertClean();
  assertNoMergeState();

  if (options.apply) {
    git(["fetch", "origin"]);
    assertReleaseRefs(release);
    git(["switch", "main"]);
    if (gitText(["rev-parse", "HEAD"]) !== mainSha) fail("main entspricht nicht dem bestaetigten Main-SHA");
    const merge = git(["merge", "--no-ff", "--no-commit", branch], { allowFailure: true });
    if (merge.status !== 0) {
      git(["merge", "--abort"], { allowFailure: true });
      fail(`Merge wurde wegen Konflikt oder Fehler abgebrochen: ${(merge.stderr || merge.stdout).trim()}`);
    }
    if (gitText(["rev-parse", "MERGE_HEAD"]) !== branchSha) fail("MERGE_HEAD entspricht nicht dem bestaetigten Branch-SHA");
  } else {
    assertReleaseRefs(release);
  }
  plan([
    `Remote-Referenzen fuer main und ${branch} aktualisieren`,
    `Main-SHA ${mainSha} und Branch-SHA ${branchSha} exakt gegen die Versionsbestaetigung pruefen`,
    `Merge fuer bestaetigte Version ${version} mit --no-ff --no-commit oeffnen`,
  ]);
}

function releaseCommit() {
  const { branch, version, mainSha, branchSha } = requireReleaseOptions();
  const subject = requireSubject();
  const allowed = normalizeAllowedPaths();
  if (currentBranch() !== "main") fail("release-commit ist nur auf main zulaessig");
  if (gitText(["rev-parse", "MERGE_HEAD"]) !== branchSha) fail("MERGE_HEAD entspricht nicht dem bestaetigten Branch-SHA");
  if (gitText(["rev-parse", "HEAD"]) !== mainSha) fail("Erster Merge-Elternstand entspricht nicht dem bestaetigten Main-SHA");
  if (unmergedPaths()) fail("Ungeloeste Konflikte blockieren den Release-Commit");
  const mainLogPath = path.join(root, "Project/ChangeLogs/ChangeLog-main.txt");
  const branchLogPath = changelogPath(branch);
  const mainLog = fs.readFileSync(mainLogPath, "utf8");
  if (!mainLog.includes(`[${version}]`) || !mainLog.includes(`Quelle: ${branch}`)) {
    fail("Main-Changelog enthaelt Version und Quelle nicht vollstaendig");
  }
  if (fs.existsSync(branchLogPath)) fail("Temporaeres Branch-Changelog wurde noch nicht entfernt");
  assertSynchronizedVersions();

  let originalPackage;
  let originalLock;
  if (options.apply) {
    const { packageFile, lockFile } = packagePaths();
    originalPackage = fs.readFileSync(packageFile);
    originalLock = fs.readFileSync(lockFile);
  }
  let staged;
  try {
    if (options.apply) setVersions(version);
    staged = stageAllowed(allowed, {
      mandatory: ["Backend/package.json", "Backend/package-lock.json", "Project/ChangeLogs/ChangeLog-main.txt"],
    });
  } catch (error) {
    if (options.apply) {
      const { packageFile, lockFile } = packagePaths();
      fs.writeFileSync(packageFile, originalPackage);
      fs.writeFileSync(lockFile, originalLock);
    }
    throw error;
  }
  if (options.apply) {
    git(["commit", "-m", `${version} | ${subject}`]);
    const parents = gitText(["show", "--no-patch", "--pretty=%P", "HEAD"]).split(/\s+/).filter(Boolean);
    if (parents.length !== 2) fail("Erstellter Release-Commit besitzt nicht genau zwei Eltern");
    assertSynchronizedVersions(version);
    const createdSubject = gitText(["show", "--no-patch", "--pretty=%s", "HEAD"]);
    if (createdSubject !== `${version} | ${subject}`) fail("Release-Commit-Betreff ist inkonsistent");
  }
  plan([`Paketversionen auf ${version} setzen`, `Nur freigegebene Pfade stagen: ${allowed.join(", ")}`, `Merge-Commit ${version} | ${subject} erstellen und Zwei-Eltern-Vertrag pruefen`]);
}

function push() {
  if (!options.target || !["branch", "main"].includes(options.target)) fail("--target muss branch oder main sein");
  assertClean();
  const branch = currentBranch();
  if (options.target === "main" && branch !== "main") fail("--target main erfordert den Branch main");
  if (options.target === "branch") {
    const side = assertSideBranch(branch);
    const head = headIdentity(side.branch);
    assertSynchronizedVersions(head.id);
  } else {
    const version = assertSynchronizedVersions();
    const subject = gitText(["log", "-1", "--pretty=%s"]);
    if (!subject.startsWith(`${version} | `)) fail("Main-Version und Commit-Betreff stimmen nicht ueberein");
  }

  if (options.apply) {
    git(["push", "-u", "origin", branch]);
    const local = gitText(["rev-parse", "HEAD"]);
    const remoteLine = gitText(["ls-remote", "origin", `refs/heads/${branch}`]);
    const remote = remoteLine.split(/\s+/)[0];
    if (local !== remote) fail("Remote-Stand stimmt nach Push nicht mit HEAD ueberein");
  }
  plan([`${branch} nach origin pushen`, "Remote-SHA gegen lokales HEAD verifizieren"]);
}

const commands = {
  inspect,
  "branch-start": branchStart,
  "work-start": workStart,
  "branch-finalize": branchFinalize,
  "branch-reopen": branchReopen,
  "branch-commit": branchCommit,
  "release-open": releaseOpen,
  "release-commit": releaseCommit,
  push,
};

try {
  if (!command || !commands[command]) {
    fail(`Aktion fehlt oder ist unbekannt. Erlaubt: ${Object.keys(commands).join(", ")}`);
  }
  commands[command]();
} catch (error) {
  process.stderr.write(`FEHLER: ${error.message}\n`);
  process.exitCode = 1;
}
