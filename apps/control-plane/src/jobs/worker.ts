import { randomUUID } from "node:crypto";
import type { Job, JobProgress } from "@justpostgres/shared";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { JobCancelledError, type JobRegistry } from "./registry.js";
import type { JobQueue } from "./queue.js";

/** Thrown when a payload fails its handler's schema; never retried. */
class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export interface WorkerStatus {
  running: boolean;
  instanceId: string;
  inFlight: number;
  concurrency: number;
  lastTickAt: number | null;
}

/**
 * Polls the queue, runs handlers, and keeps leases alive while they work.
 *
 * One worker per control-plane process. Concurrency is bounded because the jobs
 * this queue will carry from M1 on are mostly Docker and pgBackRest operations,
 * where running many at once starves the host rather than finishing sooner.
 */
export class JobWorker {
  readonly instanceId = `cp-${randomUUID().slice(0, 8)}`;

  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private lastTickAt: number | null = null;
  private readonly inFlight = new Map<string, AbortController>();

  constructor(
    private readonly queue: JobQueue,
    private readonly registry: JobRegistry,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;

    const orphaned = this.queue.countOrphaned();
    if (orphaned > 0) {
      this.logger.warn(
        { orphaned },
        "found jobs left running by a previous instance; they will be reclaimed as their leases expire",
      );
    }

    this.logger.info(
      { instanceId: this.instanceId, concurrency: this.config.jobs.concurrency },
      "job worker started",
    );

    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.jobs.pollIntervalMs);
    // Do not hold the event loop open purely for polling.
    this.timer.unref();

    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.inFlight.size === 0) {
      this.logger.info("job worker stopped");
      return;
    }

    this.logger.info({ inFlight: this.inFlight.size }, "signalling in-flight jobs to stop");
    for (const controller of this.inFlight.values()) controller.abort();

    // Handlers are cooperative, so give them a bounded window to unwind. Any
    // that outlast it keep their lease and are reclaimed after it expires.
    const deadline = Date.now() + 10_000;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    this.logger.info({ stragglers: this.inFlight.size }, "job worker stopped");
  }

  status(): WorkerStatus {
    return {
      running: this.timer !== null,
      instanceId: this.instanceId,
      inFlight: this.inFlight.size,
      concurrency: this.config.jobs.concurrency,
      lastTickAt: this.lastTickAt,
    };
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    this.lastTickAt = Date.now();

    try {
      const swept = this.queue.sweepExhausted();
      if (swept > 0) {
        this.logger.warn({ count: swept }, "failed jobs that ran out of attempts while orphaned");
      }

      while (!this.stopping && this.inFlight.size < this.config.jobs.concurrency) {
        const job = this.queue.claim(this.instanceId);
        if (!job) break;
        void this.execute(job);
      }
    } catch (err) {
      // A failure here is a bug or a disk problem. Log and keep polling; the
      // worker going silent is worse than a noisy log.
      this.logger.error({ err }, "job worker tick failed");
    }
  }

  private async execute(job: Job): Promise<void> {
    const log = this.logger.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
    const controller = new AbortController();
    this.inFlight.set(job.id, controller);

    const heartbeat = setInterval(() => {
      const result = this.queue.heartbeat(job.id, this.instanceId);
      if (!result.stillOwned) {
        log.warn("lost job lease; aborting local execution");
        controller.abort();
        return;
      }
      if (result.cancelRequested) {
        log.info("cancellation requested");
        controller.abort();
      }
    }, this.config.jobs.heartbeatIntervalMs);
    heartbeat.unref();

    const startedAt = Date.now();
    log.info("job started");

    try {
      const handler = this.registry.get(job.type);
      if (!handler) throw new PermanentJobError(`No handler registered for job type "${job.type}"`);

      const parsed = handler.payloadSchema.safeParse(job.payload);
      if (!parsed.success) {
        throw new PermanentJobError(`Invalid payload: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      }

      const result = await handler.run({
        job,
        payload: parsed.data as never,
        logger: log,
        signal: controller.signal,
        resumeFrom: job.progress,
        checkpoint: (progress: JobProgress) => {
          this.queue.checkpoint(job.id, this.instanceId, progress);
        },
        throwIfCancelled: () => {
          if (controller.signal.aborted) throw new JobCancelledError();
        },
      });

      this.queue.succeed(job.id, this.instanceId, result ?? undefined);
      log.info({ durationMs: Date.now() - startedAt }, "job succeeded");
    } catch (err) {
      await this.handleFailure(job, err, log);
    } finally {
      clearInterval(heartbeat);
      this.inFlight.delete(job.id);
    }
  }

  private async handleFailure(job: Job, err: unknown, log: Logger): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof JobCancelledError) {
      // Distinguish a user-requested cancel from a shutdown: the first is
      // terminal, the second hands the job back for the next process to run.
      const current = this.queue.get(job.id);
      const wasCancelled = current?.state === "cancelled" || this.cancelWasRequested(job.id);

      if (wasCancelled && !this.stopping) {
        this.queue.markCancelled(job.id, this.instanceId);
        log.info("job cancelled");
      } else {
        this.queue.release(job.id, this.instanceId);
        log.info("job released back to the queue for shutdown");
      }
      return;
    }

    if (err instanceof PermanentJobError) {
      // Straight to failed, bypassing the retry policy: a payload that fails
      // its schema will fail it again on every remaining attempt.
      this.queue.failPermanently(job.id, this.instanceId, message);
      log.error({ err }, "job failed permanently");
      return;
    }

    const nextState = this.queue.fail(job.id, this.instanceId, message);
    if (nextState === "queued") {
      log.warn({ err }, "job failed; will retry");
    } else {
      log.error({ err }, "job failed; no attempts remaining");
    }
  }

  private cancelWasRequested(id: string): boolean {
    return this.queue.heartbeat(id, this.instanceId).cancelRequested;
  }
}
