/**
 * Postgres frontend/backend protocol, version 3.0.
 *
 * Only what the router needs: enough to read the startup exchange, recognise
 * the handful of messages that affect routing and pooling, and otherwise move
 * bytes without interpreting them. Everything the router does not care about is
 * forwarded verbatim, which is what keeps it compatible with clients and
 * extensions it has never heard of.
 *
 * Reference: https://www.postgresql.org/docs/current/protocol-message-formats.html
 */

/** Request codes that appear in place of a protocol version in a startup packet. */
export const SSL_REQUEST_CODE = 80877103;
export const GSSENC_REQUEST_CODE = 80877104;
export const CANCEL_REQUEST_CODE = 80877102;
export const PROTOCOL_VERSION_3 = 196608; // 3.0

/** Backend message type bytes the router acts on. */
export const BackendMessage = {
  Authentication: 0x52, // 'R'
  BackendKeyData: 0x4b, // 'K'
  ParameterStatus: 0x53, // 'S'
  ReadyForQuery: 0x5a, // 'Z'
  ErrorResponse: 0x45, // 'E'
  NoticeResponse: 0x4e, // 'N'
} as const;

/** Frontend message type bytes the router acts on. */
export const FrontendMessage = {
  Query: 0x51, // 'Q'
  Parse: 0x50, // 'P'
  Bind: 0x42, // 'B'
  Execute: 0x45, // 'E'
  Sync: 0x53, // 'S'
  Terminate: 0x58, // 'X'
  PasswordMessage: 0x70, // 'p' — also SASLInitialResponse and SASLResponse
} as const;

/** Sub-codes of the Authentication message. */
export const AuthRequest = {
  Ok: 0,
  CleartextPassword: 3,
  Md5Password: 5,
  Sasl: 10,
  SaslContinue: 11,
  SaslFinal: 12,
} as const;

/** Transaction status reported in ReadyForQuery. */
export const TransactionStatus = {
  Idle: 0x49, // 'I' — no transaction open; safe to release a pooled connection
  InTransaction: 0x54, // 'T'
  Failed: 0x45, // 'E'
} as const;

export interface RawMessage {
  /** Type byte, or null for an untyped startup-phase message. */
  type: number | null;
  /** Payload without the type byte and length prefix. */
  payload: Buffer;
  /** The complete message as it appeared on the wire, for verbatim forwarding. */
  raw: Buffer;
}

/**
 * Incremental message framing.
 *
 * TCP gives us arbitrary chunk boundaries, so every read path has to buffer
 * until a whole message is present. Getting this wrong is the classic proxy
 * bug: it works until a message happens to straddle a packet boundary, which
 * is exactly when the payload is large and the user is least amused.
 */
export class MessageReader {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private startupPhase: boolean) {}

  /** After the startup exchange, every message carries a type byte. */
  enterMessagePhase(): void {
    this.startupPhase = false;
  }

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /** Bytes buffered but not yet framed into a message. */
  get pending(): number {
    return this.buffer.length;
  }

  /** Take everything buffered without framing it. Used when switching to raw relay. */
  drain(): Buffer {
    const out = this.buffer;
    this.buffer = Buffer.alloc(0);
    return out;
  }

  next(): RawMessage | null {
    if (this.startupPhase) return this.nextStartup();
    return this.nextTyped();
  }

  private nextStartup(): RawMessage | null {
    if (this.buffer.length < 4) return null;
    const length = this.buffer.readInt32BE(0);
    if (length < 4 || length > MAX_MESSAGE_BYTES) {
      throw new ProtocolError(`Implausible startup message length ${length}`);
    }
    if (this.buffer.length < length) return null;

    const raw = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return { type: null, payload: raw.subarray(4), raw };
  }

  private nextTyped(): RawMessage | null {
    if (this.buffer.length < 5) return null;
    const type = this.buffer.readUInt8(0);
    const length = this.buffer.readInt32BE(1);
    if (length < 4 || length > MAX_MESSAGE_BYTES) {
      throw new ProtocolError(`Implausible message length ${length} for type ${type}`);
    }

    const total = length + 1;
    if (this.buffer.length < total) return null;

    const raw = this.buffer.subarray(0, total);
    this.buffer = this.buffer.subarray(total);
    return { type, payload: raw.subarray(5), raw };
  }
}

/**
 * A message longer than this is not a message, it is a protocol desync or
 * someone pointing an HTTP client at port 5432. Refusing early keeps a bad
 * frame from turning into an unbounded allocation.
 */
const MAX_MESSAGE_BYTES = 512 * 1024 * 1024;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export interface StartupPacket {
  code: number;
  /** Populated only for a real StartupMessage. */
  parameters: Record<string, string>;
  /** Populated only for a CancelRequest. */
  cancel?: { processId: number; secretKey: number };
}

export function parseStartupPacket(message: RawMessage): StartupPacket {
  if (message.payload.length < 4) throw new ProtocolError("Startup packet is too short");
  const code = message.payload.readInt32BE(0);

  if (code === SSL_REQUEST_CODE || code === GSSENC_REQUEST_CODE) {
    return { code, parameters: {} };
  }

  if (code === CANCEL_REQUEST_CODE) {
    if (message.payload.length < 12) throw new ProtocolError("CancelRequest is too short");
    return {
      code,
      parameters: {},
      cancel: {
        processId: message.payload.readInt32BE(4),
        secretKey: message.payload.readInt32BE(8),
      },
    };
  }

  // Anything else is a StartupMessage whose code is the protocol version.
  const parameters: Record<string, string> = {};
  const body = message.payload.subarray(4);
  let offset = 0;
  while (offset < body.length) {
    const keyEnd = body.indexOf(0, offset);
    if (keyEnd === -1) break;
    const key = body.toString("utf8", offset, keyEnd);
    if (key.length === 0) break; // trailing terminator

    const valueEnd = body.indexOf(0, keyEnd + 1);
    if (valueEnd === -1) throw new ProtocolError("Unterminated startup parameter value");
    parameters[key] = body.toString("utf8", keyEnd + 1, valueEnd);
    offset = valueEnd + 1;
  }

  return { code, parameters };
}

/** Rebuild a StartupMessage, used to rewrite the username before forwarding. */
export function encodeStartupPacket(version: number, parameters: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(parameters)) {
    parts.push(Buffer.from(`${key}\0${value}\0`, "utf8"));
  }
  parts.push(Buffer.from([0]));

  const body = Buffer.concat(parts);
  const out = Buffer.alloc(8 + body.length);
  out.writeInt32BE(out.length, 0);
  out.writeInt32BE(version, 4);
  body.copy(out, 8);
  return out;
}

export function encodeCancelRequest(processId: number, secretKey: number): Buffer {
  const out = Buffer.alloc(16);
  out.writeInt32BE(16, 0);
  out.writeInt32BE(CANCEL_REQUEST_CODE, 4);
  out.writeInt32BE(processId, 8);
  out.writeInt32BE(secretKey, 12);
  return out;
}

/** Build a typed message from its payload. */
export function encodeMessage(type: number, payload: Buffer): Buffer {
  const out = Buffer.alloc(5 + payload.length);
  out.writeUInt8(type, 0);
  out.writeInt32BE(payload.length + 4, 1);
  payload.copy(out, 5);
  return out;
}

/**
 * ErrorResponse.
 *
 * The router has to be able to reject a connection in a way the client
 * understands — "no such project" must arrive as a Postgres error in psql, not
 * as a dropped socket that reads like a network fault.
 */
export function encodeErrorResponse(opts: {
  severity?: string;
  code: string;
  message: string;
  detail?: string;
  hint?: string;
}): Buffer {
  const fields: Buffer[] = [];
  const push = (tag: string, value: string) =>
    fields.push(Buffer.from(`${tag}${value}\0`, "utf8"));

  push("S", opts.severity ?? "FATAL");
  push("V", opts.severity ?? "FATAL");
  push("C", opts.code);
  push("M", opts.message);
  if (opts.detail) push("D", opts.detail);
  if (opts.hint) push("H", opts.hint);
  fields.push(Buffer.from([0]));

  return encodeMessage(BackendMessage.ErrorResponse, Buffer.concat(fields));
}

export function encodeReadyForQuery(status: number): Buffer {
  return encodeMessage(BackendMessage.ReadyForQuery, Buffer.from([status]));
}

export function encodeAuthenticationOk(): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeInt32BE(AuthRequest.Ok, 0);
  return encodeMessage(BackendMessage.Authentication, payload);
}

export function encodeBackendKeyData(processId: number, secretKey: number): Buffer {
  const payload = Buffer.alloc(8);
  payload.writeInt32BE(processId, 0);
  payload.writeInt32BE(secretKey, 4);
  return encodeMessage(BackendMessage.BackendKeyData, payload);
}

export function encodeParameterStatus(name: string, value: string): Buffer {
  return encodeMessage(
    BackendMessage.ParameterStatus,
    Buffer.from(`${name}\0${value}\0`, "utf8"),
  );
}

export function parseBackendKeyData(payload: Buffer): { processId: number; secretKey: number } {
  return { processId: payload.readInt32BE(0), secretKey: payload.readInt32BE(4) };
}

export function parseParameterStatus(payload: Buffer): { name: string; value: string } {
  const split = payload.indexOf(0);
  return {
    name: payload.toString("utf8", 0, split),
    value: payload.toString("utf8", split + 1, payload.length - 1),
  };
}

/** Read the sub-code of an Authentication message. */
export function parseAuthRequest(payload: Buffer): { code: number; body: Buffer } {
  return { code: payload.readInt32BE(0), body: payload.subarray(4) };
}

/** Decode an ErrorResponse enough to log or relay its message. */
export function parseErrorResponse(payload: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  let offset = 0;
  while (offset < payload.length) {
    const tag = payload.readUInt8(offset);
    if (tag === 0) break;
    const end = payload.indexOf(0, offset + 1);
    if (end === -1) break;
    fields[String.fromCharCode(tag)] = payload.toString("utf8", offset + 1, end);
    offset = end + 1;
  }
  return fields;
}
