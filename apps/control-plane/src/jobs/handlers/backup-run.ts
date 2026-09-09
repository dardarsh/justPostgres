import { eq } from "drizzle-orm";
import { z } from "zod";
import type { JobProgress } from "@justpostgres/shared";
import { BackupService } from "../../backups/service.js";
import { runPgBackRest, summariseFailure } from "../../backups/pgbackrest.js";
import { backupConfigs, projects } from "../../db/schema.js";
import type { JobDeps } from "../deps.js";
import type { JobContext, JobHandler } from "../registry.js";

const payloadSchema = z.object({
  projectId: z.string().uuid(),
  type: z.enum(["full", "incr", "diff"]).optional(),
});
type Payload = z.infer<typeof payloadSchema>;

/**
 * Take a backup, expire what retention no longer covers, and schedule the next.
 *
 * Backups chain: each successful run queues its successor. That keeps the
 * schedule durable across restarts without a cron daemon, and the one hole it
 * leaves — a permanently failed run breaking the chain — is closed by
 * `ensureScheduled()`, which runs on boot and periodically.
 */
export function createBackupRunHandler(deps: JobDeps, backups: BackupService): JobHandler<Payload> {
  const { db, docker, disk } = deps;

  return {
    type: "backup.run",
    payloadSchema,

    async run({ job, payload, logger, checkpoint, throwIfCancelled }: JobContext<Payload>): Promise<JobProgress> {
      const project = db.select().from(projects).where(eq(projects.id, payload.projectId)).get();
      if (!project || project.deletedAt) {
        return { percent: 100, message: "Project no longer exists", checkpoint: {} };
      }
      if (!project.containerId) throw new Error("Project has no container to back up.");
      if (project.state !== "running") {
        throw new Error(`Project is ${project.state}; a backup needs a running database.`);
      }

      const backupConfig = backups.get(project.id);
      if (!backupConfig) throw new Error("Project has no backup configuration.");
      if (!backupConfig.enabled) {
        return { percent: 100, message: "Backups are disabled for this project", checkpoint: {} };
      }

      // Checked here rather than when the run was queued: a backup queued at
      // midnight runs at 3am, and the disk state that matters is the one at 3am.
      const blocked = disk.backupBlockedReason();
      if (blocked) {
        // Deferred rather than failed. The chain must not break over a
        // condition that an operator deleting one project would clear, and a
        // failed backup that stops all future backups is how a disk warning
        // becomes a data loss.
        const retryAt = Date.now() + 30 * 60_000;
        backups.scheduleRun(project.id, { runAt: retryAt });
        logger.warn({ ref: project.ref }, `backup deferred: ${blocked}`);
        return {
          percent: 100,
          message: `Deferred 30 minutes — not enough disk headroom. ${blocked}`,
          checkpoint: {},
        };
      }

      const type = payload.type ?? (await backups.nextBackupType(project.id));
      const runId = backups.recordRunStart(project.id, type, job.id);

      checkpoint({ percent: 10, message: `Starting ${type} backup`, checkpoint: { runId } });
      logger.info({ ref: project.ref, type }, "backup started");

      try {
        throwIfCancelled();

        const result = await runPgBackRest(docker, project.containerId, [
          "backup",
          `--stanza=${backupConfig.stanza}`,
          `--type=${type}`,
          // The default would wait for a checkpoint to happen on its own, which
          // on a quiet database can be several minutes of doing nothing.
          "--start-fast",
        ]);

        if (!result.ok) {
          throw new Error(summariseFailure(result.stderr || result.stdout));
        }

        checkpoint({ percent: 70, message: "Backup complete, applying retention", checkpoint: { runId } });

        // Expire is separate from backup so a retention misconfiguration cannot
        // make the backup itself look like it failed.
        const expired = await runPgBackRest(docker, project.containerId, [
          "expire",
          `--stanza=${backupConfig.stanza}`,
        ]);
        if (!expired.ok) {
          logger.warn(
            { ref: project.ref, stderr: expired.stderr.slice(0, 500) },
            "retention expiry failed; the backup itself succeeded",
          );
        }

        const info = await backups.stanzaInfo(project.id);
        const newest = info?.backups.sort((a, b) => b.finishedAt - a.finishedAt)[0];

        backups.recordRunEnd(runId, project.id, {
          ok: true,
          label: newest?.label ?? null,
          sizeBytes: newest?.repoSizeBytes ?? null,
        });
        backups.recordArchivingHealth(project.id, true);

        // Chain the next one.
        backups.scheduleRun(project.id, {
          runAt: Date.now() + backupConfig.intervalHours * 3600_000,
        });

        logger.info({ ref: project.ref, type, label: newest?.label }, "backup finished");
        return {
          percent: 100,
          message: `${type} backup complete${newest?.label ? ` (${newest.label})` : ""}`,
          checkpoint: { runId, label: newest?.label ?? null },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        backups.recordRunEnd(runId, project.id, { ok: false, error: message });

        // A failed backup very often means archiving is broken too, but not
        // always — so it is checked rather than assumed.
        const check = await runPgBackRest(docker, project.containerId!, [
          "check",
          `--stanza=${backupConfig.stanza}`,
        ]).catch(() => null);
        backups.recordArchivingHealth(
          project.id,
          check?.ok ?? false,
          check?.ok ? undefined : "pgbackrest check failed after a failed backup.",
        );

        // Keep the schedule alive even on the last attempt, so one bad night
        // does not silently end backups for this project forever.
        if (job.attempts >= job.maxAttempts) {
          db.update(backupConfigs)
            .set({ lastError: message, updatedAt: Date.now() })
            .where(eq(backupConfigs.projectId, project.id))
            .run();
          backups.scheduleRun(project.id, {
            runAt: Date.now() + backupConfig.intervalHours * 3600_000,
          });
        }
        throw err;
      }
    },
  };
}

/** Configuration the handler needs but the deps object does not carry. */
export type { Payload as BackupRunPayload };
export const backupTimeoutMs = (config: JobDeps["config"]) => config.backups.timeoutMs;
