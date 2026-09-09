import net from "node:net";
import { randomInt } from "node:crypto";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { ServerConnection } from "./backend.js";
import type { RouterConfig } from "./config.js";
import { FramedStream } from "./framed.js";
import type { Logger } from "./logger.js";
import type { PoolManager, ProjectPool } from "./pool.js";
import {
  AuthRequest,
  BackendMessage,
  CANCEL_REQUEST_CODE,
  encodeAuthenticationOk,
  encodeBackendKeyData,
  encodeCancelRequest,
  encodeErrorResponse,
  encodeMessage,
  encodeParameterStatus,
  encodeReadyForQuery,
  FrontendMessage,
  GSSENC_REQUEST_CODE,
  MessageReader,
  parseStartupPacket,
  SSL_REQUEST_CODE,
  TransactionStatus,
  type RawMessage,
} from "./protocol.js";
import { resolveRoute, RoutingError } from "./resolve.js";
import type { RouteStore } from "./routes.js";
import { parseSaslInitialResponse, SCRAM_SHA_256, ScramError, ScramServer } from "./scram.js";

export interface TransactionStats {
  accepted: number;
  active: number;
  rejected: number;
  authFailures: number;
}

/**
 * Transaction mode: server connections are shared between clients, held only
 * for the duration of a transaction.
 *
 * This is what lets a project with `max_connections = 100` serve a serverless
 * deployment that opens thousands of short-lived connections. The cost is the
 * standard transaction-pooling contract: nothing that lives in a session
 * survives past a transaction boundary — `SET`, `LISTEN`, `WAIT`, session
 * advisory locks, `WITH HOLD` cursors, and named prepared statements all break.
 * The UI hands out a direct connection string alongside this one precisely so
 * migrations and `pg_dump` have somewhere correct to go.
 */
export class TransactionServer {
  private readonly server: net.Server;
  private readonly secureContext: tls.SecureContext | null;
  private readonly stats: TransactionStats = {
    accepted: 0,
    active: 0,
    rejected: 0,
    authFailures: 0,
  };
  /** Fake backend keys handed to clients, so a CancelRequest can find its session. */
  private readonly sessions = new Map<string, PooledSession>();

  constructor(
    private readonly config: RouterConfig,
    private readonly store: RouteStore,
    private readonly pools: PoolManager,
    private readonly logger: Logger,
  ) {
    this.secureContext = config.tls
      ? tls.createSecureContext({ cert: config.tls.cert, key: config.tls.key })
      : null;

    this.server = net.createServer((socket) => {
      void this.handle(socket).catch((err) => {
        this.logger.debug({ err }, "pooled connection ended with an error");
        socket.destroy();
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.poolPort, this.config.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  getStats(): TransactionStats {
    return { ...this.stats };
  }

  private async handle(socket: net.Socket): Promise<void> {
    socket.setNoDelay(true);
    this.stats.accepted++;

    let stream: Duplex = socket;
    let framed = new FramedStream(stream, true);
    let servername: string | null = null;
    let parameters: Record<string, string>;

    for (;;) {
      const message = await framed.next();
      if (!message) {
        socket.destroy();
        return;
      }
      const packet = parseStartupPacket(message);

      if (packet.code === SSL_REQUEST_CODE) {
        if (!this.secureContext) {
          stream.write(Buffer.from("N"));
          continue;
        }
        stream.write(Buffer.from("S"));
        const pending = framed.detach();
        if (pending.length > 0) socket.unshift(pending);

        const tlsSocket = new tls.TLSSocket(socket, {
          isServer: true,
          secureContext: this.secureContext,
        });
        await new Promise<void>((resolve, reject) => {
          tlsSocket.once("secure", () => resolve());
          tlsSocket.once("error", reject);
        });
        servername = typeof tlsSocket.servername === "string" ? tlsSocket.servername : null;
        stream = tlsSocket;
        framed = new FramedStream(stream, true);
        continue;
      }

      if (packet.code === GSSENC_REQUEST_CODE) {
        stream.write(Buffer.from("N"));
        continue;
      }

      if (packet.code === CANCEL_REQUEST_CODE && packet.cancel) {
        this.forwardCancel(packet.cancel.processId, packet.cancel.secretKey);
        socket.end();
        return;
      }

      parameters = packet.parameters;
      break;
    }

    // --- routing ---
    let resolution;
    try {
      resolution = resolveRoute(this.store, this.config, { servername, parameters });
    } catch (err) {
      this.stats.rejected++;
      this.reject(stream, err);
      return;
    }
    const { route } = resolution;

    // --- authenticate the client ourselves -----------------------------------
    // There is no backend to relay to: a pooled server connection is opened
    // before any client asks for it and shared afterwards, so the router has to
    // be the authenticator.
    try {
      await authenticateClient(stream, framed, route.password);
    } catch (err) {
      this.stats.authFailures++;
      this.logger.warn(
        { ref: route.ref, err: err instanceof Error ? err.message : String(err) },
        "pooled client authentication failed",
      );
      stream.write(
        encodeErrorResponse({
          code: "28P01",
          message: `password authentication failed for user "${resolution.role}"`,
        }),
      );
      stream.end();
      return;
    }

    const pool = this.pools.forRoute(route);

    let serverParameters: Record<string, string>;
    try {
      serverParameters = await pool.parameters();
    } catch (err) {
      this.stats.rejected++;
      this.logger.warn({ ref: route.ref, err }, "could not open a pooled connection");
      this.reject(
        stream,
        new RoutingError(
          "08006",
          `Could not reach the database for project "${route.name}".`,
          err instanceof Error ? err.message : undefined,
        ),
      );
      return;
    }

    // --- complete the login handshake ---
    const fakeKey = { processId: randomInt(1, 2 ** 31 - 1), secretKey: randomInt(1, 2 ** 31 - 1) };

    stream.write(encodeAuthenticationOk());
    for (const [name, value] of Object.entries(serverParameters)) {
      stream.write(encodeParameterStatus(name, value));
    }
    stream.write(encodeBackendKeyData(fakeKey.processId, fakeKey.secretKey));
    stream.write(encodeReadyForQuery(TransactionStatus.Idle));

    this.stats.active++;
    const session = new PooledSession(
      stream,
      framed.detach(),
      pool,
      this.logger.child({ ref: route.ref }),
      () => {
        this.stats.active--;
        this.sessions.delete(keyOf(fakeKey.processId, fakeKey.secretKey));
      },
    );
    this.sessions.set(keyOf(fakeKey.processId, fakeKey.secretKey), session);
    session.start();
  }

  /**
   * Cancel whatever the session is currently running.
   *
   * The client holds a key the router invented, so cancellation has to be
   * translated: find the session, find the server connection it holds right
   * now, and send a real CancelRequest with that backend's own key.
   */
  private forwardCancel(processId: number, secretKey: number): void {
    const session = this.sessions.get(keyOf(processId, secretKey));
    const target = session?.currentBackend();
    if (!target?.backendKey) return;

    const socket = net.connect({ host: target.route.host, port: target.route.port }, () => {
      socket.write(encodeCancelRequest(target.backendKey!.processId, target.backendKey!.secretKey));
      socket.end();
    });
    socket.on("error", (err) => this.logger.debug({ err }, "pooled cancel forward failed"));
  }

  private reject(stream: Duplex, err: unknown): void {
    if (err instanceof RoutingError) {
      stream.write(encodeErrorResponse({ code: err.code, message: err.message, hint: err.hint }));
    } else {
      stream.write(
        encodeErrorResponse({ code: "XX000", message: "The pooler could not establish a connection." }),
      );
      this.logger.error({ err }, "unexpected pooled routing failure");
    }
    stream.end();
  }
}

function keyOf(processId: number, secretKey: number): string {
  return `${processId >>> 0}:${secretKey >>> 0}`;
}

/** Run SCRAM as the server against a connecting client. */
async function authenticateClient(
  stream: Duplex,
  framed: FramedStream,
  password: string,
): Promise<void> {
  framed.enterMessagePhase();
  const scram = new ScramServer(password);

  const mechanisms = Buffer.from(`${SCRAM_SHA_256}\0\0`, "utf8");
  const saslRequest = Buffer.alloc(4 + mechanisms.length);
  saslRequest.writeInt32BE(AuthRequest.Sasl, 0);
  mechanisms.copy(saslRequest, 4);
  stream.write(encodeMessage(BackendMessage.Authentication, saslRequest));

  const initial = await expectPassword(framed);
  const { mechanism, data } = parseSaslInitialResponse(initial.payload);
  if (mechanism !== SCRAM_SHA_256) {
    throw new ScramError(`Client asked for unsupported SASL mechanism "${mechanism}"`);
  }

  const serverFirst = scram.firstMessage(data);
  const continuePayload = Buffer.alloc(4 + Buffer.byteLength(serverFirst));
  continuePayload.writeInt32BE(AuthRequest.SaslContinue, 0);
  continuePayload.write(serverFirst, 4, "utf8");
  stream.write(encodeMessage(BackendMessage.Authentication, continuePayload));

  const final = await expectPassword(framed);
  const serverFinal = scram.finalMessage(final.payload.toString("utf8"));

  const finalPayload = Buffer.alloc(4 + Buffer.byteLength(serverFinal));
  finalPayload.writeInt32BE(AuthRequest.SaslFinal, 0);
  finalPayload.write(serverFinal, 4, "utf8");
  stream.write(encodeMessage(BackendMessage.Authentication, finalPayload));
}

async function expectPassword(framed: FramedStream): Promise<RawMessage> {
  const message = await framed.next();
  if (!message) throw new ScramError("Client disconnected during authentication");
  if (message.type !== FrontendMessage.PasswordMessage) {
    throw new ScramError(`Expected a password message, got type ${message.type}`);
  }
  return message;
}

/**
 * One client connection in transaction mode.
 *
 * A server connection is taken on the client's first message and handed back
 * the moment the backend reports `ReadyForQuery` with an idle transaction
 * status. Between those two points the client owns it exclusively, which is
 * what makes a transaction atomic despite the sharing.
 */
class PooledSession {
  private holding: ServerConnection | null = null;
  private acquiring = false;
  private readonly queued: Buffer[] = [];
  private readonly reader = new MessageReader(false);
  private closed = false;

  constructor(
    private readonly stream: Duplex,
    leftover: Buffer,
    private readonly pool: ProjectPool,
    private readonly logger: Logger,
    private readonly onClose: () => void,
  ) {
    if (leftover.length > 0) this.reader.push(leftover);
  }

  currentBackend(): ServerConnection | null {
    return this.holding;
  }

  start(): void {
    this.stream.on("data", (chunk: Buffer) => this.onClientData(chunk));
    this.stream.on("close", () => this.teardown());
    this.stream.on("error", () => this.teardown());
    // Anything that arrived alongside the last auth message.
    this.pump();
  }

  private onClientData(chunk: Buffer): void {
    this.reader.push(chunk);
    this.pump();
  }

  private pump(): void {
    for (;;) {
      if (this.closed) return;

      let message: RawMessage | null;
      try {
        message = this.reader.next();
      } catch (err) {
        this.logger.warn({ err }, "client protocol error");
        this.teardown();
        return;
      }
      if (!message) return;

      if (message.type === FrontendMessage.Terminate) {
        this.teardown();
        return;
      }

      if (this.holding) {
        this.holding.send(message.raw);
        continue;
      }

      // No server assigned. Queue and acquire; the queue preserves order across
      // the await, which matters for an extended-protocol sequence that arrives
      // in one chunk.
      this.queued.push(message.raw);
      if (!this.acquiring) void this.acquire();
    }
  }

  private async acquire(): Promise<void> {
    this.acquiring = true;
    try {
      const connection = await this.pool.acquire();
      if (this.closed) {
        this.pool.release(connection);
        return;
      }

      connection.onMessage = (message) => this.onServerMessage(connection, message);
      this.holding = connection;

      const queued = this.queued.splice(0);
      for (const raw of queued) connection.send(raw);
    } catch (err) {
      this.logger.warn({ err }, "could not acquire a pooled connection");
      if (!this.closed) {
        this.stream.write(
          encodeErrorResponse({
            code: "53300", // too_many_connections
            message: err instanceof Error ? err.message : "No pooled connection available.",
            hint: "Raise JP_POOL_SIZE, or use the direct connection string.",
          }),
        );
        this.stream.write(encodeReadyForQuery(TransactionStatus.Idle));
      }
      this.queued.length = 0;
    } finally {
      this.acquiring = false;
      // More may have arrived while we were waiting.
      if (!this.closed && this.holding && this.queued.length > 0) {
        for (const raw of this.queued.splice(0)) this.holding.send(raw);
      }
    }
  }

  private onServerMessage(connection: ServerConnection, message: RawMessage): void {
    if (this.closed) return;
    this.stream.write(message.raw);

    if (message.type !== BackendMessage.ReadyForQuery) return;

    const status = message.payload.readUInt8(0);
    // 'T' means a transaction is open and 'E' that it failed but is still open;
    // in both cases the client still owns this connection. Only 'I' — no
    // transaction in progress — makes it safe to hand to somebody else.
    if (status !== TransactionStatus.Idle) return;

    this.holding = null;
    this.pool.release(connection);

    if (this.queued.length > 0 && !this.acquiring) void this.acquire();
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.holding) {
      // The client vanished without ending its transaction. Returning this
      // connection to the pool would hand the next client an open transaction,
      // so it is discarded instead.
      this.pool.discard(this.holding);
      this.holding = null;
    }

    this.stream.destroy();
    this.onClose();
  }
}
