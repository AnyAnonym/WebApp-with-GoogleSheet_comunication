const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const backendRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(backendRoot, "..");
const frontendRoot = path.join(projectRoot, "Frontend");
const failures = [];

function walk(directory, predicate) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".state")) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(filename, predicate));
    else if (predicate(filename)) result.push(filename);
  }
  return result;
}

for (const filename of [
  ...walk(backendRoot, (value) => value.endsWith(".js")),
  ...walk(path.join(frontendRoot, "JS"), (value) => value.endsWith(".js")),
]) {
  const result = spawnSync(process.execPath, ["--check", filename], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${path.relative(projectRoot, filename)}: ${result.stderr.trim()}`);
}

const frontendFiles = walk(frontendRoot, (value) => value.endsWith(".js") || value.endsWith(".html"));
const forbiddenPatterns = [
  [/ws:\/\/(?!localhost)/, "hart codierte ws://-URL"],
  [/createEndpoint\(["'](?:verifyUserLogin|resetPassword|setMatchDate|setPreMatchResult|getMyChallenges|roundRobin|bracket|scoreboard|matchTyp)["']\)/, "entfernter Endpoint"],
  [/localStorage\.(?:getItem|setItem|removeItem|clear)\([^\n]*(?:isLoggedIn|loggedInEmail|currentUserEmail|currentUserId|currentUserName|currentRank|currentBewerbId)/, "Auth-Daten in localStorage"],
  [/setInterval\([^\n]*,\s*150\s*\)/, "150-ms-Polling"],
  [/<script[^>]+SDK\.js/, "veralteter SDK-Scriptimport"],
  [/scorer-tennis\.b-cdn\.net/, "direkter Browserzugriff auf Court-Daten"],
  [/console\.(?:log|info|warn|error|debug)\([^)]*passwordHash/, "moegliches Passwort-Hash-Logging"],
];

for (const filename of frontendFiles) {
  const source = fs.readFileSync(filename, "utf8");
  for (const [pattern, label] of forbiddenPatterns) {
    if (pattern.test(source)) failures.push(`${path.relative(projectRoot, filename)}: ${label}`);
  }
}

for (const filename of walk(frontendRoot, (value) => value.endsWith(".html"))) {
  const source = fs.readFileSync(filename, "utf8");
  if (/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(source)) {
    failures.push(`${path.relative(projectRoot, filename)}: Inline-Script verhindert strikte CSP`);
  }
  if (/\son[a-z]+\s*=/i.test(source)) {
    failures.push(`${path.relative(projectRoot, filename)}: Inline-Eventhandler verhindert strikte CSP`);
  }
  const references = source.matchAll(/(?:src|href)=["']([^"'#?]+)["']/g);
  for (const match of references) {
    const target = match[1];
    if (/^(?:https?:|\/\/)/.test(target)) {
      failures.push(`${path.relative(projectRoot, filename)}: Externe Ressource ist durch die CSP gesperrt: ${target}`);
      continue;
    }
    if (/^(?:data:|mailto:)/.test(target)) continue;
    const absolute = target.startsWith("/")
      ? path.resolve(frontendRoot, target.slice(1))
      : path.resolve(path.dirname(filename), target);
    if (!fs.existsSync(absolute)) failures.push(`${path.relative(projectRoot, filename)}: Ressource fehlt: ${target}`);
  }
}

const manifestFilename = path.join(backendRoot, "package.json");
const lockFilename = path.join(backendRoot, "package-lock.json");
if (!fs.existsSync(lockFilename)) {
  failures.push("Backend/package-lock.json fehlt");
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestFilename, "utf8"));
  const lock = JSON.parse(fs.readFileSync(lockFilename, "utf8"));
  const lockedManifest = lock.packages?.[""] || {};
  if (lock.lockfileVersion !== 3 || JSON.stringify(lockedManifest.dependencies || {}) !== JSON.stringify(manifest.dependencies || {})) {
    failures.push("Backend/package-lock.json passt nicht zu package.json");
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Statische Pruefungen erfolgreich.");
