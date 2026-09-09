import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { ProjectMetrics, MetricSample, SlowQuery, IndexHint } from "@justpostgres/shared";
import type { DataPoolManager } from "../data/pool.js";
import type { Db } from "../db/index.js";
import { metricSamples, projects } from "../db/schema.js";
import type { Logger } from "../logger.js";

/**
 * What a project's database is actually doing.
 *
 * ARCHITECTURE §9 chose to surface this in the UI rather than require a
 * Prometheus stack, and that shapes what belongs here: not everything Postgres
 * exposes, but the handful of numbers that explain the problems people
 * actually hit on a small host — connections running out, a disk filling, a
 * query holding a lock, an index nobody uses taking up space, and archiving
 * that has quietly stopped.
 *
 * Everything is read from the project's own catalogue on demand. The only
 * thing stored is a periodic size and connection sample, because "is this
 * growing, and how fast" cannot be answered from a single reading and is the
 * question that decides whether a host survives the month.
 */

/** Sampled often enough to see a trend, rarely enough to be free. */
const SAMPLE_INTERVAL_MS = 15 * 60_000;
const SAMPLE_RETENTION_MS = 30 * 24 * 3_600_000;

export class MetricsService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly pools: DataPoolManager,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sampleAll(), SAMPLE_INTERVAL_MS);
    this.timer.unref();
    // Not on boot: a control plane that restarts often would otherwise write a
    // sample every restart and make the trend line meaningless.
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Everything the UI shows for one project, in one pass. */
  async snapshot(projectId: string): Promise<ProjectMetrics> {
    const [activity, sizes, archiver] = await Promise.all([
      this.activity(projectId),
      this.sizes(projectId),
      this.archiver(projectId),
    ]);

    // These two can be absent — `pg_stat_statements` needs the extension and a
    // preload — so they must not take the rest of the page down with them.
    const [slowQueries, indexHints] = await Promise.all([
      this.slowQueries(projectId).catch(() => null),
      this.indexHints(projectId).catch(() => []),
    ]);

    return {
      ...activity,
      ...sizes,
      archiver,
      slowQueries,
      indexHints,
      history: this.history(projectId),
      sampledAt: Date.now(),
    };
  }

  history(projectId: string): MetricSample[] {
    return this.db
      .select()
      .from(metricSamples)
      .where(eq(metricSamples.projectId, projectId))
      .orderBy(desc(metricSamples.at))
      .limit(500)
      .all()
      .reverse()
      .map((row) => ({
        at: row.at,
        databaseBytes: row.databaseBytes,
        connections: row.connections,
      }));
  }

  /**
   * Connections, transaction health and the longest thing currently running.
   *
   * `idle in transaction` is called out separately because it is the specific
   * state that looks like nothing and holds locks, pins the oldest transaction
   * id, and stops vacuum from cleaning up — a connection pool leaking these is
   * the most common way a healthy-looking database quietly degrades.
   */
  private async activity(projectId: string) {
    const rows = await this.pools.query<{
      connections: string;
      max_connections: string;
      active: string;
      idle_in_transaction: string;
      longest_query_seconds: string | null;
      longest_transaction_seconds: string | null;
      cache_hit_ratio: string | null;
    }>(
      projectId,
      `select
         (select count(*) from pg_stat_activity where backend_type = 'client backend')::text as connections,
         current_setting('max_connections') as max_connections,
         (select count(*) from pg_stat_activity
            where backend_type = 'client backend' and state = 'active')::text as active,
         (select count(*) from pg_stat_activity
            where state = 'idle in transaction')::text as idle_in_transaction,
         (select extract(epoch from max(now() - query_start))::text from pg_stat_activity
            where state = 'active' and backend_type = 'client backend') as longest_query_seconds,
         (select extract(epoch from max(now() - xact_start))::text from pg_stat_activity
            where xact_start is not null) as longest_transaction_seconds,
         (select (sum(blks_hit)::float / nullif(sum(blks_hit + blks_read), 0))::text
            from pg_stat_database) as cache_hit_ratio`,
    );

    const row = rows.rows[0];
    return {
      connections: Number(row?.connections ?? 0),
      maxConnections: Number(row?.max_connections ?? 0),
      activeQueries: Number(row?.active ?? 0),
      idleInTransaction: Number(row?.idle_in_transaction ?? 0),
      longestQuerySeconds: numberOrNull(row?.longest_query_seconds),
      longestTransactionSeconds: numberOrNull(row?.longest_transaction_seconds),
      cacheHitRatio: numberOrNull(row?.cache_hit_ratio),
    };
  }

  private async sizes(projectId: string) {
    const rows = await this.pools.query<{ database_bytes: string; wal_bytes: string }>(
      projectId,
      `select
         (select sum(pg_database_size(datname))::text from pg_database where datallowconn) as database_bytes,
         (select coalesce(sum(size), 0)::text from pg_ls_waldir()) as wal_bytes`,
    );
    return {
      databaseBytes: Number(rows.rows[0]?.database_bytes ?? 0),
      walBytes: Number(rows.rows[0]?.wal_bytes ?? 0),
    };
  }

  /**
   * WAL archiving, which is the metric that matters most and shows least.
   *
   * A project whose archiving has been failing for a week looks completely
   * healthy until the moment someone needs to restore it — §9 calls this an
   * alert-level condition rather than a metric, and this is where the alert
   * gets its facts.
   */
  private async archiver(projectId: string) {
    const rows = await this.pools.query<{
      archived_count: string;
      failed_count: string;
      last_archived_time: string | null;
      last_failed_time: string | null;
      last_failed_wal: string | null;
    }>(
      projectId,
      `select archived_count::text, failed_count::text,
              extract(epoch from last_archived_time)::text as last_archived_time,
              extract(epoch from last_failed_time)::text as last_failed_time,
              last_failed_wal
         from pg_stat_archiver`,
    );

    const row = rows.rows[0];
    const lastArchivedAt = numberOrNull(row?.last_archived_time);
    const lastFailedAt = numberOrNull(row?.last_failed_time);

    return {
      archivedCount: Number(row?.archived_count ?? 0),
      failedCount: Number(row?.failed_count ?? 0),
      lastArchivedAt: lastArchivedAt === null ? null : Math.round(lastArchivedAt * 1000),
      lastFailedAt: lastFailedAt === null ? null : Math.round(lastFailedAt * 1000),
      lastFailedWal: row?.last_failed_wal ?? null,
      // Failing *now* means the most recent attempt failed, not that one ever
      // did. A single failure followed by success is normal; a failure that is
      // more recent than the last success is archiving being broken.
      failingNow:
        lastFailedAt !== null && (lastArchivedAt === null || lastFailedAt > lastArchivedAt),
    };
  }

  /** Top queries by total time. Null when `pg_stat_statements` is not installed. */
  private async slowQueries(projectId: string): Promise<SlowQuery[] | null> {
    const installed = await this.pools.query<{ exists: string }>(
      projectId,
      "select (count(*) > 0)::text as exists from pg_extension where extname = 'pg_stat_statements'",
    );
    if (installed.rows[0]?.exists !== "true") return null;

    const rows = await this.pools.query<{
      query: string;
      calls: string;
      total_ms: string;
      mean_ms: string;
      rows: string;
    }>(
      projectId,
      `select query, calls::text, round(total_exec_time)::text as total_ms,
              round(mean_exec_time::numeric, 2)::text as mean_ms, rows::text
         from pg_stat_statements
        where query not like '%pg_stat_statements%'
        order by total_exec_time desc
        limit 10`,
    );

    return rows.rows.map((r) => ({
      // Long enough to recognise the query, short enough not to paste a
      // thousand-line statement into a table cell.
      query: r.query.replace(/\s+/g, " ").slice(0, 400),
      calls: Number(r.calls),
      totalMs: Number(r.total_ms),
      meanMs: Number(r.mean_ms),
      rows: Number(r.rows),
    }));
  }

  /**
   * Indexes that cost writes and return nothing, and tables that need vacuum.
   *
   * Both are advice rather than alarm, and both are the kind of thing nobody
   * looks for until a database is already slow.
   */
  private async indexHints(projectId: string): Promise<IndexHint[]> {
    const unused = await this.pools.query<{
      schema: string;
      table: string;
      index: string;
      size_bytes: string;
    }>(
      projectId,
      `select s.schemaname as schema, s.relname as table, s.indexrelname as index,
              pg_relation_size(s.indexrelid)::text as size_bytes
         from pg_stat_user_indexes s
         join pg_index i on i.indexrelid = s.indexrelid
        where s.idx_scan = 0
          and not i.indisunique
          and not i.indisprimary
          and pg_relation_size(s.indexrelid) > 1024 * 1024
        order by pg_relation_size(s.indexrelid) desc
        limit 10`,
    );

    const bloated = await this.pools.query<{
      schema: string;
      table: string;
      dead: string;
      live: string;
    }>(
      projectId,
      `select schemaname as schema, relname as table, n_dead_tup::text as dead, n_live_tup::text as live
         from pg_stat_user_tables
        where n_dead_tup > 10000 and n_dead_tup > n_live_tup * 0.2
        order by n_dead_tup desc
        limit 10`,
    );

    return [
      ...unused.rows.map<IndexHint>((r) => ({
        kind: "unused_index",
        target: `${r.schema}.${r.index}`,
        detail:
          `Never used since statistics were last reset, and costs ${formatBytes(Number(r.size_bytes))} ` +
          `plus a write on every insert into ${r.schema}.${r.table}.`,
      })),
      ...bloated.rows.map<IndexHint>((r) => ({
        kind: "needs_vacuum",
        target: `${r.schema}.${r.table}`,
        detail: `${Number(r.dead).toLocaleString()} dead rows against ${Number(
          r.live,
        ).toLocaleString()} live. Autovacuum may be blocked by a long-running transaction.`,
      })),
    ];
  }

  /** One row per running project, plus retention. */
  private async sampleAll(): Promise<void> {
    const rows = this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.state, "running"))
      .all();

    for (const { id } of rows) {
      try {
        const [activity, sizes] = await Promise.all([this.activity(id), this.sizes(id)]);
        this.db
          .insert(metricSamples)
          .values({
            projectId: id,
            at: Date.now(),
            databaseBytes: sizes.databaseBytes,
            connections: activity.connections,
          })
          .run();
      } catch (err) {
        // A project that is starting, restarting or mid-upgrade will refuse
        // connections, and a missing sample is not worth a log line at warn.
        this.logger.debug({ err, projectId: id }, "could not sample project metrics");
      }
    }

    try {
      this.db
        .delete(metricSamples)
        .where(lt(metricSamples.at, Date.now() - SAMPLE_RETENTION_MS))
        .run();
    } catch (err) {
      this.logger.warn({ err }, "could not expire old metric samples");
    }
  }

  /** Growth over a window, for the "at this rate" line the UI shows. */
  growthBytesPerDay(projectId: string, windowMs = 7 * 24 * 3_600_000): number | null {
    const since = Date.now() - windowMs;
    const rows = this.db
      .select()
      .from(metricSamples)
      .where(and(eq(metricSamples.projectId, projectId), gte(metricSamples.at, since)))
      .orderBy(metricSamples.at)
      .all();

    // Two samples an hour apart would extrapolate a transient into a
    // catastrophe, so a trend is only offered once there is a day of history.
    if (rows.length < 2) return null;
    const first = rows[0]!;
    const last = rows[rows.length - 1]!;
    const days = (last.at - first.at) / 86_400_000;
    if (days < 1) return null;

    return Math.round((last.databaseBytes - first.databaseBytes) / days);
  }
}

function numberOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatBytes(bytes: number): string {
  const mib = 1024 ** 2;
  return bytes >= 1024 * mib ? `${(bytes / (1024 * mib)).toFixed(1)} GB` : `${Math.round(bytes / mib)} MB`;
}
