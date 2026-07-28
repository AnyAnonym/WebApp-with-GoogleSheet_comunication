const crypto = require("crypto");
const { promisify } = require("util");
const dataStore = require("./dataStore.js");
const { PASSWORD_RESET_TTL_MS, SESSION_TTL_MS } = require("./config.js");
const { AppError } = require("./errors.js");
const { hashPayload, timingSafeTextEqual } = require("./security.js");
const { headerIndex, headerOf } = require("./tableUtils.js");
const { emailValue, passwordHashValue, roleValue } = require("./validators.js");

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const DUMMY_SALT = Buffer.alloc(16);
const DUMMY_KEY = Buffer.alloc(SCRYPT_KEY_LENGTH);
const DUMMY_STORED_HASH = `scrypt$v1$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${DUMMY_SALT.toString("base64url")}$${DUMMY_KEY.toString("base64url")}`;

class AuthService {
  constructor({ repository, sheetService }) {
    this.repository = repository;
    this.sheetService = sheetService;
    this.activeVerifications = 0;
    this.userQueues = new Map();
  }

  runForUser(userId, callback) {
    const previous = this.userQueues.get(userId) || Promise.resolve();
    const operation = previous.catch(() => {}).then(callback);
    this.userQueues.set(userId, operation);
    operation.finally(() => {
      if (this.userQueues.get(userId) === operation) this.userQueues.delete(userId);
    }).catch(() => {});
    return operation;
  }

  async verifyCredential(credential, storedHash) {
    if (this.activeVerifications >= 4) throw new AppError("AUTH_BUSY", "Authentifizierung ist ausgelastet", 503);
    this.activeVerifications++;
    try {
      return await this.verifyStoredPassword(credential, storedHash);
    } finally {
      this.activeVerifications--;
    }
  }

  ensurePeopleAvailable() {
    if (!dataStore.isTableCurrent("players")) {
      throw new AppError("PERSON_DATA_UNAVAILABLE", "Personendaten sind derzeit nicht aktuell", 503);
    }
  }

  parsePeople() {
    const values = dataStore.get("players");
    if (!Array.isArray(values) || values.length < 2) return [];
    const header = headerOf(values);
    const indexes = {
      id: headerIndex(header, "id"),
      firstName: headerIndex(header, "vorname"),
      lastName: headerIndex(header, "nachname"),
      email: headerIndex(header, "e-mail", "email"),
      passwordHash: headerIndex(header, "passwdhash"),
      phone: headerIndex(header, "telefonmobil"),
      gender: headerIndex(header, "geschlecht"),
      active: headerIndex(header, "aktiv"),
      role: headerIndex(header, "role"),
    };
    if ([indexes.id, indexes.firstName, indexes.lastName].some((index) => index < 0)) {
      throw new AppError("SHEET_SCHEMA", "Pflichtspalten der Personen-Tabelle fehlen", 503);
    }
    return values.slice(1).map((row, offset) => ({
      id: String(row[indexes.id] || "").trim(),
      firstName: String(row[indexes.firstName] || "").trim(),
      lastName: String(row[indexes.lastName] || "").trim(),
      email: indexes.email < 0 ? "" : String(row[indexes.email] || "").trim().toLowerCase(),
      storedPasswordHash: indexes.passwordHash < 0 ? "" : String(row[indexes.passwordHash] || "").trim(),
      phone: indexes.phone < 0 ? "" : String(row[indexes.phone] || "").trim(),
      gender: indexes.gender < 0 ? "" : String(row[indexes.gender] || "").trim(),
      active: indexes.active < 0 || String(row[indexes.active] || "").trim() === "1",
      role: roleValue(indexes.role < 0 ? "player" : row[indexes.role]),
      rowNumber: offset + 2,
    })).filter((person) => person.id);
  }

  findByEmail(email) {
    const normalized = emailValue(email);
    return this.parsePeople().find((person) => person.email === normalized) || null;
  }

  findById(id) {
    return this.parsePeople().find((person) => person.id === String(id)) || null;
  }

  publicPlayersTable() {
    const rows = this.parsePeople().map((person) => [
      person.id,
      person.firstName,
      person.lastName,
      person.active ? "1" : "0",
    ]);
    return [["ID", "Vorname", "Nachname", "Aktiv"], ...rows];
  }

  memberDirectoryTable() {
    const rows = this.parsePeople().filter((person) => person.active).map((person) => [
      person.id,
      person.firstName,
      person.lastName,
      person.phone,
      "1",
    ]);
    return [["ID", "Vorname", "Nachname", "TelefonMobil", "Aktiv"], ...rows];
  }

  publicProfile(id) {
    const person = this.findById(id);
    if (!person) throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
    return { id: person.id, firstName: person.firstName, lastName: person.lastName };
  }

  privateProfile(person) {
    return {
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email,
      phone: person.phone,
      gender: person.gender,
      role: person.role,
    };
  }

  async createStoredPasswordHash(clientHash) {
    const credential = passwordHashValue(clientHash);
    const salt = crypto.randomBytes(16);
    const derived = await scryptAsync(credential, salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 64 * 1024 * 1024,
    });
    return `scrypt$v1$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
  }

  async verifyStoredPassword(clientHash, storedHash) {
    const credential = passwordHashValue(clientHash);
    if (/^[0-9a-f]{64}$/i.test(storedHash)) {
      const valid = timingSafeTextEqual(credential, storedHash.toLowerCase());
      await scryptAsync(credential, DUMMY_SALT, SCRYPT_KEY_LENGTH, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: 64 * 1024 * 1024,
      });
      return { valid, legacy: true };
    }
    const parts = String(storedHash).split("$");
    if (parts.length !== 7 || parts[0] !== "scrypt" || parts[1] !== "v1") return { valid: false, legacy: false };
    const N = Number(parts[2]);
    const r = Number(parts[3]);
    const p = Number(parts[4]);
    if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return { valid: false, legacy: false };
    let salt;
    let expected;
    try {
      salt = Buffer.from(parts[5], "base64url");
      expected = Buffer.from(parts[6], "base64url");
    } catch {
      return { valid: false, legacy: false };
    }
    if (expected.length !== SCRYPT_KEY_LENGTH) return { valid: false, legacy: false };
    const actual = await scryptAsync(credential, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
    return { valid: crypto.timingSafeEqual(actual, expected), legacy: false };
  }

  async login({ email, passwordHash, ip }) {
    const normalizedEmail = emailValue(email);
    const credential = passwordHashValue(passwordHash);
    this.ensurePeopleAvailable();
    const rateKey = `${ip}|${normalizedEmail}`;
    const ipRateKey = `ip|${ip}`;
    const blockedFor = Math.max(this.repository.getLoginBlock(rateKey), this.repository.getLoginBlock(ipRateKey));
    if (blockedFor > 0) {
      throw new AppError("LOGIN_RATE_LIMIT", "Zu viele Anmeldeversuche", 429, { retryAfterMs: blockedFor });
    }
    const reservedFor = Math.max(
      this.repository.recordLoginFailure(rateKey),
      this.repository.recordLoginFailure(ipRateKey, { maxAttempts: 20 }),
    );
    if (reservedFor > 0) {
      throw new AppError("LOGIN_RATE_LIMIT", "Zu viele Anmeldeversuche", 429, { retryAfterMs: reservedFor });
    }
    const initialPerson = this.findByEmail(normalizedEmail);
    if (!initialPerson?.active) {
      await this.verifyCredential(credential, DUMMY_STORED_HASH);
      throw new AppError("LOGIN_FAILED", "E-Mail oder Passwort ist ungueltig", 401);
    }
    return this.runForUser(initialPerson.id, async () => {
      this.ensurePeopleAvailable();
      const person = this.findByEmail(normalizedEmail);
      const verification = await this.verifyCredential(
        credential,
        person?.active && person.id === initialPerson.id ? person.storedPasswordHash : DUMMY_STORED_HASH,
      );
      if (!person || person.id !== initialPerson.id || !person.active || !verification.valid) {
        throw new AppError("LOGIN_FAILED", "E-Mail oder Passwort ist ungueltig", 401);
      }
      this.repository.clearLoginFailures(rateKey);
      this.repository.clearLoginFailures(ipRateKey);
      if (verification.legacy) {
        const upgraded = await this.createStoredPasswordHash(credential);
        await this.sheetService.setPasswordHash(person.id, upgraded, { expectedHash: person.storedPasswordHash });
        person.storedPasswordHash = upgraded;
      }
      this.repository.revokeUserSessions(person.id);
      const session = this.repository.createSession({ userId: person.id, email: person.email, ttlMs: SESSION_TTL_MS });
      return { session, user: this.privateProfile(person) };
    });
  }

  getUserForToken(token) {
    const session = this.repository.getSession(token);
    if (!session) return null;
    this.ensurePeopleAvailable();
    const person = this.findById(session.userId);
    if (!person || !person.active) {
      this.repository.revokeSession(token);
      return null;
    }
    return {
      session,
      principal: {
        type: "user",
        id: person.id,
        email: person.email,
        role: person.role,
        name: [person.firstName, person.lastName].filter(Boolean).join(" "),
      },
      user: this.privateProfile(person),
    };
  }

  requireUser(token) {
    const auth = this.getUserForToken(token);
    if (!auth) throw new AppError("AUTH_REQUIRED", "Anmeldung erforderlich", 401);
    return auth;
  }

  requireRole(token, roles) {
    const auth = this.requireUser(token);
    if (!roles.includes(auth.principal.role)) throw new AppError("FORBIDDEN", "Berechtigung fehlt", 403);
    return auth;
  }

  logout(token) {
    this.repository.revokeSession(token);
  }

  async changeOwnPassword(token, currentPasswordHash, newPasswordHash) {
    const initialAuth = this.requireUser(token);
    return this.runForUser(initialAuth.principal.id, async () => {
      const auth = this.requireUser(token);
      const person = this.findById(auth.principal.id);
      const current = await this.verifyStoredPassword(currentPasswordHash, person.storedPasswordHash);
      if (!current.valid) throw new AppError("PASSWORD_INVALID", "Aktuelles Passwort ist falsch", 403);
      const stored = await this.createStoredPasswordHash(newPasswordHash);
      this.repository.revokeUserSessions(person.id);
      try {
        await this.sheetService.setPasswordHash(person.id, stored, { expectedHash: person.storedPasswordHash });
      } catch (error) {
        error.details = { ...(error.details || {}), sessionInvalidated: true };
        throw error;
      }
      this.repository.revokeUserSessions(person.id);
      const session = this.repository.createSession({ userId: person.id, email: person.email, ttlMs: SESSION_TTL_MS });
      return { success: true, session, user: this.privateProfile(person) };
    });
  }

  createPasswordReset(token, personId) {
    const admin = this.requireRole(token, ["admin"]);
    const person = this.findById(personId);
    if (!person) throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
    const proof = this.repository.createPasswordResetProof(person.id, admin.principal.id, PASSWORD_RESET_TTL_MS);
    return { success: true, resetToken: proof.token, expiresAt: proof.expiresAt, personId: person.id };
  }

  async resetPassword(resetToken, newPasswordHash) {
    const pending = this.repository.getPasswordResetProof(resetToken);
    if (!pending) throw new AppError("RESET_PROOF_INVALID", "Reset-Nachweis ist ungueltig oder abgelaufen", 401);
    const payloadHash = hashPayload({ newPasswordHash });
    if (pending.payloadHash && pending.payloadHash !== payloadHash) {
      throw new AppError("RESET_PROOF_CONFLICT", "Reset-Nachweis ist bereits an ein anderes Passwort gebunden", 409);
    }
    this.ensurePeopleAvailable();
    const person = this.findById(pending.personId);
    if (!person) throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
    const candidateHash = pending.storedHash || await this.createStoredPasswordHash(newPasswordHash);
    return this.runForUser(person.id, async () => {
      const currentPerson = this.findById(person.id);
      if (!currentPerson) throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
      const attempt = this.repository.beginPasswordResetProof(resetToken, payloadHash, candidateHash);
      if (!attempt) throw new AppError("RESET_PROOF_INVALID", "Reset-Nachweis ist ungueltig oder abgelaufen", 401);
      if (attempt.completed) return { success: true, repeated: true };
      if (!attempt.acquired) throw new AppError("RESET_IN_PROGRESS", "Passwort-Reset wird bereits verarbeitet", 409, { retryAfterMs: 2000 });
      this.repository.revokeUserSessions(currentPerson.id);
      try {
        await this.sheetService.setPasswordHash(currentPerson.id, attempt.storedHash, { expectedHash: currentPerson.storedPasswordHash });
      } catch (error) {
        this.repository.releasePasswordResetProof(resetToken, payloadHash);
        throw error;
      }
      this.repository.revokeUserSessions(currentPerson.id);
      this.repository.completePasswordResetProof(resetToken, payloadHash);
      return { success: true };
    });
  }
}

module.exports = { AuthService };
