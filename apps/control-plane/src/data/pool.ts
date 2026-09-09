import pg from "pg";
import { and, eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { credentials, projects } from "../db/schema.js";
import { decryptSecret } from "../lib/crypto.js";
import type { Logger } from "../logger.js";
import { ProjectError } from "../projects/service.js";

const IDLE_POOL_TTL_MS = 5 * 60_000;

interface Entry {
  pool: pg.Pool;
  lastUsedAt: number;
  port: number;
}

/**
 * Connection pools to the projects' own databases, for the data browser.
 *
 * The control plane connects directly to the container port rather than through
 * the router. That is deliberate: the browser needs session semantics — a
 * cursor, a `SET statement_timeout`, a transaction around a multi-statement
 * script — and transaction pooling explicitly does not provide them. Going
 * direct also means the data browser keeps working while the router is down.
 *
 * Pools are opened lazily and closed after a few minutes idle, so a project
 * nobody is looking at costs nothing.
 */
export class DataPoolManager {
  private readonly entries = new Map<string, Entry>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.entries.values()].map((e) => e.pool.end().catch(() => {})));
    this.entries.clear();
  }

  /**
   * Run something against a project's database on a dedicated client.
   *
   * A client rather than the pool's convenience method, because the caller
   * often needs several statements to land on the same connection — setting a
   * timeout, then querying, is two statements that only mean anything together.
   */
  async withClient<T>(projectId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const pool = await this.poolFor(projectId);
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  /** Run one statement with the configured timeout applied. */
  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    projectId: string,
    text: string,
    values: unknown[] = [],
    opts: { timeoutMs?: number } = {},
  ): Promise<pg.QueryResult<R>> {
    return this.withClient(projectId, async (client) => {
      const timeout = opts.timeoutMs ?? this.config.data.statementTimeoutMs;
      // Every statement the UI issues is bounded. Without this, one careless
      // `select *` on a big table pins a connection until someone notices.
      await client.query(`SET statement_timeout = ${Number(timeout)}`);
      return client.query<R>(text, values as never[]);
    });
  }

  /** Drop a project's pool, e.g. after it restarts on a different port. */
  async evict(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    this.entries.delete(projectId);
    await entry.pool.end().catch(() => {});
  }

  private async poolFor(projectId: string): Promise<pg.Pool> {
    const row = this.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();

    if (!row || row.deletedAt) throw new ProjectError("not_found", "No such project.");
    if (row.state !== "running") {
      throw new ProjectError("invalid_state", `Project is ${row.state}; its database is not reachable.`);
    }
    if (row.hostPort === null) {
      throw new ProjectError("invalid_state", "Project has no published port.");
    }

    const existing = this.entries.get(projectId);
    if (existing) {
      // A restarted project can land on a different port; a stale pool would
      // keep trying the old one.
      if (existing.port === row.hostPort) {
        existing.lastUsedAt = Date.now();
        return existing.pool;
      }
      this.entries.delete(projectId);
      void existing.pool.end().catch(() => {});
    }

    const credential = this.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.projectId, projectId), eq(credentials.isPrimary, true)))
      .get();
    if (!credential) throw new ProjectError("not_found", "Project has no stored credentials.");

    const pool = new pg.Pool({
      host: this.config.data.connectHost,
      port: row.hostPort,
      user: credential.role,
      password: decryptSecret(credential.passwordEnc, this.config.masterKey),
      database: credential.database,
      // Return every value as the text Postgres itself would render, rather
      // than letting pg coerce into JS types. A data browser should show what
      // is in the column: 1e400::numeric, a timestamp's exact precision, an
      // int8 beyond Number.MAX_SAFE_INTEGER. Parsing them first loses all of
      // that, and the UI sends text back on edit anyway.
      types: { getTypeParser: () => (value: string) => value },
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "justpostgres-studio",
    });

    // A pool that emits an unhandled 'error' takes the process down with it.
    pool.on("error", (err) => {
      this.logger.warn({ err, projectId, ref: row.ref }, "idle data client errored");
    });

    this.entries.set(projectId, { pool, lastUsedAt: Date.now(), port: row.hostPort });
    this.logger.debug({ projectId, ref: row.ref, port: row.hostPort }, "opened data pool");
    return pool;
  }

  private sweep(): void {
    const cutoff = Date.now() - IDLE_POOL_TTL_MS;
    for (const [projectId, entry] of this.entries) {
      if (entry.lastUsedAt < cutoff) {
        this.entries.delete(projectId);
        void entry.pool.end().catch(() => {});
        this.logger.debug({ projectId }, "closed idle data pool");
      }
    }
  }
}
