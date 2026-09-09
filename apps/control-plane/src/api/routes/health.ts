import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { ComponentHealth, ComponentStatus, HealthReport } from "@justpostgres/shared";
import { formatBytes } from "../../storage/disk.js";
import type { AppContext, HonoEnv } from "../context.js";

/** Bound the check so a hung socket cannot hang the health endpoint itself. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function checkDatabase(ctx: AppContext): ComponentHealth {
  const started = Date.now();
  try {
    ctx.db.db.get(sql`select 1`);
    return { status: "ok", detail: "sqlite reachable", latencyMs: Date.now() - started };
  } catch (err) {
    return {
      status: "down",
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}

async function checkDocker(ctx: AppContext): Promise<ComponentHealth> {
  const started = Date.now();
  try {
    const version = await withTimeout(ctx.docker.ping(), 3000);
    return {
      status: "ok",
      detail: `docker ${version.serverVersion} (api ${version.apiVersion})`,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    // Deliberately not fatal. The control plane's job includes explaining that
    // Docker is down, which it cannot do if it refuses to start without it.
    return {
      status: "down",
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}

function checkWorker(ctx: AppContext): ComponentHealth {
  const status = ctx.worker.status();
  if (!status.running) return { status: "down", detail: "worker is not running" };

  const stalledFor = status.lastTickAt ? Date.now() - status.lastTickAt : null;
  const stallThreshold = Math.max(10_000, ctx.config.jobs.pollIntervalMs * 10);
  if (stalledFor !== null && stalledFor > stallThreshold) {
    return { status: "degraded", detail: `no poll for ${Math.round(stalledFor / 1000)}s` };
  }

  return {
    status: "ok",
    detail: `${status.inFlight}/${status.concurrency} in flight`,
  };
}

/**
 * Storage is reported from the verification done at boot, not re-run per
 * request: proving a copy-on-write root works means starting a container, and
 * a health endpoint that does that is a denial-of-service waiting to happen.
 * Anything that writes project data re-verifies on its own path.
 */
function checkStorage(ctx: AppContext): ComponentHealth {
  const status = ctx.dataStore.lastStatus();
  if (!status) return { status: "degraded", detail: "not verified yet" };
  return status.ok
    ? { status: "ok", detail: status.detail }
    : { status: "down", detail: status.detail };
}

/**
 * Free space, read from the background sample.
 *
 * "Degraded" rather than "down" when the reserve is gone: everything already
 * running keeps running, and only work that allocates is refused. Calling that
 * "down" would train an operator to ignore the word.
 */
function checkDisk(ctx: AppContext): ComponentHealth {
  const report = ctx.disk.latest();
  if (report.error) return { status: "degraded", detail: report.error };

  const tightest = report.tightest;
  if (!tightest) return { status: "degraded", detail: "no filesystem measured" };

  const summary = `${tightest.path}: ${formatBytes(tightest.freeBytes)} free of ${formatBytes(
    tightest.totalBytes,
  )} (${tightest.usedPercent}% used)`;

  return tightest.hasHeadroom
    ? { status: "ok", detail: summary }
    : {
        status: "degraded",
        detail: `${summary} — below the reserve, so new projects, branches and restores are refused`,
      };
}

function worstOf(...statuses: ComponentStatus[]): ComponentStatus {
  if (statuses.includes("down")) return "down";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

export function healthRoutes() {
  const app = new Hono<HonoEnv>();

  app.get("/", async (c) => {
    const ctx = c.get("ctx");
    const database = checkDatabase(ctx);
    const docker = await checkDocker(ctx);
    const worker = checkWorker(ctx);
    const storage = checkStorage(ctx);
    const disk = checkDisk(ctx);

    const report: HealthReport = {
      // Docker being unreachable is degraded, not down: the UI still works,
      // you just cannot provision until it comes back.
      status: worstOf(
        database.status,
        docker.status === "down" ? "degraded" : docker.status,
        worker.status,
        // Storage being unusable is not "the API is down", but it does mean
        // every provisioning request will fail, so it must not read as healthy.
        storage.status === "down" ? "degraded" : storage.status,
        disk.status,
      ),
      version: ctx.version,
      instanceId: ctx.worker.status().instanceId,
      uptimeSeconds: Math.floor((Date.now() - ctx.startedAt) / 1000),
      components: { database, docker, worker, storage, disk },
      filesystems: ctx.disk.latest().filesystems,
    };

    return c.json(
      { ...report, reconciler: ctx.reconciler.status() },
      report.status === "down" ? 503 : 200,
    );
  });

  return app;
}
