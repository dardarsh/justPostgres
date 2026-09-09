import { and, eq, isNull, notInArray } from "drizzle-orm";
import { TRANSIENT_PROJECT_STATES, type ProjectState } from "@justpostgres/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { projects, upgrades } from "../db/schema.js";
import type { DockerDriver } from "../docker/driver.js";
import type { Logger } from "../logger.js";

export interface ReconcileReport {
  checked: number;
  repaired: number;
  orphanContainers: string[];
  orphanVolumes: string[];
  errors: number;
}

/**
 * Diff desired state (the metadata store) against actual state (Docker), and
 * repair what it can.
 *
 * In a container-per-project design the failure mode is always drift: a
 * container OOM-killed overnight, a volume left behind by a job that died, a
 * project marked running whose container no longer exists. Nothing else in the
 * system notices any of that, because nothing else looks. This loop is the
 * operational hygiene the whole design leans on (ARCHITECTURE §3).
 */
export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastReport: ReconcileReport | null = null;
  private lastRunAt: number | null = null;
  private dockerUnreachableSince: number | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly docker: DockerDriver,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.config.reconcileIntervalMs);
    this.timer.unref();
    this.logger.info({ intervalMs: this.config.reconcileIntervalMs }, "reconciler started");
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): {
    running: boolean;
    lastRunAt: number | null;
    lastReport: ReconcileReport | null;
    dockerUnreachableSince: number | null;
  } {
    return {
      running: this.timer !== null,
      lastRunAt: this.lastRunAt,
      lastReport: this.lastReport,
      dockerUnreachableSince: this.dockerUnreachableSince,
    };
  }

  async runOnce(): Promise<ReconcileReport> {
    if (this.running) return this.lastReport ?? emptyReport();
    this.running = true;

    const report = emptyReport();
    try {
      // Projects mid-job are owned by that job; touching them here would race
      // provisioning against reconciliation and lose.
      const rows = this.db
        .select()
        .from(projects)
        // Driven off the shared list rather than named here, so a new
        // job-owned state cannot be added without the reconciler learning to
        // keep its hands off it.
        .where(and(isNull(projects.deletedAt), notInArray(projects.state, [...TRANSIENT_PROJECT_STATES])))
        .all();

      const knownContainerIds = new Set<string>();
      const knownVolumeNames = new Set<string>();

      // Data directories kept from before a major-version upgrade are deliberate
      // and tracked in `upgrades`, not on the project row. Without this they
      // read as orphans, and an operator who is told every ten minutes that a
      // volume is orphaned will eventually delete the one thing standing
      // between them and a bad upgrade.
      for (const retained of this.db
        .select({ volume: upgrades.previousVolumeName })
        .from(upgrades)
        .where(isNull(upgrades.previousDiscardedAt))
        .all()) {
        if (retained.volume) knownVolumeNames.add(retained.volume);
      }

      for (const row of rows) {
        report.checked++;
        if (row.volumeName) knownVolumeNames.add(row.volumeName);

        try {
          const repaired = await this.reconcileProject(row.id, row.containerId, row.state as ProjectState, row.ref);
          if (row.containerId) knownContainerIds.add(row.containerId);
          if (repaired) report.repaired++;
        } catch (err) {
          report.errors++;
          this.logger.error({ err, projectId: row.id, ref: row.ref }, "reconcile failed for project");
        }
      }

      await this.findOrphans(knownContainerIds, knownVolumeNames, report);
      this.dockerUnreachableSince = null;
    } catch (err) {
      report.errors++;
      if (isDockerUnreachable(err)) {
        // Expected while the daemon is restarting or simply not running. Say it
        // once, then stay quiet, rather than filling the log with a stack trace
        // every interval.
        if (this.dockerUnreachableSince === null) {
          this.dockerUnreachableSince = Date.now();
          this.logger.warn(
            "docker is unreachable; reconciliation is paused until it returns",
          );
        }
      } else {
        this.logger.error({ err }, "reconcile pass failed");
      }
    } finally {
      this.running = false;
      this.lastRunAt = Date.now();
      this.lastReport = report;
    }

    if (report.repaired > 0 || report.orphanContainers.length > 0 || report.orphanVolumes.length > 0) {
      this.logger.info(report, "reconcile pass found drift");
    }
    return report;
  }

  /** Returns true when the stored state was wrong and has been corrected. */
  private async reconcileProject(
    id: string,
    containerId: string | null,
    state: ProjectState,
    ref: string,
  ): Promise<boolean> {
    if (!containerId) {
      if (state === "failed") return false;
      this.setState(id, "failed", "Project has no container recorded.");
      this.logger.warn({ projectId: id, ref }, "project has no container; marked failed");
      return true;
    }

    const info = await this.docker.inspectContainer(containerId);

    if (!info) {
      if (state === "failed") return false;
      this.setState(id, "failed", "Container no longer exists on this host.");
      this.logger.warn({ projectId: id, ref, containerId }, "container vanished; marked failed");
      return true;
    }

    if (info.running && state === "stopped") {
      this.setState(id, "running", null);
      this.logger.info({ projectId: id, ref }, "container is running; state corrected");
      return true;
    }

    // A `failed` project is never promoted back to `running` just because a
    // container happens to be up. That mistake made a restore whose final steps
    // had failed present as a perfectly healthy project — which for a backup
    // tool is the worst possible way to be wrong. `failed` is a claim about
    // what the control plane did, and only an explicit action or a successful
    // job clears it.
    if (info.running && state === "failed") {
      this.logger.debug(
        { projectId: id, ref },
        "container is running but the project is marked failed; leaving it alone",
      );
      return false;
    }

    if (!info.running && state === "running") {
      // Almost always an OOM kill or a crash loop. The restart policy will
      // usually bring it back; recording the truth in the meantime is what
      // lets the UI say something honest.
      this.setState(id, "stopped", `Container is not running (${info.status}).`);
      this.logger.warn({ projectId: id, ref, status: info.status }, "container stopped unexpectedly");
      return true;
    }

    return false;
  }

  /**
   * Report Docker objects we own but no live project claims.
   *
   * Containers and networks are reported, not removed, and volumes especially
   * so: an orphaned volume is somebody's data, and an automatic reaper that is
   * wrong once is worse than a warning that is ignored a hundred times.
   * Cleaning them up is an explicit action, never a background one.
   */
  private async findOrphans(
    knownContainerIds: Set<string>,
    knownVolumeNames: Set<string>,
    report: ReconcileReport,
  ): Promise<void> {
    const managed = { "io.justpostgres.managed": "true" };

    const containers = await this.docker.listContainers(managed);
    for (const container of containers) {
      if (!knownContainerIds.has(container.id)) report.orphanContainers.push(container.name);
    }

    const volumes = await this.docker.listVolumes(managed);
    for (const volume of volumes) {
      if (!knownVolumeNames.has(volume.name)) report.orphanVolumes.push(volume.name);
    }

    if (report.orphanVolumes.length > 0) {
      this.logger.warn(
        { volumes: report.orphanVolumes },
        "orphaned volumes found; these hold data and are never removed automatically",
      );
    }
  }

  private setState(id: string, state: ProjectState, lastError: string | null): void {
    this.db
      .update(projects)
      .set({ state, lastError, updatedAt: Date.now() })
      .where(eq(projects.id, id))
      .run();
  }
}

/** Distinguish "the daemon is not there" from a real reconciliation bug. */
function isDockerUnreachable(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOENT" ||
    code === "EACCES" ||
    code === "ECONNRESET" ||
    code === "EPIPE"
  );
}

function emptyReport(): ReconcileReport {
  return { checked: 0, repaired: 0, orphanContainers: [], orphanVolumes: [], errors: 0 };
}
