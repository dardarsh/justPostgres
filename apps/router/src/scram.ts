import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * SCRAM-SHA-256, both directions.
 *
 * Session mode never needs this: it relays authentication straight through to
 * Postgres. Transaction pooling does, unavoidably. A pooled server connection
 * is opened before any particular client asks for it and is shared between
 * clients afterwards, so there is no single client whose authentication could
 * be relayed. That leaves the router doing both halves:
 *
 *  - as a **server**, proving to the client that it knows the password
 *  - as a **client**, proving the same thing to Postgres
 *
 * RFC 5802 and RFC 7677, as Postgres implements them (no channel binding).
 *
 * One documented limitation: Postgres applies SASLprep to passwords, and this
 * does not. Every password justpostgres generates is alphanumeric ASCII, for
 * which SASLprep is the identity function, so it makes no difference today. A
 * password set by hand containing non-ASCII characters would fail here.
 */

const SALT_BYTES = 16;
const ITERATIONS = 4096;
const KEY_LENGTH = 32;

const CLIENT_KEY = Buffer.from("Client Key", "utf8");
const SERVER_KEY = Buffer.from("Server Key", "utf8");

export class ScramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScramError";
  }
}

function hmac(key: Buffer, data: Buffer | string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

function saltedPassword(password: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(password, salt, iterations, KEY_LENGTH, "sha256");
}

function nonce(): string {
  // Base64 minus '=' and ',': the SCRAM grammar forbids ',' in a nonce, and '='
  // is the attribute separator.
  return randomBytes(18).toString("base64").replace(/[=,]/g, "");
}

/** Parse `a=1,b=2` attribute lists. */
function attributes(message: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of message.split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) out.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Server side: the router proves the password to a connecting client.
// ---------------------------------------------------------------------------

export class ScramServer {
  private clientFirstBare = "";
  private serverFirst = "";
  private readonly salt = randomBytes(SALT_BYTES);
  private readonly serverNonce = nonce();
  private combinedNonce = "";

  constructor(private readonly password: string) {}

  /**
   * Step 1: consume the client's first message, produce the server's.
   * Input is the SASL data from SASLInitialResponse, e.g. `n,,n=,r=<nonce>`.
   */
  firstMessage(clientFirst: string): string {
    // The gs2 header is the first two comma-separated fields. Everything after
    // is the "bare" message the proof is computed over.
    const gs2End = nthCommaIndex(clientFirst, 2);
    if (gs2End === -1) throw new ScramError("Malformed SCRAM client-first-message");

    const gs2 = clientFirst.slice(0, gs2End);
    if (gs2.startsWith("p")) {
      throw new ScramError("Channel binding is not supported by the router");
    }

    this.clientFirstBare = clientFirst.slice(gs2End + 1);
    const attrs = attributes(this.clientFirstBare);
    const clientNonce = attrs.get("r");
    if (!clientNonce) throw new ScramError("SCRAM client-first-message has no nonce");

    this.combinedNonce = clientNonce + this.serverNonce;
    this.serverFirst = `r=${this.combinedNonce},s=${this.salt.toString("base64")},i=${ITERATIONS}`;
    return this.serverFirst;
  }

  /**
   * Step 2: verify the client's proof and produce the server's signature.
   * Throws if the password is wrong.
   */
  finalMessage(clientFinal: string): string {
    const withoutProof = clientFinal.slice(0, clientFinal.lastIndexOf(",p="));
    const attrs = attributes(clientFinal);

    if (attrs.get("r") !== this.combinedNonce) {
      throw new ScramError("SCRAM nonce mismatch");
    }
    const proofB64 = attrs.get("p");
    if (!proofB64) throw new ScramError("SCRAM client-final-message has no proof");

    const salted = saltedPassword(this.password, this.salt, ITERATIONS);
    const clientKey = hmac(salted, CLIENT_KEY);
    const storedKey = sha256(clientKey);

    const authMessage = `${this.clientFirstBare},${this.serverFirst},${withoutProof}`;
    const clientSignature = hmac(storedKey, authMessage);

    const proof = Buffer.from(proofB64, "base64");
    if (proof.length !== clientSignature.length) throw new ScramError("Bad SCRAM proof length");

    const candidateKey = xor(proof, clientSignature);
    if (!timingSafeEqual(sha256(candidateKey), storedKey)) {
      throw new ScramError("password authentication failed");
    }

    const serverKey = hmac(salted, SERVER_KEY);
    return `v=${hmac(serverKey, authMessage).toString("base64")}`;
  }
}

// ---------------------------------------------------------------------------
// Client side: the router proves the password to Postgres.
// ---------------------------------------------------------------------------

export class ScramClient {
  private readonly clientNonce = nonce();
  private clientFirstBare = "";
  private authMessage = "";
  private serverSignature: Buffer | null = null;

  constructor(private readonly password: string) {}

  /** Step 1: the message that goes inside SASLInitialResponse. */
  firstMessage(): string {
    this.clientFirstBare = `n=,r=${this.clientNonce}`;
    return `n,,${this.clientFirstBare}`;
  }

  /** Step 2: answer the server's challenge with a proof. */
  finalMessage(serverFirst: string): string {
    const attrs = attributes(serverFirst);
    const combinedNonce = attrs.get("r");
    const saltB64 = attrs.get("s");
    const iterations = Number(attrs.get("i"));

    if (!combinedNonce || !combinedNonce.startsWith(this.clientNonce)) {
      throw new ScramError("Server nonce does not extend the client nonce");
    }
    if (!saltB64 || !Number.isFinite(iterations)) {
      throw new ScramError("Malformed SCRAM server-first-message");
    }

    const salt = Buffer.from(saltB64, "base64");
    const salted = saltedPassword(this.password, salt, iterations);
    const clientKey = hmac(salted, CLIENT_KEY);
    const storedKey = sha256(clientKey);

    // "biws" is base64("n,,") — the gs2 header, echoed back.
    const withoutProof = `c=biws,r=${combinedNonce}`;
    this.authMessage = `${this.clientFirstBare},${serverFirst},${withoutProof}`;

    const clientSignature = hmac(storedKey, this.authMessage);
    const proof = xor(clientKey, clientSignature);

    const serverKey = hmac(salted, SERVER_KEY);
    this.serverSignature = hmac(serverKey, this.authMessage);

    return `${withoutProof},p=${proof.toString("base64")}`;
  }

  /**
   * Step 3: check that the server also knew the password.
   *
   * Skipping this is the common shortcut and it is a real one: without it the
   * router will happily hand a password-derived session to anything that can
   * answer on the right port.
   */
  verifyServerSignature(serverFinal: string): void {
    const expected = this.serverSignature;
    if (!expected) throw new ScramError("verifyServerSignature called out of order");

    const received = attributes(serverFinal).get("v");
    if (!received) throw new ScramError("SCRAM server-final-message has no signature");

    const actual = Buffer.from(received, "base64");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new ScramError("Server signature did not verify; this is not the database we expected");
    }
  }
}

function nthCommaIndex(value: string, n: number): number {
  let index = -1;
  for (let i = 0; i < n; i++) {
    index = value.indexOf(",", index + 1);
    if (index === -1) return -1;
  }
  return index;
}

/** SASLInitialResponse payload: mechanism name, then Int32 length, then data. */
export function parseSaslInitialResponse(payload: Buffer): { mechanism: string; data: string } {
  const end = payload.indexOf(0);
  if (end === -1) throw new ScramError("Malformed SASLInitialResponse");
  const mechanism = payload.toString("utf8", 0, end);
  const length = payload.readInt32BE(end + 1);
  const data = length <= 0 ? "" : payload.toString("utf8", end + 5, end + 5 + length);
  return { mechanism, data };
}

export function encodeSaslInitialResponse(mechanism: string, data: string): Buffer {
  const dataBuf = Buffer.from(data, "utf8");
  const payload = Buffer.alloc(mechanism.length + 1 + 4 + dataBuf.length);
  payload.write(mechanism, 0, "utf8");
  payload.writeUInt8(0, mechanism.length);
  payload.writeInt32BE(dataBuf.length, mechanism.length + 1);
  dataBuf.copy(payload, mechanism.length + 5);
  return payload;
}

export const SCRAM_SHA_256 = "SCRAM-SHA-256";
