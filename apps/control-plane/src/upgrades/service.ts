import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { PG_MAJOR_VERSIONS } from "@justpostgres/shared";
import type { BackupService } from "../backups/service.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { projects, upgrades, type UpgradeRow } from "../db/schema.js";
import type { DockerDriver } from "../docker/driver.js";
import type { JobQueue } from "../jobs/queue.js";
import type { Logger } from "../logger.js";
import { imageFor } from "../projects/naming.js";
import { ProjectError } from "../projects/service.js";
import type { DiskMonitor } from "../storage/disk.js";

/**
 * Moving a project to a newer Postgres major version.
 *
 * The mechanism is a logical dump and restore, not `pg_upgrade`, and that is a
 * consequence of the image design rather than a preference. `pg_upgrade` needs
 * the old *and* new binaries present at once; justpostgres ships one major per
 * image, deliberately, so that a project's version is pinned by its image tag.
 * Building a combined image for every upgrade pair, or shipping every major in
 * every image, both cost more than the thing they buy — and the thing they buy
 * is speed on an operation performed roughly once a year per project.
 *
 * What the dump path costs is downtime proportional to the size of the data,
 * and the user is told that before they start rather than discovering it.
 *
 * What it buys, besides simplicity: the old data directory is never written to.
 * A failed upgrade is recovered by starting the old container again, which is a
 * far better position than a half-finished in-place conversion.
 */

export interface UpgradePlan {
  fromMajor: number;
  toMajor: number;
  targetImage: string;
  imageAvailable: boolean;
  /** What the operator is agreeing to, in the order it will happen. */
  steps: string[];
  warnings: string[];
}

export class UpgradeService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly docker: DockerDriver,
    private readonly queue: JobQueue,
    private readonly backups: BackupService,
    private readonly disk: DiskMonitor,
    private readonly logger: Logger,
  ) {}

  history(projectId: string): UpgradeRow[] {
    return this.db
      .select()
      .from(upgrades)
      .where(eq(upgrades.projectId, projectId))
      .orderBy(desc(upgrades.startedAt))
      .all();
  }

  latest(projectId: string): UpgradeRow | null {
    return this.history(projectId)[0] ?? null;
  }

  /** What an upgrade to `toMajor` would involve, without starting one. */
  async plan(projectId: string, toMajor: number): Promise<UpgradePlan> {
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project || project.deletedAt) throw new ProjectError("not_found", "No such project.");

    if (!PG_MAJOR_VERSIONS.includes(toMajor as (typeof PG_MAJOR_VERSIONS)[number])) {
      throw new ProjectError(
        "invalid_request",
        `Postgres ${toMajor} is not one of the supported versions (${PG_MAJOR_VERSIONS.join(", ")}).`,
      );
    }
    if (toMajor <= project.pgMajor) {
      throw new ProjectError(
        "invalid_request",
        `This project is on Postgres ${project.pgMajor}. Downgrading is not something a dump from a ` +
          `newer server can do reliably, so only upgrades are offered.`,
      );
    }

    const targetImage = imageFor(this.config, toMajor);
    const imageAvailable = await this.docker.imageExists(targetImage).catch(() => false);

    const warnings: string[] = [];
    if (!imageAvailable) {
      warnings.push(
        `The image ${targetImage} is not on this host. Build it first: images/postgres/build.sh ${toMajor}`,
      );
    }

    const backupConfig = this.backups.get(project.id);
    if (backupConfig?.awaitingFirstBackup) {
      warnings.push(
        "This project has no completed backup yet, so there is nothing to fall back to besides the " +
          "retained old data directory. Take a backup first.",
      );
    }

    warnings.push(
      "The database is unavailable from the moment the dump finishes until the new version has " +
        "loaded it. How long that takes is proportional to the size of the data, not to the version gap.",
    );
    warnings.push(
      `Backups taken on Postgres ${project.pgMajor} cannot restore into ${toMajor}. The repository is ` +
        "upgraded and a fresh full backup is taken immediately, but until that finishes the project " +
        "has no valid recovery point.",
    );

    return {
      fromMajor: project.pgMajor,
      toMajor,
      targetImage,
      imageAvailable,
      steps: [
        `Take a final backup on Postgres ${project.pgMajor}`,
        "Record what the old cluster contains, to check against afterwards",
        "Dump every database and role",
        "Stop the old container, keeping its data directory intact",
        `Start an empty Postgres ${toMajor} cluster on a new data directory`,
        "Load the dump and compare object counts against the record",
        "Upgrade the backup repository and take a full backup",
      ],
      warnings,
    };
  }

  /**
   * Queue the upgrade.
   *
   * The plan is re-checked here rather than trusted from the client: the UI
   * showing a plan and the operator confirming it are separated by however long
   * they spent reading it, and a missing image is exactly the kind of thing
   * that changes in between.
   */
  async start(projectId: string, toMajor: number, actor: string): Promise<UpgradeRow> {
    const plan = await this.plan(projectId, toMajor);
    if (!plan.imageAvailable) {
      throw new ProjectError(
        "invalid_state",
        `The image ${plan.targetImage} is not on this host. Build it first: ` +
          `images/postgres/build.sh ${toMajor}`,
      );
    }

    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()!;
    if (project.state !== "running") {
      throw new ProjectError(
        "invalid_state",
        `The project is ${project.state}. An upgrade has to dump a running database.`,
      );
    }

    const active = this.latest(projectId);
    if (active?.state === "running") {
      throw new ProjectError("conflict", "An upgrade is already in progress for this project.");
    }

    // A dump and a second copy of the data both land on disk before anything is
    // freed, so this needs room for roughly two more copies of the database.
    this.disk.assertCanAllocate(`upgrade to Postgres ${toMajor}`);

    const row = this.db
      .insert(upgrades)
      .values({
        id: randomUUID(),
        projectId,
        fromMajor: project.pgMajor,
        toMajor,
        state: "running",
        previousImage: project.image,
        startedAt: Date.now(),
      })
      .returning()
      .get();

    const job = this.queue.enqueue({
      type: "project.upgrade",
      projectId,
      payload: { projectId, upgradeId: row.id, toMajor },
      priority: 9,
      // Deliberately one attempt. A half-finished upgrade must be looked at by
      // a person, not retried blindly into a second half-finished upgrade.
      maxAttempts: 1,
    });

    this.db.update(upgrades).set({ jobId: job.id }).where(eq(upgrades.id, row.id)).run();
    this.logger.info({ projectId, from: project.pgMajor, to: toMajor, actor }, "upgrade queued");

    return { ...row, jobId: job.id };
  }

  /**
   * Delete the data directory kept from before an upgrade.
   *
   * Never automatic. The whole value of retaining it is that it is still there
   * on the day someone notices something is missing, which is not the day of
   * the upgrade.
   */
  async discardPrevious(upgradeId: string, actor: string): Promise<void> {
    const row = this.db.select().from(upgrades).where(eq(upgrades.id, upgradeId)).get();
    if (!row) throw new ProjectError("not_found", "No such upgrade.");
    if (!row.previousVolumeName || row.previousDiscardedAt) {
      throw new ProjectError("invalid_state", "There is no retained data directory to discard.");
    }
    if (row.state !== "succeeded") {
      throw new ProjectError(
        "invalid_state",
        "This upgrade did not succeed, so its old data directory is the live one. Discarding it " +
          "would delete the database.",
      );
    }

    await this.docker.removeVolume(row.previousVolumeName, { force: true });
    this.db
      .update(upgrades)
      .set({ previousDiscardedAt: Date.now() })
      .where(eq(upgrades.id, upgradeId))
      .run();

    this.logger.warn(
      { upgradeId, volume: row.previousVolumeName, actor },
      "pre-upgrade data directory deleted",
    );
  }
}
