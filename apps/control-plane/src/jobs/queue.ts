import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { EnqueueJobRequest, Job, JobProgress, JobState, JobType } from "@justpostgres/shared";
import type { Db } from "../db/index.js";
import { jobs, type JobRow } from "../db/schema.js";

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;

/** Exponential backoff with full jitter, so a burst of failures doesn't retry in lockstep. */
function backoffMs(attempts: number): number {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.floor(Math.random() * ceiling);
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toJob(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type as JobType,
    projectId: row.projectId,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    state: row.state as JobState,
    priority: row.priority,
    runAt: row.runAt,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
    progress: parseJson<JobProgress | null>(row.progress, null),
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export interface HeartbeatResult {
  /** False when the lease was lost — another worker has taken the job. */
  stillOwned: boolean;
  cancelRequested: boolean;
}

export interface JobStats {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

/**
 * Durable, lease-based job queue on SQLite.
 *
 * SQLite has no `SKIP LOCKED`, so claiming is done inside a write transaction:
 * better-sqlite3 is synchronous and SQLite takes a database-level write lock,
 * which means select-then-update is atomic with respect to every other claimer,
 * in this process or another one. That is sufficient at the scale this queue
 * operates at — a handful of jobs an hour on a single node.
 */
export class JobQueue {
  constructor(
    private readonly db: Db,
    private readonly leaseTtlMs: number,
  ) {}

  enqueue(req: EnqueueJobRequest): Job {
    const nowMs = Date.now();
    const row = this.db
      .insert(jobs)
      .values({
        id: randomUUID(),
        type: req.type,
        projectId: req.projectId ?? null,
        payload: JSON.stringify(req.payload ?? {}),
        state: "queued",
        priority: req.priority ?? 0,
        runAt: req.runAt ?? nowMs,
        maxAttempts: req.maxAttempts ?? 3,
        createdAt: nowMs,
        updatedAt: nowMs,
      })
      .returning()
      .get();
    return toJob(row);
  }

  /**
   * Atomically take the next runnable job.
   *
   * "Runnable" covers two cases, and the second is the one that makes the queue
   * survive a crash: a job left in `running` by a worker that died is claimable
   * again once its lease expires. No separate recovery pass is needed — normal
   * polling picks up orphans.
   */
  claim(owner: string): Job | null {
    const nowMs = Date.now();
    const leaseExpiresAt = nowMs + this.leaseTtlMs;

    return this.db.transaction((tx) => {
      const candidate = tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            lt(jobs.attempts, jobs.maxAttempts),
            or(
              and(eq(jobs.state, "queued"), lte(jobs.runAt, nowMs)),
              // Orphaned: still marked running, but nobody is heartbeating it.
              and(eq(jobs.state, "running"), lt(jobs.leaseExpiresAt, nowMs)),
            ),
          ),
        )
        .orderBy(desc(jobs.priority), asc(jobs.runAt))
        .limit(1)
        .get();

      if (!candidate) return null;

      const row = tx
        .update(jobs)
        .set({
          state: "running",
          leaseOwner: owner,
          leaseExpiresAt,
          attempts: sql`${jobs.attempts} + 1`,
          startedAt: sql`coalesce(${jobs.startedAt}, ${nowMs})`,
          updatedAt: nowMs,
        })
        .where(eq(jobs.id, candidate.id))
        .returning()
        .get();

      return row ? toJob(row) : null;
    });
  }

  /** Extend the lease, and report back whether we still hold it and whether a cancel was requested. */
  heartbeat(id: string, owner: string): HeartbeatResult {
    const nowMs = Date.now();
    const row = this.db
      .update(jobs)
      .set({ leaseExpiresAt: nowMs + this.leaseTtlMs, updatedAt: nowMs })
      .where(and(eq(jobs.id, id), eq(jobs.leaseOwner, owner), eq(jobs.state, "running")))
      .returning()
      .get();

    if (!row) return { stillOwned: false, cancelRequested: false };
    return { stillOwned: true, cancelRequested: row.cancelRequested };
  }

  /** Persist handler progress so a resumed attempt can pick up where it left off. */
  checkpoint(id: string, owner: string, progress: JobProgress): void {
    this.db
      .update(jobs)
      .set({ progress: JSON.stringify(progress), updatedAt: Date.now() })
      .where(and(eq(jobs.id, id), eq(jobs.leaseOwner, owner)))
      .run();
  }

  succeed(id: string, owner: string, progress?: JobProgress): void {
    const nowMs = Date.now();
    this.db
      .update(jobs)
      .set({
        state: "succeeded",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        finishedAt: nowMs,
        updatedAt: nowMs,
        ...(progress ? { progress: JSON.stringify(progress) } : {}),
      })
      .where(and(eq(jobs.id, id), eq(jobs.leaseOwner, owner)))
      .run();
  }

  /** Retry with backoff while attempts remain; otherwise mark terminally failed. */
  fail(id: string, owner: string, error: string): JobState {
    const nowMs = Date.now();
    return this.db.transaction((tx) => {
      const current = tx.select().from(jobs).where(eq(jobs.id, id)).get();
      if (!current) return "failed";

      const exhausted = current.attempts >= current.maxAttempts;
      const nextState: JobState = exhausted ? "failed" : "queued";

      tx.update(jobs)
        .set({
          state: nextState,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: error.slice(0, 4000),
          runAt: exhausted ? current.runAt : nowMs + backoffMs(current.attempts),
          finishedAt: exhausted ? nowMs : null,
          updatedAt: nowMs,
        })
        .where(and(eq(jobs.id, id), eq(jobs.leaseOwner, owner)))
        .run();

      return nextState;
    });
  }

  /**
   * Fail a job outright, ignoring any remaining attempts.
   *
   * For errors that cannot come out differently on a second try — a payload
   * that fails its schema, a job type with no registered handler. Retrying
   * those just burns attempts to arrive at the same place, several backoffs
   * later.
   */
  failPermanently(id: string, owner: string, error: string): void {
    const nowMs = Date.now();
    this.db
      .update(jobs)
      .set({
        state: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: error.slice(0, 4000),
        finishedAt: nowMs,
        updatedAt: nowMs,
      })
      .where(and(eq(jobs.id, id), eq(jobs.leaseOwner, owner)))
      .run();
  }

  /**
   * Hand a job back untouched during graceful shutdown.
   *
   * The attempt is refunded: stopping the control plane on purpose should not
   * consume one of the job's retries.
   */
  release(id: string, owner: string): void {
    const nowMs = Date.now();
    this.db
      .update(jobs)
      .set({
        state: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        attempts: sql`max(0, ${jobs.attempts} - 1)`,
        runAt: nowMs,
        updatedAt: nowMs,
      })
      .where(and(eq(jobs.id, id), eq(jobs.leaseOwner, owner), eq(jobs.state, "running")))
      .run();
  }

  markCancelled(id: string, owner: string): void {
    const nowMs = Date.now();
    this.db
      .update(jobs)
      .set({
        state: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: nowMs,
        updatedAt: nowMs,
      })
      .where(and(eq(jobs.id, id), eq(jobs.leaseOwner, owner)))
      .run();
  }

  /**
   * Request cancellation. A queued job is cancelled outright; a running one is
   * flagged, and its handler observes the flag through its abort signal at the
   * next checkpoint. Handlers are cooperative on purpose — killing a restore
   * mid-write is how you get a corrupt volume.
   */
  requestCancel(id: string): Job | null {
    const nowMs = Date.now();
    return this.db.transaction((tx) => {
      const current = tx.select().from(jobs).where(eq(jobs.id, id)).get();
      if (!current) return null;
      if (current.state === "queued") {
        const row = tx
          .update(jobs)
          .set({ state: "cancelled", cancelRequested: true, finishedAt: nowMs, updatedAt: nowMs })
          .where(eq(jobs.id, id))
          .returning()
          .get();
        return row ? toJob(row) : null;
      }
      if (current.state === "running") {
        const row = tx
          .update(jobs)
          .set({ cancelRequested: true, updatedAt: nowMs })
          .where(eq(jobs.id, id))
          .returning()
          .get();
        return row ? toJob(row) : null;
      }
      return toJob(current);
    });
  }

  /**
   * Fail jobs stuck in `running` with an expired lease and no attempts left.
   *
   * Without this they would never be claimed again (the claim query requires
   * remaining attempts) and would sit as permanent zombies. This is the one
   * piece of recovery that normal polling cannot do for us.
   */
  sweepExhausted(): number {
    const nowMs = Date.now();
    const rows = this.db
      .update(jobs)
      .set({
        state: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: "Exceeded max attempts; last attempt died without reporting.",
        finishedAt: nowMs,
        updatedAt: nowMs,
      })
      .where(
        and(
          eq(jobs.state, "running"),
          lt(jobs.leaseExpiresAt, nowMs),
          gte(jobs.attempts, jobs.maxAttempts),
        ),
      )
      .returning({ id: jobs.id })
      .all();
    return rows.length;
  }

  get(id: string): Job | null {
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    return row ? toJob(row) : null;
  }

  list(opts: { state?: JobState; projectId?: string; limit?: number } = {}): Job[] {
    const filters = [
      opts.state ? eq(jobs.state, opts.state) : undefined,
      opts.projectId ? eq(jobs.projectId, opts.projectId) : undefined,
    ].filter(Boolean);

    return this.db
      .select()
      .from(jobs)
      .where(filters.length ? and(...(filters as never[])) : undefined)
      .orderBy(desc(jobs.createdAt))
      .limit(Math.min(opts.limit ?? 50, 200))
      .all()
      .map(toJob);
  }

  stats(): JobStats {
    const rows = this.db
      .select({ state: jobs.state, count: sql<number>`count(*)` })
      .from(jobs)
      .groupBy(jobs.state)
      .all();

    const stats: JobStats = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const row of rows) {
      if (row.state in stats) stats[row.state as keyof JobStats] = row.count;
    }
    return stats;
  }

  /** Count of jobs orphaned by a dead worker and currently awaiting reclaim. */
  countOrphaned(): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(
        and(
          eq(jobs.state, "running"),
          or(isNull(jobs.leaseExpiresAt), lt(jobs.leaseExpiresAt, Date.now())),
        ),
      )
      .get();
    return row?.count ?? 0;
  }
}
