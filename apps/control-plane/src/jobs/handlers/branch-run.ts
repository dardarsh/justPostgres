import { eq } from "drizzle-orm";
import { z } from "zod";
import type { JobProgress } from "@justpostgres/shared";
import {
  REPO_MOUNT,
  runPgBackRest,
  summariseFailure,
} from "../../backups/pgbackrest.js";
import type { BackupService } from "../../backups/service.js";
import { credentials, projects } from "../../db/schema.js";
import { decryptSecret } from "../../lib/crypto.js";
import {
  backupVolumeName,
  DEFAULT_DATABASE,
  DEFAULT_ROLE,
  networkName,
  physicalNames,
  projectLabels,
  stanzaName,
} from "../../projects/naming.js";
import { buildProjectContainerSpec } from "../../projects/container.js";
import type { DataStore } from "../../storage/datastore.js";
import type { JobDeps } from "../deps.js";
import { JobCancelledError, type JobContext, type JobHandler } from "../registry.js";

const payloadSchema = z.object({
  targetProjectId: z.string().uuid(),
  sourceProjectId: z.string().uuid(),
});
type Payload = z.infer<typeof payloadSchema>;

const STEPS = ["checkpoint", "snapshot", "start", "wait_ready", "own_repo"] as const;

function progressFor(step: number, message: string): JobProgress {
  return { percent: Math.round((step / STEPS.length) * 100), message, checkpoint: { completedSteps: step } };
}

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
 * Branch a project by cloning its data directory copy-on-write.
 *
 * Where a point-in-time restore rebuilds a database from a backup and replays
 * WAL — correct anywhere, and O(database size) — this takes a filesystem
 * snapshot of the live data directory. The clone shares every block with its
 * parent until one of them writes, so the cost is independent of how large the
 * database is.
 *
 * Snapshotting a *running* Postgres is safe because Postgres is crash-safe: an
 * atomic snapshot of a complete data directory is exactly the state a power cut
 * would have left, and starting from it runs ordinary crash recovery. A
 * `CHECKPOINT` first is not required for correctness, only to shorten that
 * recovery.
 *
 * The one thing this cannot do is travel backwards. A snapshot captures *now*;
 * branching from a point in the past needs the WAL, and so goes through the
 * restore path instead. The two strategies answer different questions.
 */
export function createBranchRunHandler(
  deps: JobDeps,
  backups: BackupService,
  store: DataStore,
): JobHandler<Payload> {
  const { db, config, docker } = deps;

  return {
    type: "branch.run",
    payloadSchema,

    async run(ctx: JobContext<Payload>): Promise<JobProgress> {
      const { payload, logger, signal, resumeFrom, checkpoint, throwIfCancelled } = ctx;

      const target = db.select().from(projects).where(eq(projects.id, payload.targetProjectId)).get();
      const source = db.select().from(projects).where(eq(projects.id, payload.sourceProjectId)).get();
      if (!target) throw new Error("The branch no longer exists.");
      if (!source || source.deletedAt) throw new Error("The project being branched no longer exists.");
      if (!store.supportsSnapshot) {
        throw new Error("This data store cannot snapshot; the branch should have used a restore.");
      }

      const labels = projectLabels(target.id, target.ref);
      const stanza = stanzaName(target.ref);
      let step =
        typeof resumeFrom?.checkpoint?.completedSteps === "number"
          ? resumeFrom.checkpoint.completedSteps
          : 0;

      db.update(projects)
        .set({ state: "creating", lastError: null, updatedAt: Date.now() })
        .where(eq(projects.id, target.id))
        .run();

      try {
        // A checkpoint flushes dirty buffers so the clone has less WAL to
        // replay on first start. Best effort: the snapshot is correct without
        // it, just slower to come up.
        if (step < 1) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Checkpointing the source"));
          if (source.containerId) {
            await docker
              .exec(
                source.containerId,
                ["psql", "-U", DEFAULT_ROLE, "-d", DEFAULT_DATABASE, "-tAX", "-c", "CHECKPOINT"],
                { user: "postgres" },
              )
              .catch((err) => logger.warn({ err }, "checkpoint before snapshot failed; continuing"));
          }
          checkpoint(progressFor((step = 1), "Source checkpointed"));
        }

        if (step < 2) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Cloning the data directory"));
          await store.snapshot(source.ref, target.ref, labels);
          await docker.createVolume(backupVolumeName(target.ref), labels);
          await docker.createNetwork(networkName(target.ref), labels);
          checkpoint(progressFor((step = 2), "Data directory cloned"));
        }

        if (step < 3) {
          throwIfCancelled();
          const existing = await docker.listContainers({ "io.justpostgres.project-id": target.id });
          const names = physicalNames(target);

          const fresh = db.select().from(projects).where(eq(projects.id, target.id)).get()!;
          const containerId =
            existing.find((c) => c.name === names.container)?.id ??
            (await docker.createContainer(buildProjectContainerSpec({ db, config, backups }, fresh)));

          db.update(projects)
            .set({
              containerId,
              backupVolumeName: backupVolumeName(target.ref),
              updatedAt: Date.now(),
            })
            .where(eq(projects.id, target.id))
            .run();

          await docker.startContainer(containerId);
          checkpoint(progressFor((step = 3), "Branch starting"));
        }

        const containerId = db
          .select({ id: projects.containerId })
          .from(projects)
          .where(eq(projects.id, target.id))
          .get()?.id;
        if (!containerId) throw new Error("Branch lost its container id.");

        if (step < 4) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Running crash recovery on the clone"));
          await waitReady(deps, containerId, signal);
          checkpoint(progressFor((step = 4), "Branch is accepting connections"));
        }

        if (step < 5) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Setting up its own backups"));

          const chown = await docker.exec(containerId, ["chown", "-R", "postgres:postgres", REPO_MOUNT], {
            user: "root",
          });
          if (chown.exitCode !== 0) {
            throw new Error(`Could not prepare the backup repository: ${chown.stderr.trim()}`);
          }

          const created = await runPgBackRest(docker, containerId, ["stanza-create", `--stanza=${stanza}`]);
          if (!created.ok && !/already exists/i.test(created.stderr + created.stdout)) {
            throw new Error(`stanza-create failed: ${summariseFailure(created.stderr || created.stdout)}`);
          }

          // A clone is on the parent's timeline with none of its own backups,
          // so until this lands it has no recovery point at all.
          const full = await runPgBackRest(docker, containerId, [
            "backup",
            `--stanza=${stanza}`,
            "--type=full",
            "--start-fast",
          ]);
          if (!full.ok) {
            throw new Error(`First full backup failed:\n${summariseFailure(full.stderr || full.stdout)}`);
          }

          if (!backups.get(target.id)) backups.initialise(target.id, target.ref);
          const runId = backups.recordRunStart(target.id, "full", ctx.job.id);
          const info = await backups.stanzaInfo(target.id).catch(() => null);
          const newest = info?.backups.sort((a, b) => b.finishedAt - a.finishedAt)[0];
          backups.recordRunEnd(runId, target.id, {
            ok: true,
            label: newest?.label ?? null,
            sizeBytes: newest?.repoSizeBytes ?? null,
          });
          backups.recordArchivingHealth(target.id, true);
          checkpoint(progressFor((step = 5), "Backups configured"));
        }

        db.update(projects)
          .set({ state: "running", lastError: null, updatedAt: Date.now() })
          .where(eq(projects.id, target.id))
          .run();

        backups.scheduleRun(target.id, {
          runAt: Date.now() + (backups.get(target.id)?.intervalHours ?? 24) * 3600_000,
        });

        logger.info({ branch: target.ref, source: source.ref }, "copy-on-write branch ready");
        return { percent: 100, message: "Branch ready", checkpoint: { completedSteps: 5 } };
      } catch (err) {
        if (err instanceof JobCancelledError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        db.update(projects)
          .set({
            state: ctx.job.attempts >= ctx.job.maxAttempts ? "failed" : "creating",
            lastError: message,
            updatedAt: Date.now(),
          })
          .where(eq(projects.id, target.id))
          .run();
        throw err;
      }
    },
  };
}

async function waitReady(deps: JobDeps, containerId: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + deps.config.projects.readyTimeoutMs;
  let last = "starting";

  while (Date.now() < deadline) {
    if (signal.aborted) throw new JobCancelledError();

    const result = await deps.docker
      .exec(containerId, ["pg_isready", "-U", DEFAULT_ROLE, "-d", DEFAULT_DATABASE, "-q"], {
        user: "postgres",
      })
      .catch(() => null);

    if (result?.exitCode === 0) return;
    if (result) last = (result.stderr || result.stdout).trim().split("\n")[0] || last;
    await sleep(1000, signal);
  }

  throw new Error(`The branch did not accept connections in time. Last state: ${last}`);
}
