import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { CancelRegistry } from "./cancel.js";
import type { RouterConfig } from "./config.js";
import { FramedStream } from "./framed.js";
import type { Logger } from "./logger.js";
import {
  BackendMessage,
  CANCEL_REQUEST_CODE,
  encodeCancelRequest,
  encodeErrorResponse,
  encodeStartupPacket,
  GSSENC_REQUEST_CODE,
  parseBackendKeyData,
  parseErrorResponse,
  parseStartupPacket,
  PROTOCOL_VERSION_3,
  SSL_REQUEST_CODE,
} from "./protocol.js";
import { resolveRoute, RoutingError } from "./resolve.js";
import type { RouteStore } from "./routes.js";

export interface SessionStats {
  accepted: number;
  active: number;
  rejected: number;
  cancels: number;
}

/**
 * Session mode: one client connection, one backend connection, relayed.
 *
 * The router reads the startup exchange to decide which project the connection
 * belongs to, rewrites the username to strip the routing suffix, and then gets
 * out of the way — after the first ReadyForQuery it stops parsing entirely and
 * pipes raw bytes in both directions.
 *
 * Authentication is not intercepted. The backend performs SCRAM directly with
 * the client and the router relays it, which means the router never sees the
 * password on this path and never has to keep up with changes to Postgres
 * authentication. Rewriting the startup username is safe: SCRAM's proof is
 * computed over the SASL exchange, not over the startup packet, and Postgres
 * looks up the role from the startup packet — so a client authenticating as
 * `postgres.abc123` proves possession of the password for `postgres`.
 */
export class SessionServer {
  private readonly server: net.Server;
  private readonly stats: SessionStats = { accepted: 0, active: 0, rejected: 0, cancels: 0 };
  private readonly secureContext: tls.SecureContext | null;

  constructor(
    private readonly config: RouterConfig,
    private readonly store: RouteStore,
    private readonly cancels: CancelRegistry,
    private readonly logger: Logger,
  ) {
    this.secureContext = config.tls
      ? tls.createSecureContext({ cert: config.tls.cert, key: config.tls.key })
      : null;

    this.server = net.createServer((socket) => {
      void this.handle(socket).catch((err) => {
        this.logger.debug({ err }, "session connection ended with an error");
        socket.destroy();
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.sessionPort, this.config.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  getStats(): SessionStats {
    return { ...this.stats };
  }

  private async handle(socket: net.Socket): Promise<void> {
    socket.setNoDelay(true);
    this.stats.accepted++;

    let stream: Duplex = socket;
    let framed = new FramedStream(stream, true);
    let servername: string | null = null;

    // --- startup exchange ---------------------------------------------------
    // SSLRequest and GSSENCRequest can each precede the real StartupMessage, so
    // this is a loop rather than a single read.
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

        // Push back anything already buffered before handing the socket to TLS.
        // libpq waits for our single byte before sending ClientHello, but a
        // client that does not would otherwise lose its first record.
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
        this.stats.cancels++;
        this.forwardCancel(packet.cancel.processId, packet.cancel.secretKey);
        socket.end();
        return;
      }

      parameters = packet.parameters;
      break;
    }

    // --- routing ------------------------------------------------------------
    let resolution;
    try {
      resolution = resolveRoute(this.store, this.config, { servername, parameters });
    } catch (err) {
      this.stats.rejected++;
      this.reject(stream, err);
      return;
    }

    const { route, role, mode } = resolution;
    this.logger.debug({ ref: route.ref, mode, role }, "session routed");

    // --- backend ------------------------------------------------------------
    let backend: net.Socket;
    try {
      backend = await connect(route.host, route.port, this.config.pool.connectTimeoutMs);
    } catch (err) {
      this.stats.rejected++;
      this.logger.warn(
        { ref: route.ref, host: route.host, port: route.port, err },
        "could not reach project backend",
      );
      this.reject(
        stream,
        new RoutingError(
          "08006",
          `Could not reach the database for project "${route.name}".`,
          "The container may be starting, stopped, or unhealthy.",
        ),
      );
      return;
    }

    this.stats.active++;
    backend.setNoDelay(true);

    // The backend knows nothing about routing suffixes.
    backend.write(encodeStartupPacket(PROTOCOL_VERSION_3, { ...parameters, user: role }));

    // Client to backend needs no inspection in session mode, so it can be a raw
    // pipe from here — including the password message the client is about to
    // send.
    const clientPending = framed.detach();
    if (clientPending.length > 0) backend.write(clientPending);
    stream.pipe(backend);

    // Backend to client is framed only until the first ReadyForQuery, which is
    // long enough to see BackendKeyData. After that it is a raw pipe: the
    // steady-state path does no parsing at all.
    const backendFramed = new FramedStream(backend, false);
    let clientKey: { processId: number; secretKey: number } | null = null;

    try {
      for (;;) {
        const message = await backendFramed.next();
        if (!message) break;

        stream.write(message.raw);

        if (message.type === BackendMessage.BackendKeyData) {
          const key = parseBackendKeyData(message.payload);
          clientKey = key;
          // The client is handed the backend's real key, so the registry maps
          // it straight back to the backend that issued it.
          this.cancels.register(key.processId, key.secretKey, {
            host: route.host,
            port: route.port,
            processId: key.processId,
            secretKey: key.secretKey,
          });
        }

        if (message.type === BackendMessage.ReadyForQuery) break;
      }
    } catch (err) {
      this.logger.debug({ err, ref: route.ref }, "backend failed during startup");
    }

    const backendPending = backendFramed.detach();
    if (backendPending.length > 0) stream.write(backendPending);
    backend.pipe(stream);

    const teardown = () => {
      if (clientKey) this.cancels.unregister(clientKey.processId, clientKey.secretKey);
      this.stats.active--;
      backend.destroy();
      stream.destroy();
    };

    let closed = false;
    const once = () => {
      if (closed) return;
      closed = true;
      teardown();
    };

    stream.on("close", once);
    backend.on("close", once);
    stream.on("error", once);
    backend.on("error", once);
  }

  /**
   * Forward a cancellation to the backend that issued the key.
   *
   * Failures are silent by design: CancelRequest has no reply in the protocol,
   * and the client has already stopped listening.
   */
  private forwardCancel(processId: number, secretKey: number): void {
    const target = this.cancels.lookup(processId, secretKey);
    if (!target) {
      this.logger.debug({ processId }, "cancel request for an unknown key");
      return;
    }

    const socket = net.connect({ host: target.host, port: target.port }, () => {
      socket.write(encodeCancelRequest(target.processId, target.secretKey));
      socket.end();
    });
    socket.on("error", (err) => this.logger.debug({ err }, "cancel forward failed"));
  }

  /** Refuse a connection with a real Postgres error, not a dropped socket. */
  private reject(stream: Duplex, err: unknown): void {
    if (err instanceof RoutingError) {
      stream.write(encodeErrorResponse({ code: err.code, message: err.message, hint: err.hint }));
    } else {
      stream.write(
        encodeErrorResponse({
          code: "XX000",
          message: "The router could not establish a connection.",
        }),
      );
      this.logger.error({ err }, "unexpected routing failure");
    }
    stream.end();
  }
}

export function connect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port} after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve(socket);
    });
    function onError(err: Error) {
      clearTimeout(timer);
      reject(err);
    }
    socket.once("error", onError);
  });
}

export { parseErrorResponse };
