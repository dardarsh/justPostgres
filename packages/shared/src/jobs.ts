/** Lifecycle of a job in the queue. */
export const JOB_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type JobState = (typeof JOB_STATES)[number];

/** A job is terminal when the worker will never touch it again. */
export const TERMINAL_JOB_STATES: readonly JobState[] = [
  "succeeded",
  "failed",
  "cancelled",
];

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(state);
}

/**
 * Job types. Handlers are registered against these names.
 *
 * `noop` is retained past M0 on purpose: it is the cheapest way to verify that
 * a deployment's queue works, including resumption after a restart, without
 * touching a real database.
 */
export const JOB_TYPES = [
  "noop",
  "project.create",
  "project.delete",
  "backup.run",
  "restore.run",
  "restore.verify",
  "branch.run",
  "extension.enable",
  "rest.enable",
  "project.upgrade",
  "backup.migrate",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** Progress is free-form per job type, but always carries a percentage. */
export interface JobProgress {
  percent: number;
  message?: string;
  /** Handler-specific checkpoint, used to resume after a crash. */
  checkpoint?: Record<string, unknown>;
}

export interface Job {
  id: string;
  type: JobType;
  projectId: string | null;
  payload: Record<string, unknown>;
  state: JobState;
  priority: number;
  runAt: number;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  progress: JobProgress | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface EnqueueJobRequest {
  type: JobType;
  payload?: Record<string, unknown>;
  projectId?: string | null;
  priority?: number;
  runAt?: number;
  maxAttempts?: number;
}
