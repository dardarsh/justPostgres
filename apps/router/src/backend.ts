import type net from "node:net";
import type { RouterConfig } from "./config.js";
import type { Logger } from "./logger.js";
import {
  AuthRequest,
  BackendMessage,
  encodeMessage,
  encodeStartupPacket,
  FrontendMessage,
  MessageReader,
  parseAuthRequest,
  parseBackendKeyData,
  parseErrorResponse,
  parseParameterStatus,
  PROTOCOL_VERSION_3,
  type RawMessage,
} from "./protocol.js";
import type { Route } from "./routes.js";
import {
  encodeSaslInitialResponse,
  SCRAM_SHA_256,
  ScramClient,
  ScramError,
} from "./scram.js";
import { connect } from "./session.js";

export class BackendError extends Error {
  constructor(
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

let nextConnectionId = 1;

/**
 * A pooled connection to a project's Postgres, authenticated by the router
 * itself rather than by relaying a client's credentials.
 *
 * Unlike session mode, this connection outlives any particular client, so its
 * messages are framed for its whole lifetime — the router has to see
 * ReadyForQuery to know when the connection is free again. That per-message
 * framing is the price of transaction pooling.
 */
export class ServerConnection {
  readonly id = nextConnectionId++;
  readonly parameters: Record<string, string> = {};
  backendKey: { processId: number; secretKey: number } | null = null;

  /** Where framed messages go. Reassigned as clients take and release this connection. */
  onMessage: ((message: RawMessage) => void) | null = null;
  onClose: (() => void) | null = null;

  private readonly reader = new MessageReader(false);
  private closed = false;
  createdAt = Date.now();
  lastUsedAt = Date.now();

  private constructor(
    readonly socket: net.Socket,
    readonly route: Route,
    private readonly logger: Logger,
  ) {}

  /**
   * Open and authenticate a connection, returning it idle at ReadyForQuery.
   *
   * The authentication exchange is driven synchronously here rather than
   * through the steady-state message handler, because until it finishes there
   * is no client to hand anything to.
   */
  static async open(route: Route, config: RouterConfig, logger: Logger): Promise<ServerConnection> {
    const socket = await connect(route.host, route.port, config.pool.connectTimeoutMs);
    socket.setNoDelay(true);

    const connection = new ServerConnection(socket, route, logger);
    try {
      await connection.authenticate();
    } catch (err) {
      socket.destroy();
      throw err;
    }

    connection.attach();
    return connection;
  }

  send(data: Buffer): void {
    if (!this.closed) this.socket.write(data);
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Steady state: frame messages and hand them to whoever holds the connection. */
  private attach(): void {
    this.socket.on("data", (chunk: Buffer) => {
      this.reader.push(chunk);
      for (;;) {
        let message: RawMessage | null;
        try {
          message = this.reader.next();
        } catch (err) {
          this.logger.error({ err, id: this.id }, "backend protocol error");
          this.destroy();
          return;
        }
        if (!message) return;
        this.onMessage?.(message);
      }
    });

    const finish = () => {
      if (this.closed) return;
      this.closed = true;
      this.onClose?.();
    };
    this.socket.on("close", finish);
    this.socket.on("error", (err) => {
      this.logger.debug({ err, id: this.id }, "backend socket error");
      finish();
    });
  }

  private authenticate(): Promise<void> {
    const reader = new MessageReader(false);
    const scram = new ScramClient(this.route.password);

    return new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        reader.push(chunk);
        try {
          for (;;) {
            const message = reader.next();
            if (!message) return;

            if (message.type === BackendMessage.ErrorResponse) {
              const fields = parseErrorResponse(message.payload);
              throw new BackendError(
                `Postgres rejected the pooled connection: ${fields["M"] ?? "unknown error"}`,
                fields,
              );
            }

            if (message.type === BackendMessage.Authentication) {
              this.handleAuth(message, scram);
              continue;
            }

            if (message.type === BackendMessage.ParameterStatus) {
              const { name, value } = parseParameterStatus(message.payload);
              this.parameters[name] = value;
              continue;
            }

            if (message.type === BackendMessage.BackendKeyData) {
              this.backendKey = parseBackendKeyData(message.payload);
              continue;
            }

            if (message.type === BackendMessage.ReadyForQuery) {
              cleanup();
              // Anything that arrived in the same chunk after ReadyForQuery
              // belongs to the steady-state reader.
              const leftover = reader.drain();
              if (leftover.length > 0) this.reader.push(leftover);
              resolve();
              return;
            }
          }
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new BackendError("Postgres closed the connection during authentication"));
      };
      const cleanup = () => {
        this.socket.off("data", onData);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
      };

      this.socket.on("data", onData);
      this.socket.on("error", onError);
      this.socket.on("close", onClose);

      this.socket.write(
        encodeStartupPacket(PROTOCOL_VERSION_3, {
          user: this.route.role,
          database: this.route.database,
          application_name: "justpostgres-pooler",
        }),
      );
    });
  }

  private handleAuth(message: RawMessage, scram: ScramClient): void {
    const { code, body } = parseAuthRequest(message.payload);

    switch (code) {
      case AuthRequest.Ok:
        return;

      case AuthRequest.Sasl: {
        const mechanisms = body.toString("utf8").split("\0").filter(Boolean);
        if (!mechanisms.includes(SCRAM_SHA_256)) {
          throw new BackendError(
            `Postgres offered no supported SASL mechanism (got: ${mechanisms.join(", ") || "none"})`,
          );
        }
        this.socket.write(
          encodeMessage(
            FrontendMessage.PasswordMessage,
            encodeSaslInitialResponse(SCRAM_SHA_256, scram.firstMessage()),
          ),
        );
        return;
      }

      case AuthRequest.SaslContinue:
        this.socket.write(
          encodeMessage(
            FrontendMessage.PasswordMessage,
            Buffer.from(scram.finalMessage(body.toString("utf8")), "utf8"),
          ),
        );
        return;

      case AuthRequest.SaslFinal:
        // Proves the far end also knew the password. Skipping this would let
        // anything listening on the port impersonate the database.
        scram.verifyServerSignature(body.toString("utf8"));
        return;

      case AuthRequest.CleartextPassword:
        this.socket.write(
          encodeMessage(
            FrontendMessage.PasswordMessage,
            Buffer.from(`${this.route.password}\0`, "utf8"),
          ),
        );
        return;

      case AuthRequest.Md5Password:
        throw new BackendError(
          "This project's Postgres is configured for md5 authentication, which the pooler does not " +
            "support. Use the direct connection string, or set password_encryption = scram-sha-256.",
        );

      default:
        throw new BackendError(`Unsupported authentication request from Postgres (code ${code})`);
    }
  }
}

export { ScramError };
