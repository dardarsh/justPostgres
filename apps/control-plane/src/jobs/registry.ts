import type { ZodType } from "zod";
import type { Job, JobProgress, JobType } from "@justpostgres/shared";
import type { Logger } from "../logger.js";

/** Thrown by a handler that noticed its abort signal and stopped cleanly. */
export class JobCancelledError extends Error {
  constructor(message = "Job cancelled") {
    super(message);
    this.name = "JobCancelledError";
  }
}

export interface JobContext<P> {
  job: Job;
  payload: P;
  logger: Logger;
  /**
   * Aborted on graceful shutdown or on an explicit cancel request. Handlers
   * must check it between steps; nothing forcibly kills a running handler,
   * because interrupting a restore mid-write is how volumes get corrupted.
   */
  signal: AbortSignal;
  /**
   * The progress recorded by the previous attempt, if this job has been
   * resumed. Handlers that can pick up where they left off should use it;
   * handlers that cannot may ignore it and start over.
   */
  resumeFrom: JobProgress | null;
  /** Persist progress. Cheap; call it at every meaningful step boundary. */
  checkpoint(progress: JobProgress): void;
  /** Throws JobCancelledError if the signal has been aborted. */
  throwIfCancelled(): void;
}

export interface JobHandler<P = unknown> {
  type: JobType;
  /** Payload is validated before the handler runs; a bad payload fails fast and does not retry. */
  payloadSchema: ZodType<P>;
  run(ctx: JobContext<P>): Promise<JobProgress | void>;
}

export class JobRegistry {
  private readonly handlers = new Map<JobType, JobHandler<never>>();

  register<P>(handler: JobHandler<P>): void {
    if (this.handlers.has(handler.type)) {
      throw new Error(`Duplicate job handler registered for type "${handler.type}"`);
    }
    this.handlers.set(handler.type, handler as unknown as JobHandler<never>);
  }

  get(type: JobType): JobHandler<never> | undefined {
    return this.handlers.get(type);
  }

  types(): JobType[] {
    return [...this.handlers.keys()];
  }
}
