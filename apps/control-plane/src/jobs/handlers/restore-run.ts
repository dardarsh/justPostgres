import { eq } from "drizzle-orm";
import { z } from "zod";
import type { JobProgress } from "@justpostgres/shared";
import {
  backupEnv,
  REPO_MOUNT,
  SOURCE_REPO_MOUNT,
  runPgBackRest,
  sourceRestoreCommand,
  summariseFailure,
} from "../../backups/pgbackrest.js";
import type { BackupService } from "../../backups/service.js";
import { credentials, projects } from "../../db/schema.js";
import { decryptSecret } from "../../lib/crypto.js";
import {
  backupVolumeName,
  containerName,
  DATA_MOUNT,
  DEFAULT_DATABASE,
  DEFAULT_ROLE,
  networkName,
  PGDATA,
  projectLabels,
  stanzaName,
  volumeName,
} from "../../projects/naming.js";
import {
  buildProjectContainerSpec,
  recreateProjectContainer,
} from "../../projects/container.js";
import type { DataStore } from "../../storage/datastore.js";
import type { JobDeps } from "../deps.js";
import { JobCancelledError, type JobContext, type JobHandler } from "../registry.js";

const payloadSchema = z.object({
  /** The new project the restore lands in. Already created, in state `creating`. */
  targetProjectId: z.string().uuid(),
  sourceProjectId: z.string().uuid(),
  /** Epoch millis to recover to. Omitted means the end of the WAL stream. */
  targetTime: z.number().int().optional(),
});
type Payload = z.infer<typeof payloadSchema>;

const STEPS = [
  "create_volumes",
  "restore_files",
  "start_recovery",
  "await_promotion",
  "init_own_repo",
  "detach_source",
] as const;

function progressFor(step: number, message: string): JobProgress {
  return {
    percent: Math.round((step / STEPS.length) * 100),
    message,
    checkpoint: { completedSteps: step },
  };
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

/** pgBackRest wants `YYYY-MM-DD HH:MM:SS+00`, not an ISO 8601 string. */
function toPgBackRestTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00");
}

/**
 * Restore a project's backup into a **new** project.
 *
 * This is the core of the milestone and the reason the design is shaped the way
 * it is: a restore never touches the project it restores from. "Restore to
 * 14:32 yesterday" produces a second project sitting alongside the first, which
 * you can connect to and inspect before deciding anything. Nothing is destroyed
 * until someone explicitly deletes it.
 *
 * The sequence exists because a restored cluster needs two different
 * repositories at two different times. During recovery it reads WAL from the
 * *source* project's repository; once promoted it must archive into its *own*.
 * So the source repository is mounted read-only for the recovery, and detached
 * once the new project has taken a full backup of its own — otherwise deleting
 * the source project would break the restored one.
 */
export function createRestoreRunHandler(
  deps: JobDeps,
  backups: BackupService,
  store: DataStore,
): JobHandler<Payload> {
  const { db, config, docker } = deps;

  return {
    type: "restore.run",
    payloadSchema,

    async run(ctx: JobContext<Payload>): Promise<JobProgress> {
      const { payload, logger, signal, resumeFrom, checkpoint, throwIfCancelled } = ctx;

      const target = db.select().from(projects).where(eq(projects.id, payload.targetProjectId)).get();
      const source = db.select().from(projects).where(eq(projects.id, payload.sourceProjectId)).get();
      if (!target) throw new Error("The project being restored into no longer exists.");
      if (!source) throw new Error("The project being restored from no longer exists.");

      const sourceBackupVolume = source.backupVolumeName ?? backupVolumeName(source.ref);
      const sourceStanza = backups.get(source.id)?.stanza ?? stanzaName(source.ref);
      const targetStanza = stanzaName(target.ref);
      const labels = projectLabels(target.id, target.ref);

      // Mutable, because a target past the end of the WAL is retried without one.
      let targetTime: number | undefined = payload.targetTime;
      let unreachableTarget = false;

      let step =
        typeof resumeFrom?.checkpoint?.completedSteps === "number"
          ? resumeFrom.checkpoint.completedSteps
          : 0;

      db.update(projects)
        .set({ state: "creating", lastError: null, updatedAt: Date.now() })
        .where(eq(projects.id, target.id))
        .run();

      try {
        if (step < 1) {
          throwIfCancelled();
          // Through the data store, so that on a copy-on-write host a restored
          // project gets a subvolume like any other. Creating a plain volume
          // here would leave it unable to be branched later — a project whose
          // capabilities silently depend on how it was created.
          await store.create(target.ref, labels);
          await docker.createVolume(backupVolumeName(target.ref), labels);
          await docker.createNetwork(networkName(target.ref), labels);
          checkpoint(progressFor((step = 1), "Volumes created"));
        }

        // --- restore the base backup into the new data volume ----------------
        if (step < 2) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Restoring files from the backup"));
          await restoreFiles(deps, target, sourceStanza, sourceBackupVolume, labels, targetTime);
          checkpoint(progressFor((step = 2), "Files restored"));
        }

        // --- start it, still able to read the source repository --------------
        if (step < 3) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Starting recovery"));

          const containerId = await startRecoveryContainer(
            deps,
            backups,
            target.id,
            sourceBackupVolume,
          );

          db.update(projects)
            .set({
              containerId,
              backupVolumeName: backupVolumeName(target.ref),
              sourceRepoVolumeName: sourceBackupVolume,
              updatedAt: Date.now(),
            })
            .where(eq(projects.id, target.id))
            .run();

          checkpoint(progressFor((step = 3), "Recovering"));
        }

        const containerId = db
          .select({ id: projects.containerId })
          .from(projects)
          .where(eq(projects.id, target.id))
          .get()?.id;
        if (!containerId) throw new Error("Restored project lost its container id.");

        // --- wait for recovery to finish and the cluster to promote ----------
        if (step < 4) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Replaying write-ahead log"));
          try {
            await awaitPromotion(deps, containerId, signal, logger, (message) =>
              checkpoint(progressFor(step, message)),
            );
          } catch (err) {
            if (!(err instanceof RecoveryTargetUnreachableError)) throw err;

            // The requested moment is after the last transaction the database
            // ever recorded, which happens whenever an idle database is
            // restored to "a few minutes ago". Postgres treats that as a hard
            // failure; the user meant "everything". Redo the restore without a
            // target and say so, rather than refusing something reasonable.
            logger.warn(
              { ref: target.ref },
              "recovery target is past the end of the WAL; restoring everything instead",
            );
            unreachableTarget = true;
            targetTime = undefined;
            await docker.stopContainer(containerId, 20).catch(() => {});
            await docker.removeContainer(containerId, { force: true });
            await restoreFiles(deps, target, sourceStanza, sourceBackupVolume, labels, undefined);
            const restarted = await startRecoveryContainer(
              deps,
              backups,
              target.id,
              sourceBackupVolume,
            );
            db.update(projects)
              .set({ containerId: restarted, updatedAt: Date.now() })
              .where(eq(projects.id, target.id))
              .run();
            await awaitPromotion(deps, restarted, signal, logger, (message) =>
              checkpoint(progressFor(step, message)),
            );
          }
          checkpoint(progressFor((step = 4), "Recovery complete"));
        }

        // --- its own repository, and its own first full backup ---------------
        if (step < 5) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Creating this project's own backup repository"));

          const chown = await docker.exec(containerId, ["chown", "-R", "postgres:postgres", REPO_MOUNT], {
            user: "root",
          });
          if (chown.exitCode !== 0) {
            throw new Error(`Could not prepare the backup repository: ${chown.stderr.trim()}`);
          }

          const created = await runPgBackRest(docker, containerId, [
            "stanza-create",
            `--stanza=${targetStanza}`,
          ]);
          if (!created.ok && !/already exists/i.test(created.stderr + created.stdout)) {
            throw new Error(`stanza-create failed: ${(created.stderr || created.stdout).trim()}`);
          }

          // The restored cluster is on a new timeline, so it needs a full
          // backup of its own before it has any recovery point at all.
          const full = await runPgBackRest(docker, containerId, [
            "backup",
            `--stanza=${targetStanza}`,
            "--type=full",
            "--start-fast",
          ]);
          if (!full.ok) {
            throw new Error(`First full backup failed:\n${summariseFailure(full.stderr || full.stdout)}`);
          }

          if (!backups.get(target.id)) backups.initialise(target.id, target.ref);

          // Record it as a real run. Without this the project keeps
          // `awaitingFirstBackup`, which would make the control plane refuse to
          // restore *from* it — even though its repository plainly holds a full
          // backup taken a moment ago.
          const runId = backups.recordRunStart(target.id, "full", ctx.job.id);
          const info = await backups.stanzaInfo(target.id).catch(() => null);
          const newest = info?.backups.sort((a, b) => b.finishedAt - a.finishedAt)[0];
          backups.recordRunEnd(runId, target.id, {
            ok: true,
            label: newest?.label ?? null,
            sizeBytes: newest?.repoSizeBytes ?? null,
          });
          backups.recordArchivingHealth(target.id, true);
          checkpoint(progressFor((step = 5), "First backup taken"));
        }

        // --- drop the dependency on the source repository --------------------
        if (step < 6) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Detaching from the source project"));
          await detachSourceRepo(deps, backups, target.id);
          checkpoint(progressFor((step = 6), "Detached"));
        }

        db.update(projects)
          .set({ state: "running", lastError: null, updatedAt: Date.now() })
          .where(eq(projects.id, target.id))
          .run();

        backups.scheduleRun(target.id, {
          runAt: Date.now() + (backups.get(target.id)?.intervalHours ?? 24) * 3600_000,
        });

        logger.info(
          { target: target.ref, source: source.ref, targetTime: payload.targetTime ?? "latest" },
          "restore complete",
        );
        return {
          percent: 100,
          message: unreachableTarget
            ? "Restore complete — the requested time was after the last recorded transaction, so everything was restored"
            : "Restore complete",
          checkpoint: { completedSteps: 6 },
        };
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

/**
 * Wait until the cluster has replayed to its target and promoted itself.
 *
 * `pg_isready` is not enough here: a cluster in recovery accepts connections
 * while still replaying, so reporting the project as ready then would hand
 * someone a read-only database that is still moving. `pg_is_in_recovery()` is
 * the question that actually matters.
 */
/** Postgres gives up when the requested target is past the end of the archived WAL. */
const TARGET_UNREACHABLE = /recovery ended before configured recovery target was reached/i;
/** Postgres logs this whenever the startup process dies, whatever the cause. */
const STARTUP_FAILED = /startup process \(PID \d+\) exited with exit code/i;

export class RecoveryTargetUnreachableError extends Error {
  constructor() {
    super("The requested recovery target is later than the last archived transaction.");
    this.name = "RecoveryTargetUnreachableError";
  }
}

async function awaitPromotion(
  deps: JobDeps,
  containerId: string,
  signal: AbortSignal,
  logger: JobContext<Payload>["logger"],
  report: (message: string) => void,
): Promise<void> {
  const deadline = Date.now() + deps.config.backups.timeoutMs;
  let last = "waiting for Postgres to start";
  let restarts = 0;

  while (Date.now() < deadline) {
    if (signal.aborted) throw new JobCancelledError();

    const result = await deps.docker
      .exec(
        containerId,
        ["psql", "-U", DEFAULT_ROLE, "-d", DEFAULT_DATABASE, "-tAX", "-c", "select pg_is_in_recovery()"],
        { user: "postgres" },
      )
      .catch(() => null);

    if (result?.exitCode === 0) {
      const value = result.stdout.trim();
      if (value === "f") return;
      last = "replaying write-ahead log";
      report("Replaying write-ahead log");
    } else {
      // A failed exec usually just means Postgres has not opened its socket
      // yet. It looks identical to a cluster that starts, fails recovery, and
      // is restarted by Docker forever — so the logs are what distinguish
      // them, not the container's state. Polling `inspect` for a stopped
      // container does not work: a crash-looping container is reported running
      // almost all of the time.
      const logs = await deps.docker.containerLogs(containerId, 80).catch(() => "");
      if (TARGET_UNREACHABLE.test(logs)) throw new RecoveryTargetUnreachableError();

      if (STARTUP_FAILED.test(logs)) {
        restarts++;
        if (restarts >= 3) {
          throw new Error(
            `The restored cluster keeps failing to start:\n${logs
              .trim()
              .split("\n")
              .filter((line) => /FATAL|ERROR|PANIC/.test(line))
              .slice(-4)
              .join("\n")}`,
          );
        }
      }
      if (result) last = (result.stderr || result.stdout).trim().split("\n")[0] ?? last;
    }

    logger.debug({ last, restarts }, "awaiting promotion");
    await sleep(2000, signal);
  }

  throw new Error(`The restored cluster did not finish recovery in time. Last state: ${last}`);
}

/**
 * Recreate the container without the source repository mounted.
 *
 * Until this runs, the restored project cannot start unless the source
 * project's backup volume still exists — so deleting the source would break a
 * project that is supposed to be independent of it.
 */
async function detachSourceRepo(
  deps: JobDeps,
  backups: BackupService,
  projectId: string,
): Promise<void> {
  const { db, config, docker } = deps;

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project?.sourceRepoVolumeName) return;

  // Recreating without the source repository mount. Through the shared builder,
  // which omits it by default — so this is simply "build the normal spec".
  await recreateProjectContainer({ db, config, docker, backups }, projectId);

  db.update(projects)
    .set({ sourceRepoVolumeName: null, updatedAt: Date.now() })
    .where(eq(projects.id, projectId))
    .run();
}

/** Restore the base backup into the project's (already created) data directory. */
async function restoreFiles(
  deps: JobDeps,
  target: { ref: string; image: string; memoryBytes: number; nanoCpus: number },
  sourceStanza: string,
  sourceBackupVolume: string,
  labels: Record<string, string>,
  targetTime: number | undefined,
): Promise<void> {
  const { config, docker } = deps;

  const restoreEnv = backupEnv({
    stanza: sourceStanza,
    // The source repository is repo1 for this container, which only reads.
    repo: { type: "posix", path: SOURCE_REPO_MOUNT },
    retentionFull: config.backups.retentionFull,
  });

  // Docker creates a volume root-owned; pgBackRest refuses to run as root, so
  // ownership is fixed by a separate one-shot container rather than by wrapping
  // the restore in `su -c` and fighting shell quoting.
  const owned = await docker.runToCompletion({
    name: `jp-restore-chown-${target.ref}`,
    image: target.image,
    entrypoint: ["chown", "-R", "postgres:postgres", DATA_MOUNT],
    command: [],
    env: {},
    labels: { ...labels, "io.justpostgres.role": "restore" },
    volumes: { [volumeName(target.ref)]: DATA_MOUNT },
    memoryBytes: target.memoryBytes,
    nanoCpus: target.nanoCpus,
    restartPolicy: "no",
  });
  if (owned.exitCode !== 0) {
    throw new Error(`Could not prepare the data directory:\n${owned.logs.slice(-1000)}`);
  }

  const outcome = await docker.runToCompletion(
    {
      name: `jp-restore-${target.ref}`,
      image: target.image,
      user: "postgres",
      entrypoint: ["pgbackrest"],
      command: [
        "restore",
        `--stanza=${sourceStanza}`,
        `--pg1-path=${PGDATA}`,
        // The recovering cluster fetches WAL from the *source* repository, but
        // its own archive_command must not know that repository exists — so it
        // is named only here.
        `--recovery-option=restore_command=${sourceRestoreCommand({
          stanza: sourceStanza,
          repoPath: SOURCE_REPO_MOUNT,
        })}`,
        // `--target-action` is only accepted alongside an explicit recovery
        // target; with `--type=default` pgBackRest rejects it outright.
        ...(targetTime
          ? ["--type=time", `--target=${toPgBackRestTime(targetTime)}`, "--target-action=promote"]
          : ["--type=default"]),
      ],
      env: restoreEnv,
      labels: { ...labels, "io.justpostgres.role": "restore" },
      volumes: { [volumeName(target.ref)]: DATA_MOUNT },
      readOnlyVolumes: { [sourceBackupVolume]: SOURCE_REPO_MOUNT },
      memoryBytes: target.memoryBytes,
      nanoCpus: target.nanoCpus,
      restartPolicy: "no",
    },
    { timeoutMs: config.backups.timeoutMs },
  );

  if (outcome.exitCode !== 0) {
    throw new Error(`pgbackrest restore failed:\n${summariseFailure(outcome.logs)}`);
  }
}

/** Create and start the container that will replay WAL and promote. */
async function startRecoveryContainer(
  deps: JobDeps,
  backups: BackupService,
  projectId: string,
  sourceBackupVolume: string,
): Promise<string> {
  const { db, config, docker } = deps;

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error("Project disappeared before recovery could start.");

  const existing = await docker.listContainers({ "io.justpostgres.project-id": projectId });
  const adopted = existing.find((c) => c.name === containerName(project.ref));

  // The only spec that differs from an ordinary project: the source
  // repository, mounted read-only so restore_command can replay its WAL. The
  // builder takes it as an option rather than this rebuilding the whole spec.
  const containerId =
    adopted?.id ??
    (await docker.createContainer(
      buildProjectContainerSpec({ db, config, backups }, project, {
        readOnlyVolumes: { [sourceBackupVolume]: SOURCE_REPO_MOUNT },
      }),
    ));

  await docker.startContainer(containerId);
  return containerId;
}
