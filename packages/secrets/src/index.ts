import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption of credentials at rest, shared by the control plane (which writes
 * them) and the router (which must decrypt them to authenticate to a project's
 * Postgres on a pooled connection's behalf).
 *
 * Node-only, and deliberately its own package rather than part of
 * @justpostgres/shared: that one is imported by the browser bundle, and
 * node:crypto has no business being reachable from there.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Output is base64 of iv || tag || ciphertext. */
export function encryptSecret(plaintext: string, masterKey: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptSecret(encoded: string, masterKey: Buffer): string {
  const raw = Buffer.from(encoded, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error("Ciphertext is too short to be valid");
  }

  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(
      "Could not decrypt stored credential. This usually means JP_MASTER_KEY " +
        "has changed since the value was written.",
    );
  }
}

/** Validate and decode a base64 JP_MASTER_KEY into the 32 bytes AES-256 needs. */
export function parseMasterKey(raw: string): Buffer {
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      `JP_MASTER_KEY must decode to exactly 32 bytes, got ${decoded.length}. ` +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return decoded;
}
