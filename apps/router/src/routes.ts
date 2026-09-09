import Database from "better-sqlite3";
import { decryptSecret } from "@justpostgres/secrets";
import type { RouterConfig } from "./config.js";
import type { Logger } from "./logger.js";

export interface Route {
  projectId: string;
  ref: string;
  name: string;
  state: string;
  /** Where the project's Postgres actually listens. */
  host: string;
  port: number;
  /** Primary role and database, used to rewrite the startup packet. */
  role: string;
  database: string;
  /** Decrypted; needed only by the pooled path, which authenticates on its own. */
  password: string;
}

interface ProjectCredentialRow {
  id: string;
  ref: string;
  name: string;
  state: string;
  host_port: number | null;
  role: string | null;
  database: string | null;
  password_enc: string | null;
}

/**
 * Where the router gets its routing table.
 *
 * It reads the control plane's SQLite file directly, read-only, rather than
 * asking the control plane over HTTP. That is deliberate: the router is the
 * data path. Every database on the host is unreachable while it is down, so it
 * must not acquire a dependency on the availability of the process that manages
 * it. A control plane that is crashed, upgrading, or simply stopped should not
 * take every application's database with it.
 *
 * SQLite in WAL mode supports concurrent readers across processes, so this
 * costs the control plane nothing.
 */
export class RouteStore {
  private readonly db: Database.Database;
  private byRef = new Map<string, Route>();
  private timer: NodeJS.Timeout | null = null;
  private lastRefreshAt = 0;
  private lastError: string | null = null;

  constructor(
    private readonly config: RouterConfig,
    private readonly logger: Logger,
  ) {
    this.db = new Database(config.sqlitePath, { readonly: true, fileMustExist: true });
    this.db.pragma("busy_timeout = 5000");
  }

  start(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.config.routeRefreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.db.close();
  }

  /**
   * Resolve a project ref.
   *
   * A miss triggers an immediate refresh before giving up: a project created
   * two seconds ago should be connectable now, not after the next poll. Misses
   * are rare and cheap, so this costs nothing in the common case.
   */
  lookup(ref: string): Route | null {
    const hit = this.byRef.get(ref);
    if (hit) return hit;

    if (Date.now() - this.lastRefreshAt > 500) {
      this.refresh();
      return this.byRef.get(ref) ?? null;
    }
    return null;
  }

  size(): number {
    return this.byRef.size;
  }

  status(): { routes: number; lastRefreshAt: number; lastError: string | null } {
    return { routes: this.byRef.size, lastRefreshAt: this.lastRefreshAt, lastError: this.lastError };
  }

  private refresh(): void {
    try {
      const rows = this.db
        .prepare(
          `SELECT p.id, p.ref, p.name, p.state, p.host_port,
                  c.role, c.database, c.password_enc
             FROM projects p
             LEFT JOIN credentials c
               ON c.project_id = p.id AND c.is_primary = 1
            WHERE p.deleted_at IS NULL`,
        )
        .all() as ProjectCredentialRow[];

      const next = new Map<string, Route>();
      for (const row of rows) {
        if (row.host_port === null || row.role === null || row.password_enc === null) continue;

        let password: string;
        try {
          password = decryptSecret(row.password_enc, this.config.masterKey);
        } catch (err) {
          // Almost always a mismatched JP_MASTER_KEY between the router and the
          // control plane. Skip the route rather than failing the whole refresh
          // and taking every other project offline with it.
          this.logger.error(
            { ref: row.ref, err: err instanceof Error ? err.message : String(err) },
            "could not decrypt project credentials; project is unroutable",
          );
          continue;
        }

        next.set(row.ref, {
          projectId: row.id,
          ref: row.ref,
          name: row.name,
          state: row.state,
          host: this.config.backendHost,
          port: row.host_port,
          role: row.role,
          database: row.database ?? "postgres",
          password,
        });
      }

      const previous = this.byRef.size;
      this.byRef = next;
      this.lastRefreshAt = Date.now();
      this.lastError = null;

      if (previous !== next.size) {
        this.logger.info({ routes: next.size }, "routing table changed");
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      // Keep serving the last known good table. A transient read failure must
      // not disconnect every project.
      this.logger.error({ err }, "route refresh failed; serving the previous table");
    }
  }
}
