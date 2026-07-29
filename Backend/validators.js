const crypto = require("crypto");
const { AppError } = require("./errors.js");

function requireObject(value, name = "params") {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new AppError("VALIDATION_ERROR", `${name} muss ein Objekt sein`);
  }
  return value;
}

function stringValue(value, name, { min = 1, max = 256, pattern, optional = false } = {}) {
  if ((value === undefined || value === null || value === "") && optional) return "";
  if (typeof value !== "string") throw new AppError("VALIDATION_ERROR", `${name} muss Text sein`);
  const result = value.trim();
  if (result.length < min || result.length > max) {
    throw new AppError("VALIDATION_ERROR", `${name} muss ${min} bis ${max} Zeichen enthalten`);
  }
  if (pattern && !pattern.test(result)) throw new AppError("VALIDATION_ERROR", `${name} hat ein ungueltiges Format`);
  return result;
}

function idValue(value, name = "id") {
  return stringValue(value, name, { max: 64, pattern: /^[A-Za-z0-9_.:-]+$/ });
}

function operationId(value) {
  const result = stringValue(value, "operationId", { max: 64 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new AppError("VALIDATION_ERROR", "operationId muss eine UUID sein");
  }
  return result;
}

function booleanValue(value, name) {
  if (typeof value !== "boolean") throw new AppError("VALIDATION_ERROR", `${name} muss boolean sein`);
  return value;
}

function integerValue(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AppError("VALIDATION_ERROR", `${name} muss eine Ganzzahl zwischen ${min} und ${max} sein`);
  }
  return value;
}

function emailValue(value) {
  const email = stringValue(value, "email", { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError("VALIDATION_ERROR", "E-Mail-Adresse ist ungueltig");
  }
  return email;
}

function passwordHashValue(value, name = "passwordHash") {
  return stringValue(value, name, { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/i }).toLowerCase();
}

function roleValue(value) {
  const role = String(value || "player").trim().toLowerCase();
  if (!["player", "operator", "admin"].includes(role)) return "player";
  return role;
}

function safePublicUser(user) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
  };
}

function getCompetitionIds(dataStore) {
  const values = dataStore.get("bewerbe");
  if (!Array.isArray(values) || values.length < 2) return new Set();
  const header = values[0].map((value) => String(value || "").trim().toLowerCase());
  const idIndex = header.indexOf("id");
  if (idIndex < 0) return new Set();
  return new Set(values.slice(1).map((row) => String(row[idIndex] || "").trim()).filter(Boolean));
}

function canonicalizeMonitorPath(rawPath, dataStore) {
  const raw = stringValue(rawPath, "path", { max: 512 });
  if (/[\x00-\x1f\\#]/.test(raw) || raw.startsWith("//")) {
    throw new AppError("TARGET_FORBIDDEN", "Monitorziel enthaelt ungueltige Zeichen");
  }
  let rawDecodedPath;
  try {
    rawDecodedPath = decodeURIComponent(raw.split("?", 1)[0]);
  } catch {
    throw new AppError("TARGET_INVALID", "Monitorziel ist ungueltig codiert");
  }
  if (/(?:^|\/)\.\.(?:\/|$)/.test(rawDecodedPath)) {
    throw new AppError("TARGET_FORBIDDEN", "Pfadnavigation ist nicht erlaubt");
  }
  let url;
  try {
    url = new URL(raw, "https://monitor.invalid");
  } catch {
    throw new AppError("TARGET_INVALID", "Monitorziel ist ungueltig");
  }
  if (url.origin !== "https://monitor.invalid" || !url.pathname.startsWith("/") || url.username || url.password) {
    throw new AppError("TARGET_FORBIDDEN", "Nur lokale Monitorziele sind erlaubt");
  }
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    throw new AppError("TARGET_INVALID", "Monitorziel ist ungueltig codiert");
  }
  if (decoded.includes("..") || decoded.includes("\\") || /%2f|%5c/i.test(url.pathname)) {
    throw new AppError("TARGET_FORBIDDEN", "Pfadnavigation ist nicht erlaubt");
  }

  const rules = {
    "/index.html": {},
    "/scoreboard.html": {},
    "/Matches1.html": {},
    "/Bewerbe.html": {},
    "/bewerbsRaster.html": { id: "required" },
    "/rangliste.html": { id: "optional" },
    "/RoundRobin.html": { id: "required", paarungslayout: "layout" },
    "/entryList.html": { id: "required" },
  };
  const rule = rules[url.pathname];
  if (!rule) throw new AppError("TARGET_FORBIDDEN", "Monitorziel ist nicht freigegeben");

  const seen = new Set();
  for (const [key] of url.searchParams) {
    if (seen.has(key)) throw new AppError("TARGET_INVALID", `Parameter ${key} ist doppelt`);
    seen.add(key);
    if (!Object.hasOwn(rule, key)) throw new AppError("TARGET_INVALID", `Parameter ${key} ist nicht erlaubt`);
  }
  for (const [name, type] of Object.entries(rule)) {
    const value = url.searchParams.get(name);
    if (type === "required" && !value) throw new AppError("TARGET_INVALID", `Parameter ${name} fehlt`);
    if (!value) continue;
    if (type === "layout") {
      if (!/^[0-5]$/.test(value)) throw new AppError("TARGET_INVALID", "paarungslayout ist ungueltig");
      continue;
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new AppError("TARGET_INVALID", `${name} ist ungueltig`);
    const ids = getCompetitionIds(dataStore);
    if (ids.size && !ids.has(value)) throw new AppError("TARGET_NOT_FOUND", "Bewerb existiert nicht", 404);
  }
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
}

function newCommandId() {
  return crypto.randomUUID();
}

module.exports = {
  booleanValue,
  canonicalizeMonitorPath,
  emailValue,
  idValue,
  integerValue,
  newCommandId,
  operationId,
  passwordHashValue,
  requireObject,
  roleValue,
  safePublicUser,
  stringValue,
};
