import { eq } from "drizzle-orm";
import { z } from "zod";
import type { JobProgress } from "@justpostgres/shared";
import type { BackupService } from "../../backups/service.js";
import { quoteIdent } from "../../data/identifiers.js";
import type { DataPoolManager } from "../../data/pool.js";
import { projects } from "../../db/schema.js";
import { metaFor } from "../../extensions/catalogue.js";
import {
  parsePreload,
  recreateProjectContainer,
  serialisePreload,
} from "../../projects/container.js";
import { DEFAULT_DATABASE, DEFAULT_ROLE } from "../../projects/naming.js";
import type { JobDeps } from "../deps.js";
import { JobCancelledError, type JobContext, type JobHandler } from "../registry.js";

const payloadSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(128),
});
type Payload = z.infer<typeof payloadSchema>;

const STEPS = ["record_preload", "restart", "wait_ready", "create_extension"] as const;

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
 * Enable an extension that needs `shared_preload_libraries`.
 *
 * There is no way to make this instant. Postgres reads
 * `shared_preload_libraries` once, when the postmaster starts; a library that
 * was not loaded then cannot be loaded later by any means. So the database has
 * to be restarted, and the honest thing is to say so before the click rather
 * than present a toggle that silently causes an outage.
 *
 * The library list is written to the project row *before* the restart, so a
 * container recreated for any other reason afterwards — a promote, a port
 * change — keeps the setting. Storing it only in the running container would
 * mean quietly losing extensions to unrelated operations.
 */
export function createExtensionEnableHandler(
  deps: JobDeps,
  backups: BackupService,
  pools: DataPoolManager,
): JobHandler<Payload> {
  const { db, config, docker } = deps;

  return {
    type: "extension.enable",
    payloadSchema,

    async run({ payload, logger, signal, resumeFrom, checkpoint, throwIfCancelled }: JobContext<Payload>) {
      const project = db.select().from(projects).where(eq(projects.id, payload.projectId)).get();
      if (!project || project.deletedAt) {
        return { percent: 100, message: "Project no longer exists", checkpoint: {} };
      }

      const meta = metaFor(payload.name);
      if (!meta?.preloadLibrary) {
        throw new Error(`Extension "${payload.name}" does not need a restart; enable it directly.`);
      }

      let step =
        typeof resumeFrom?.checkpoint?.completedSteps === "number"
          ? resumeFrom.checkpoint.completedSteps
          : 0;

      const existing = parsePreload(project.preloadLibraries);
      const libraries = [...new Set([...existing, meta.preloadLibrary])];

      if (step < 1) {
        throwIfCancelled();
        db.update(projects)
          .set({ preloadLibraries: serialisePreload(libraries), updatedAt: Date.now() })
          .where(eq(projects.id, project.id))
          .run();
        checkpoint(progressFor((step = 1), "Recorded the preload setting"));
      }

      if (step < 2) {
        throwIfCancelled();
        checkpoint(progressFor(step, `Restarting to load ${meta.preloadLibrary}`));

        // A restarted container is a new container; the pool would keep handing
        // out connections to the old one's port mapping.
        await pools.evict(project.id);
        await recreateProjectContainer({ db, config, docker, backups }, project.id, {
          preloadLibraries: libraries,
          ...(meta.settings ? { extraSettings: meta.settings } : {}),
        });
        checkpoint(progressFor((step = 2), "Restarted"));
      }

      const containerId = db
        .select({ id: projects.containerId })
        .from(projects)
        .where(eq(projects.id, project.id))
        .get()?.id;
      if (!containerId) throw new Error("Project lost its container while restarting.");

      if (step < 3) {
        throwIfCancelled();
        checkpoint(progressFor(step, "Waiting for Postgres to come back"));
        await waitReady(deps, containerId, signal);
        checkpoint(progressFor((step = 3), "Postgres is back"));
      }

      if (step < 4) {
        throwIfCancelled();
        checkpoint(progressFor(step, `Creating ${payload.name}`));
        await pools.query(
          project.id,
          `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(payload.name)} CASCADE`,
        );
        checkpoint(progressFor((step = 4), "Extension created"));
      }

      logger.info(
        { ref: project.ref, name: payload.name, library: meta.preloadLibrary },
        "extension enabled after restart",
      );
      return {
        percent: 100,
        message: `${meta.title} is enabled`,
        checkpoint: { completedSteps: 4 },
      };
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

    // A bad shared_preload_libraries value makes Postgres refuse to start at
    // all, which would otherwise look like a slow boot until the timeout.
    const logs = await deps.docker.containerLogs(containerId, 40).catch(() => "");
    if (/FATAL:.*shared_preload_libraries|could not access file/i.test(logs)) {
      throw new Error(
        `Postgres refused to start with the new preload setting:\n${logs
          .split("\n")
          .filter((l) => /FATAL|ERROR/.test(l))
          .slice(-3)
          .join("\n")}`,
      );
    }
    if (result) last = (result.stderr || result.stdout).trim().split("\n")[0] || last;
    await sleep(1000, signal);
  }

  throw new Error(`Postgres did not come back after the restart. Last state: ${last}`);
}
