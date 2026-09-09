import { z } from "zod";
import type { JobProgress } from "@justpostgres/shared";
import { JobCancelledError, type JobHandler } from "../registry.js";

const payloadSchema = z.object({
  /** Number of simulated units of work. */
  steps: z.number().int().min(1).max(1000).default(10),
  /** How long each step takes. */
  stepDurationMs: z.number().int().min(10).max(60_000).default(1000),
  /** Throw on this step (1-indexed), to exercise the retry path. */
  failAtStep: z.number().int().min(1).optional(),
});

type NoopPayload = z.infer<typeof payloadSchema>;

/** Sleep that wakes early and throws when the job is aborted. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new JobCancelledError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new JobCancelledError());
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The M0 proof-of-life job. It does nothing useful on purpose; what it does do
 * is exercise every property the real jobs will depend on from M1 onward:
 *
 *  - long-running work split into observable steps
 *  - progress checkpointed to the database at each step boundary
 *  - resumption from the last checkpoint after the control plane is killed
 *    mid-run, rather than starting over
 *  - cooperative cancellation via the abort signal
 *  - a deliberate failure path, to exercise retry with backoff
 *
 * When project.create and restore.run arrive, they are this shape with real
 * work in the loop body.
 */
export const noopHandler: JobHandler<NoopPayload> = {
  type: "noop",
  payloadSchema,

  async run({ payload, logger, signal, resumeFrom, checkpoint, throwIfCancelled }) {
    const { steps, stepDurationMs, failAtStep } = payload;

    const resumedFromStep =
      typeof resumeFrom?.checkpoint?.completedSteps === "number"
        ? Math.min(resumeFrom.checkpoint.completedSteps, steps)
        : 0;

    if (resumedFromStep > 0) {
      logger.info({ resumedFromStep, steps }, "resuming from checkpoint");
    }

    for (let step = resumedFromStep + 1; step <= steps; step++) {
      throwIfCancelled();
      await sleep(stepDurationMs, signal);

      if (failAtStep === step) {
        throw new Error(`Deliberate failure at step ${step} of ${steps}`);
      }

      checkpoint({
        percent: Math.round((step / steps) * 100),
        message: `Completed step ${step} of ${steps}`,
        checkpoint: { completedSteps: step },
      });
      logger.debug({ step, steps }, "step complete");
    }

    const done: JobProgress = {
      percent: 100,
      message:
        resumedFromStep > 0
          ? `Completed ${steps} steps (resumed after step ${resumedFromStep})`
          : `Completed ${steps} steps`,
      checkpoint: { completedSteps: steps },
    };
    return done;
  },
};
