import { eq } from "drizzle-orm";
import { z } from "zod";
import type { JobProgress } from "@justpostgres/shared";
import { projects } from "../../db/schema.js";
import { physicalNames } from "../../projects/naming.js";
import type { DataStore } from "../../storage/datastore.js";
import type { JobDeps } from "../deps.js";
import type { JobContext, JobHandler } from "../registry.js";

const payloadSchema = z.object({ projectId: z.string().uuid() });
type Payload = z.infer<typeof payloadSchema>;

const STEPS = ["stop_container", "remove_container", "remove_volumes", "remove_network"] as const;

function progressFor(stepIndex: number, message: string): JobProgress {
  return {
    percent: Math.round((stepIndex / (STEPS.length + 1)) * 100),
    message,
    checkpoint: { completedSteps: stepIndex },
  };
}

/**
 * Tear down a project's runtime, then soft-delete the row.
 *
 * Ordering is deliberate: the volume — the only irreplaceable thing here — is
 * removed after the container that holds it, and the metadata row is retired
 * last. If this job dies at any point, what remains is a project still marked
 * `deleting` whose next attempt re-runs the remaining steps, rather than a row
 * that claims the data is gone while the volume is still on disk.
 *
 * Deletion is not cancellable. Stopping halfway leaves the project in a state
 * nobody asked for, and the operation is already irreversible by the time it
 * starts.
 */
export function createProjectDeleteHandler(deps: JobDeps, store: DataStore): JobHandler<Payload> {
  const { db, docker } = deps;

  return {
    type: "project.delete",
    payloadSchema,

    async run({ payload, logger, resumeFrom, checkpoint }: JobContext<Payload>): Promise<JobProgress> {
      const project = db.select().from(projects).where(eq(projects.id, payload.projectId)).get();
      if (!project) {
        return { percent: 100, message: "Project already gone", checkpoint: { completedSteps: 5 } };
      }
      if (project.deletedAt) {
        return { percent: 100, message: "Project already deleted", checkpoint: { completedSteps: 5 } };
      }

      // Stored names, not derived: a promoted project's ref no longer matches
      // the objects it owns.
      const names = physicalNames(project);
      const ref = project.ref;
      let step =
        typeof resumeFrom?.checkpoint?.completedSteps === "number"
          ? resumeFrom.checkpoint.completedSteps
          : 0;

      if (step < 1) {
        if (project.containerId) await docker.stopContainer(project.containerId, 30);
        checkpoint(progressFor((step = 1), "Container stopped"));
      }

      if (step < 2) {
        if (project.containerId) {
          await docker.removeContainer(project.containerId, { force: true });
        }
        checkpoint(progressFor((step = 2), "Container removed"));
      }

      if (step < 3) {
        // Through the data store: on a copy-on-write host the data directory is
        // a subvolume behind the volume, and removing only the volume would
        // leave the subvolume — and the data — on disk.
        await store.remove(ref);
        // The repository goes with the project. Keeping backups for a project
        // that has been deliberately deleted would be its own kind of surprise.
        await docker.removeVolume(names.backupVolume, { force: true });
        checkpoint(progressFor((step = 3), "Volumes removed"));
      }

      if (step < 4) {
        await docker.removeNetwork(names.network);
        checkpoint(progressFor((step = 4), "Network removed"));
      }

      const now = Date.now();
      db.update(projects)
        .set({
          deletedAt: now,
          updatedAt: now,
          containerId: null,
          hostPort: null,
        })
        .where(eq(projects.id, project.id))
        .run();

      logger.info({ ref, projectId: project.id }, "project deleted");
      return { percent: 100, message: "Project deleted", checkpoint: { completedSteps: 5 } };
    },
  };
}
