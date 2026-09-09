import { eq } from "drizzle-orm";
import { z } from "zod";
import type { JobProgress } from "@justpostgres/shared";
import type { DataPoolManager } from "../../data/pool.js";
import { apiConfigs, projects } from "../../db/schema.js";
import { decryptSecret } from "../../lib/crypto.js";
import { DEFAULT_DATABASE, physicalNames } from "../../projects/naming.js";
import { bootstrapApiRoles, bootstrapAuthSchema } from "../../rest/bootstrap.js";
import { AUTHENTICATOR_ROLE } from "../../rest/jwt.js";
import { allocateHostPort } from "../../projects/ports.js";
import { restContainerName, REST_PORT } from "../../rest/service.js";
import type { JobDeps } from "../deps.js";
import { JobCancelledError, type JobContext, type JobHandler } from "../registry.js";

const payloadSchema = z.object({ projectId: z.string().uuid() });
type Payload = z.infer<typeof payloadSchema>;

const STEPS = ["roles", "auth_schema", "container", "ready"] as const;

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
 * Bring a project's REST API up.
 *
 * PostgREST runs as its own container on the project's own Docker network, so
 * it reaches Postgres by container name and the database's own port is not
 * involved. Its own port is published on the host's **loopback interface only**
 * — the control plane's proxy has to be able to reach it, and the proxy may be
 * running on the host rather than on the project's network, but nothing on the
 * network can.
 *
 * The container is recreated on every run rather than reused. PostgREST reads
 * its JWT secret and database password once at startup, so after a key rotation
 * a surviving container would still be trusting the old secret.
 */
export function createRestEnableHandler(
  deps: JobDeps,
  pools: DataPoolManager,
): JobHandler<Payload> {
  const { db, config, docker } = deps;

  return {
    type: "rest.enable",
    payloadSchema,

    async run({ payload, logger, signal, resumeFrom, checkpoint, throwIfCancelled }: JobContext<Payload>) {
      const project = db.select().from(projects).where(eq(projects.id, payload.projectId)).get();
      if (!project || project.deletedAt) {
        return { percent: 100, message: "Project no longer exists", checkpoint: {} };
      }

      const apiConfig = db
        .select()
        .from(apiConfigs)
        .where(eq(apiConfigs.projectId, project.id))
        .get();
      if (!apiConfig) throw new Error("The API is not configured for this project.");

      const names = physicalNames(project);
      const authenticatorPassword = decryptSecret(
        apiConfig.authenticatorPasswordEnc,
        config.masterKey,
      );
      const jwtSecret = decryptSecret(apiConfig.jwtSecretEnc, config.masterKey);

      let step =
        typeof resumeFrom?.checkpoint?.completedSteps === "number"
          ? resumeFrom.checkpoint.completedSteps
          : 0;

      try {
        if (step < 1) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Creating the API roles"));
          await pools.withClient(project.id, (client) =>
            bootstrapApiRoles(client, authenticatorPassword),
          );
          checkpoint(progressFor((step = 1), "Roles created"));
        }

        if (step < 2) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Installing the auth helpers"));
          await pools.withClient(project.id, (client) => bootstrapAuthSchema(client));
          checkpoint(progressFor((step = 2), "auth.uid() and friends are available"));
        }

        if (step < 3) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Starting PostgREST"));

          const containerName = restContainerName(project.ref);
          const existing = await docker.listContainers({
            "io.justpostgres.project-id": project.id,
            "io.justpostgres.role": "rest",
          });
          for (const container of existing) {
            await docker.removeContainer(container.id, { force: true }).catch(() => {});
          }

          // A port on the host, bound to loopback. The proxy is the intended
          // route in and this port is not reachable from the network, but the
          // proxy has to be able to reach the container — and it may be running
          // on the host rather than on the project's Docker network.
          const hostPort = apiConfig.hostPort ?? (await allocateHostPort(db, config));

          const containerId = await docker.createContainer({
            name: containerName,
            image: config.rest.image,
            env: {
              // By container name on the project's own network: PostgREST never
              // touches the database's published host port.
              PGRST_DB_URI: `postgres://${AUTHENTICATOR_ROLE}:${encodeURIComponent(
                authenticatorPassword,
              )}@${names.container}:5432/${DEFAULT_DATABASE}`,
              PGRST_DB_SCHEMAS: apiConfig.schemas,
              PGRST_DB_ANON_ROLE: "anon",
              PGRST_JWT_SECRET: jwtSecret,
              PGRST_DB_MAX_ROWS: String(apiConfig.maxRows),
              PGRST_SERVER_PORT: String(REST_PORT),
              // The schema cache is rebuilt when the control plane tells it to,
              // after a migration through the SQL editor.
              PGRST_DB_CHANNEL_ENABLED: "true",
              PGRST_OPENAPI_MODE: "follow-privileges",
              PGRST_LOG_LEVEL: "error",
              // PostgREST is a Haskell program, and the GHC runtime does not
              // return freed memory to the OS — it grows its heap until it
              // approaches whatever ceiling exists and then plateaus there.
              // Measured: 35 MiB from cold, 114 MiB after a few hours against a
              // 128 MiB container limit, and stable at 89% of its cap. That is
              // not a leak, but it leaves no room for a burst, and the kernel's
              // answer to running out is to kill the process mid-request.
              //
              // Bounding the heap makes the runtime collect instead of grow,
              // and turns the failure mode from a silent OOM kill into a heap
              // overflow that says so in the log. The container limit below
              // stays comfortably above this so non-heap memory has somewhere
              // to live.
              GHCRTS: "-M96m",
            },
            labels: {
              "io.justpostgres.managed": "true",
              "io.justpostgres.project-id": project.id,
              "io.justpostgres.project-ref": project.ref,
              "io.justpostgres.role": "rest",
            },
            volumes: {},
            ports: { [REST_PORT]: hostPort },
            portBindAddress: "127.0.0.1",
            network: names.network,
            memoryBytes: 192 * 1024 * 1024,
            nanoCpus: Math.round(0.5 * 1e9),
            restartPolicy: "unless-stopped",
          });

          db.update(apiConfigs)
            .set({ containerId, containerName, hostPort, updatedAt: Date.now() })
            .where(eq(apiConfigs.projectId, project.id))
            .run();

          await docker.startContainer(containerId);
          checkpoint(progressFor((step = 3), "PostgREST started"));
        }

        const containerId = db
          .select({ id: apiConfigs.containerId })
          .from(apiConfigs)
          .where(eq(apiConfigs.projectId, project.id))
          .get()?.id;
        if (!containerId) throw new Error("PostgREST lost its container id.");

        if (step < 4) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Waiting for the API to answer"));
          await waitReady(deps, containerId, signal);
          checkpoint(progressFor((step = 4), "API is answering"));
        }

        db.update(apiConfigs)
          .set({ enabled: true, lastError: null, updatedAt: Date.now() })
          .where(eq(apiConfigs.projectId, project.id))
          .run();

        logger.info({ ref: project.ref }, "REST API enabled");
        return { percent: 100, message: "REST API is live", checkpoint: { completedSteps: 4 } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        db.update(apiConfigs)
          .set({ lastError: message, updatedAt: Date.now() })
          .where(eq(apiConfigs.projectId, project.id))
          .run();
        throw err;
      }
    },
  };
}

async function waitReady(deps: JobDeps, containerId: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 90_000;
  let last = "starting";

  while (Date.now() < deadline) {
    if (signal.aborted) throw new JobCancelledError();

    // The image has no shell, so readiness is judged from the container's own
    // state and log output rather than by running a command inside it.
    const info = await deps.docker.inspectContainer(containerId).catch(() => null);
    const logs = await deps.docker.containerLogs(containerId, 40).catch(() => "");

    if (/Listening on port|Connection successful|Schema cache loaded/i.test(logs)) return;
    if (/FATAL|fatal error|Database connection lost/i.test(logs)) {
      throw new Error(
        `PostgREST failed to start:\n${logs.split("\n").filter(Boolean).slice(-4).join("\n")}`,
      );
    }
    if (info && !info.running) {
      throw new Error(
        `PostgREST exited immediately:\n${logs.split("\n").filter(Boolean).slice(-4).join("\n")}`,
      );
    }
    last = info?.status ?? last;
    await sleep(1000, signal);
  }

  throw new Error(`PostgREST did not become ready. Last container state: ${last}`);
}
