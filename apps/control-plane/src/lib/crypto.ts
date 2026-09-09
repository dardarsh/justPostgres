import {
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

// Encryption at rest lives in its own package because the router needs it too:
// a pooled connection is authenticated by the router, not relayed, so it has to
// decrypt the project's password itself.
export { encryptSecret, decryptSecret, parseMasterKey } from "@justpostgres/secrets";

/** promisify() drops the options overload, so wrap it by hand. */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) =>
      err ? reject(err) : resolve(derived),
    );
  });
}

/**
 * Password hashing with scrypt from the standard library.
 *
 * Deliberately not argon2 or bcrypt: both are native modules, and for a single
 * admin password checked at login the marginal resistance is not worth adding a
 * compiled dependency to the install path.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64!, "base64");
  const expected = Buffer.from(hashB64!, "base64");

  const derived = await scrypt(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Session tokens: opaque, high-entropy, URL-safe. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Passwords for the projects' Postgres roles.
 *
 * Alphanumeric only, on purpose. These end up in connection strings, .env
 * files, and shell commands, and a password containing `@`, `/`, `:` or `#`
 * turns a working URL into a support ticket. 62^32 is ample entropy without it.
 */
export function generateDatabasePassword(length = 32): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(length * 2);
  let out = "";
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    // Reject values that would bias the modulo, rather than skewing toward the
    // start of the alphabet.
    const byte = bytes[i]!;
    if (byte >= 256 - (256 % alphabet.length)) continue;
    out += alphabet[byte % alphabet.length];
  }
  return out;
}

/**
 * Short public identifier for a project, used in hostnames, container names and
 * connection strings. Lowercase alphanumeric, starting with a letter so it is a
 * valid DNS label and a valid Postgres identifier.
 */
export function generateProjectRef(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(32);
  let out = letters[bytes[0]! % letters.length]!;
  for (let i = 1; out.length < 12 && i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (byte >= 256 - (256 % alphabet.length)) continue;
    out += alphabet[byte % alphabet.length];
  }
  return out;
}

export { randomUUID };
