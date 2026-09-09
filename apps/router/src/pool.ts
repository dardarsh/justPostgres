import { ServerConnection } from "./backend.js";
import type { RouterConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { encodeMessage, FrontendMessage } from "./protocol.js";
import type { Route } from "./routes.js";

export interface PoolStats {
  ref: string;
  size: number;
  idle: number;
  busy: number;
  waiting: number;
  opened: number;
  closed: number;
}

interface Waiter {
  resolve: (connection: ServerConnection) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A pool of authenticated server connections for one project.
 *
 * Bounded on purpose. The point of transaction pooling is that a project with a
 * `max_connections` of 100 can serve a serverless deployment that opens
 * thousands of short-lived client connections, by decoupling the two counts.
 * An unbounded pool would just move the exhaustion one layer up.
 */
export class ProjectPool {
  private readonly idle: ServerConnection[] = [];
  private readonly all = new Set<ServerConnection>();
  private readonly waiters: Waiter[] = [];
  private opening = 0;
  private opened = 0;
  private closed = 0;
  private cachedParameters: Record<string, string> | null = null;

  constructor(
    private readonly route: Route,
    private readonly config: RouterConfig,
    private readonly logger: Logger,
  ) {}

  /** The route can change (a project restarts on a new port); keep the pool current. */
  updateRoute(route: Route): void {
    if (route.port !== this.route.port || route.password !== this.route.password) {
      this.logger.info({ ref: route.ref }, "project route changed; draining pool");
      this.drain();
    }
    Object.assign(this.route, route);
  }

  async acquire(): Promise<ServerConnection> {
    const ready = this.idle.pop();
    if (ready && !ready.isClosed) {
      ready.lastUsedAt = Date.now();
      return ready;
    }

    if (this.all.size + this.opening < this.config.pool.size) {
      return this.open();
    }

    // At capacity: wait for a release rather than exceeding max_connections.
    return new Promise<ServerConnection>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(
          new Error(
            `Timed out waiting for a pooled connection to "${this.route.name}" ` +
              `(pool size ${this.config.pool.size}, all busy).`,
          ),
        );
      }, this.config.pool.connectTimeoutMs);

      this.waiters.push({ resolve, reject, timer });
    });
  }

  release(connection: ServerConnection): void {
    connection.onMessage = null;
    connection.lastUsedAt = Date.now();

    if (connection.isClosed) {
      this.forget(connection);
      return;
    }

    // A reset statement guarantees no session state leaks between clients, at
    // the cost of a round trip per transaction. Empty by default, matching
    // PgBouncer and Supavisor: transaction pooling's well-known contract is
    // that session state does not survive a transaction, and the UI hands out a
    // direct connection string for anything that needs it.
    if (this.config.pool.resetQuery) {
      connection.send(
        encodeMessage(
          FrontendMessage.Query,
          Buffer.from(`${this.config.pool.resetQuery}\0`, "utf8"),
        ),
      );
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(connection);
      return;
    }

    this.idle.push(connection);
  }

  /** Discard a connection whose state we cannot vouch for. */
  discard(connection: ServerConnection): void {
    connection.onMessage = null;
    connection.destroy();
    this.forget(connection);
  }

  /**
   * ParameterStatus values to replay to a client at login.
   *
   * A pooled client is not bound to a backend, so the router has to answer with
   * something. It uses a real connection's values rather than inventing them:
   * clients parse `server_version` and `integer_datetimes` and will misbehave
   * on a plausible-looking guess.
   */
  async parameters(): Promise<Record<string, string>> {
    if (this.cachedParameters) return this.cachedParameters;
    const connection = await this.acquire();
    this.cachedParameters = { ...connection.parameters };
    this.release(connection);
    return this.cachedParameters;
  }

  sweepIdle(): void {
    const cutoff = Date.now() - this.config.pool.idleTimeoutMs;
    for (let i = this.idle.length - 1; i >= 0; i--) {
      const connection = this.idle[i]!;
      if (connection.lastUsedAt < cutoff || connection.isClosed) {
        this.idle.splice(i, 1);
        connection.destroy();
        this.forget(connection);
      }
    }
  }

  drain(): void {
    for (const connection of this.all) connection.destroy();
    this.all.clear();
    this.idle.length = 0;
    this.cachedParameters = null;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Pool was drained"));
    }
  }

  stats(): PoolStats {
    return {
      ref: this.route.ref,
      size: this.all.size,
      idle: this.idle.length,
      busy: this.all.size - this.idle.length,
      waiting: this.waiters.length,
      opened: this.opened,
      closed: this.closed,
    };
  }

  private async open(): Promise<ServerConnection> {
    this.opening++;
    try {
      const connection = await ServerConnection.open(this.route, this.config, this.logger);
      this.all.add(connection);
      this.opened++;

      connection.onClose = () => {
        this.closed++;
        const index = this.idle.indexOf(connection);
        if (index >= 0) this.idle.splice(index, 1);
        this.all.delete(connection);
      };

      return connection;
    } finally {
      this.opening--;
    }
  }

  private forget(connection: ServerConnection): void {
    this.all.delete(connection);
    const index = this.idle.indexOf(connection);
    if (index >= 0) this.idle.splice(index, 1);
  }
}

/** One pool per project, created on first use. */
export class PoolManager {
  private readonly pools = new Map<string, ProjectPool>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: RouterConfig,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      for (const pool of this.pools.values()) pool.sweepIdle();
    }, Math.max(5000, this.config.pool.idleTimeoutMs / 4));
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const pool of this.pools.values()) pool.drain();
    this.pools.clear();
  }

  forRoute(route: Route): ProjectPool {
    const existing = this.pools.get(route.projectId);
    if (existing) {
      existing.updateRoute(route);
      return existing;
    }

    const pool = new ProjectPool(
      { ...route },
      this.config,
      this.logger.child({ ref: route.ref }),
    );
    this.pools.set(route.projectId, pool);
    return pool;
  }

  stats(): PoolStats[] {
    return [...this.pools.values()].map((p) => p.stats());
  }
}
