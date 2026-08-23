const DEFINITIONS = Object.freeze({
  firstName: { max: 100 },
  lastName: { max: 100, required: true },
  birthDate: { max: 10 },
  gender: { max: 1 },
  phone: { max: 32 },
  email: { max: 254 },
  login: { max: 254 },
  country: { max: 100 },
  postalCode: { max: 16 },
  city: { max: 100 },
  address: { max: 200 },
  active: { max: 1 },
  role: { max: 16 },
});

const ROLES = new Map([
  ["admin", "admin"],
  ["operator", "operator"],
  ["player", "player"],
  ["player a", "player A"],
  ["player b", "player B"],
]);

export class PersonValueError extends Error {
  constructor(field, message) {
    super(message);
    this.name = "PersonValueError";
    this.code = "VALIDATION_ERROR";
    this.field = field;
  }
}

function invalid(field, message) {
  throw new PersonValueError(field, message);
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function validBirthDate(value) {
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return false;
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day);
}

function canonicalEmail(value, field) {
  const email = value.toLocaleLowerCase("en-US");
  const [local, domain, ...rest] = email.split("@");
  const localValid = /^[\p{L}\p{N}\p{M}.!#$%&'*+/=?^_`{|}~-]+$/u.test(local || "")
    && byteLength(local || "") <= 64
    && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..");
  let asciiDomain = "";
  try {
    asciiDomain = new URL(`http://${domain || ""}`).hostname;
  } catch {}
  const domainValid = asciiDomain.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(asciiDomain);
  const normalized = `${local || ""}@${asciiDomain}`;
  if (rest.length || !localValid || !domainValid || byteLength(normalized) > 254) {
    invalid(field, "E-Mail-Adresse ist ungültig.");
  }
  return normalized;
}

export function canonicalizePersonValue(field, rawValue) {
  const definition = DEFINITIONS[field];
  if (!definition || typeof rawValue !== "string") invalid(field, "Unbekanntes oder ungültiges Personenfeld.");
  let value = rawValue.trim();
  if (value.length > definition.max) invalid(field, `${field} ist zu lang.`);
  if (definition.required && !value) invalid(field, `${field} darf nicht leer sein.`);
  if (field === "email" && value) value = canonicalEmail(value, field);
  if (field === "login" && value) {
    if (rawValue !== rawValue.trim() || value.length < 3 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]+$/.test(value)) {
      invalid(field, "Login muss 3 bis 254 erlaubte ASCII-Zeichen ohne Leerraum enthalten.");
    }
    value = value.toLocaleLowerCase("en-US");
  }
  if (field === "birthDate" && value && !validBirthDate(value)) invalid(field, "Geburtsdatum muss TT.MM.JJJJ enthalten.");
  if (field === "gender" && value && !["1", "2", "3"].includes(value)) invalid(field, "Geschlecht muss leer, 1, 2 oder 3 sein.");
  if (field === "phone" && value && !/^00\d+ \d+ \d(?:[\d ]*\d)?$/.test(value)) invalid(field, "Telefonnummer entspricht nicht dem Zielformat.");
  if (field === "postalCode" && value && !/^\d{4}$/.test(value)) invalid(field, "PLZ muss vierstellig sein.");
  if (field === "active" && !["", "1"].includes(value)) invalid(field, "Aktiv muss leer oder 1 sein.");
  if (field === "role") {
    value = ROLES.get(value.toLocaleLowerCase("en-US")) || "";
    if (!value) invalid(field, "Rolle ist ungültig.");
  }
  return value;
}

export function canonicalizePersonChanges(rawChanges, { allowEmpty = false } = {}) {
  if (!rawChanges || Array.isArray(rawChanges) || typeof rawChanges !== "object") invalid("changes", "Änderungen fehlen.");
  const entries = Object.entries(rawChanges);
  if (!allowEmpty && !entries.length) invalid("changes", "Mindestens eine Änderung ist erforderlich.");
  return Object.fromEntries(entries.map(([field, value]) => [field, canonicalizePersonValue(field, value)]));
}

export const PERSON_FIELDS = Object.freeze(Object.keys(DEFINITIONS));
