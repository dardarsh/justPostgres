import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import type { Project } from "@justpostgres/shared";
import type { BackupService } from "../backups/service.js";
import type { RestoreService } from "../backups/restore.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { credentials, projects, type ProjectRow } from "../db/schema.js";
import type { JobQueue } from "../jobs/queue.js";
import { generateProjectRef } from "../lib/crypto.js";
import type { Logger } from "../logger.js";
import type { DiskMonitor } from "../storage/disk.js";
import {
  backupVolumeName,
  containerName,
  networkName,
  volumeName,
} from "../projects/naming.js";
import { allocateHostPort } from "../projects/ports.js";
import { ProjectError, toProject } from "../projects/service.js";
import type { DataStore } from "../storage/datastore.js";

export interface BranchRequest {
  /** Epoch millis. Omitted branches from the current state. */
  targetTime?: number;
  name?: string;
  /** Hours until auto-deletion. 0 pins the branch indefinitely. */
  ttlHours?: number;
}

export interface BranchNode {
  project: Project;
  method: string | null;
  expiresAt: number | null;
  children: BranchNode[];
}

/**
 * Branching.
 *
 * Two strategies behind one verb, chosen by what is being asked for rather than
 * by configuration:
 *
 *  - **Copy-on-write**, when the host can snapshot and the branch point is
 *    *now*. Near-instant, and shares storage with the parent until either
 *    writes.
 *  - **Point-in-time restore**, otherwise. Works everywhere and can travel
 *    backwards to any moment in the recovery window, at a cost proportional to
 *    the size of the database.
 *
 * The second is M4's engine, unchanged. A restore and a branch really are the
 * same operation seen from two angles, which is why the data model has always
 * recorded a parent and a branch point rather than a "restore" flag.
 */
export class BranchService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly queue: JobQueue,
    private readonly restores: RestoreService,
    private readonly store: DataStore,
    private readonly logger: Logger,
    private readonly disk: DiskMonitor,
  ) {}

  /** Which strategy a given request will use, and why. */
  planFor(targetTime?: number): { method: "cow" | "pitr"; reason: string } {
    if (targetTime !== undefined) {
      return {
        method: "pitr",
        reason:
          "Branching from a point in the past needs the write-ahead log, which only a restore can replay.",
      };
    }
    if (!this.store.supportsSnapshot) {
      return {
        method: "pitr",
        reason:
          "This host has no copy-on-write filesystem configured, so the branch is rebuilt from the latest backup.",
      };
    }
    return {
      method: "cow",
      reason: `Cloned copy-on-write from the live data directory (${this.store.kind}).`,
    };
  }

  async create(sourceProjectId: string, request: BranchRequest, actor: string): Promise<Project> {
    // A copy-on-write branch starts out nearly free, which makes it the easiest
    // way to fill a disk without noticing: it costs nothing until both sides
    // start writing, and then it costs twice.
    this.disk.assertCanAllocate("create a branch");

    const source = this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, sourceProjectId), isNull(projects.deletedAt)))
      .get();
    if (!source) throw new ProjectError("not_found", "No such project.");

    const plan = this.planFor(request.targetTime);

    // A point-in-time branch is exactly a restore, so it goes through the same
    // service rather than a parallel implementation that would drift from it.
    if (plan.method === "pitr") {
      const project = await this.restores.start(
        {
          sourceProjectId,
          ...(request.targetTime !== undefined ? { targetTime: request.targetTime } : {}),
          ...(request.name ? { name: request.name } : {}),
        },
        actor,
      );
      this.applyBranchMetadata(project.id, "pitr", request.ttlHours);
      return { ...project, ...this.readBranchFields(project.id) };
    }

    if (source.state !== "running") {
      throw new ProjectError(
        "invalid_state",
        `Project is ${source.state}; a copy-on-write branch clones a running data directory.`,
      );
    }

    const credential = this.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.projectId, source.id), eq(credentials.isPrimary, true)))
      .get();
    if (!credential) throw new ProjectError("not_found", "Source project has no stored credentials.");

    const ref = this.uniqueRef();
    const id = randomUUID();
    const hostPort = await allocateHostPort(this.db, this.config);
    const now = Date.now();

    const row = this.db.transaction((tx) => {
      const created = tx
        .insert(projects)
        .values({
          id,
          ref,
          name: request.name?.trim() || `${source.name}-branch`,
          pgMajor: source.pgMajor,
          image: source.image,
          state: "creating",
          containerName: containerName(ref),
          volumeName: volumeName(ref),
          networkName: networkName(ref),
          backupVolumeName: backupVolumeName(ref),
          hostPort,
          memoryBytes: source.memoryBytes,
          nanoCpus: source.nanoCpus,
          // Inherited, not reset. A copy of a database that had pg_cron loaded
          // still contains pg_cron in its catalog, so starting it without the
          // library preloaded produces an extension whose functions all fail —
          // a copy that is subtly, silently not equivalent to its original.
          preloadLibraries: source.preloadLibraries,
          parentProjectId: source.id,
          branchPoint: now,
          branchMethod: "cow",
          expiresAt: this.expiryFor(request.ttlHours),
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      // The clone contains the parent's `pg_authid`, so its roles keep the
      // parent's passwords — same reasoning as a restore.
      tx.insert(credentials)
        .values({
          id: randomUUID(),
          projectId: id,
          role: credential.role,
          database: credential.database,
          passwordEnc: credential.passwordEnc,
          isPrimary: true,
          createdAt: now,
        })
        .run();

      return created;
    });

    this.queue.enqueue({
      type: "branch.run",
      projectId: id,
      payload: { targetProjectId: id, sourceProjectId: source.id },
      priority: 10,
      maxAttempts: 2,
    });

    this.logger.info({ branch: ref, source: source.ref, method: "cow", actor }, "branch enqueued");
    return toProject(row);
  }

  /** Keep a branch past its expiry, or set a new one. */
  setExpiry(projectId: string, ttlHours: number | null): Project {
    const row = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!row || row.deletedAt) throw new ProjectError("not_found", "No such project.");
    if (!row.parentProjectId) {
      throw new ProjectError("invalid_state", "Only a branch can expire.");
    }

    const updated = this.db
      .update(projects)
      .set({
        expiresAt: ttlHours === null || ttlHours === 0 ? null : Date.now() + ttlHours * 3600_000,
        updatedAt: Date.now(),
      })
      .where(eq(projects.id, projectId))
      .returning()
      .get();

    return toProject(updated);
  }

  /**
   * Delete branches whose time is up.
   *
   * Branches are made to be thrown away, and the ones nobody throws away are
   * exactly the ones that quietly fill a host — a forgotten clone of a
   * production database is both a cost and a copy of the data nobody is
   * thinking about. Pinning is a deliberate act; keeping is not the default.
   */
  expireDue(deleteProject: (id: string, actor: string) => unknown): number {
    const due = this.db
      .select()
      .from(projects)
      .where(
        and(
          isNull(projects.deletedAt),
          isNotNull(projects.expiresAt),
          lte(projects.expiresAt, Date.now()),
        ),
      )
      .all();

    let deleted = 0;
    for (const branch of due) {
      // A branch that has been promoted into another project's identity is no
      // longer a throwaway copy; expiring it would delete production.
      if (branch.state === "creating" || branch.state === "deleting") continue;

      try {
        deleteProject(branch.id, "system:branch-expiry");
        this.logger.info(
          { ref: branch.ref, name: branch.name, expiredAt: branch.expiresAt },
          "expired branch deleted",
        );
        deleted++;
      } catch (err) {
        this.logger.error({ err, ref: branch.ref }, "could not delete an expired branch");
      }
    }
    return deleted;
  }

  /** The lineage of a project: its ancestors' root, and every descendant. */
  tree(projectId: string): BranchNode | null {
    const all = this.db.select().from(projects).where(isNull(projects.deletedAt)).all();
    const byId = new Map(all.map((row) => [row.id, row]));

    let root = byId.get(projectId);
    if (!root) return null;
    const seen = new Set<string>();
    while (root.parentProjectId && byId.has(root.parentProjectId) && !seen.has(root.id)) {
      seen.add(root.id);
      root = byId.get(root.parentProjectId)!;
    }

    const build = (row: ProjectRow): BranchNode => ({
      project: toProject(row),
      method: row.branchMethod,
      expiresAt: row.expiresAt,
      children: all.filter((c) => c.parentProjectId === row.id).map(build),
    });

    return build(root);
  }

  private applyBranchMetadata(projectId: string, method: string, ttlHours?: number): void {
    this.db
      .update(projects)
      .set({ branchMethod: method, expiresAt: this.expiryFor(ttlHours), updatedAt: Date.now() })
      .where(eq(projects.id, projectId))
      .run();
  }

  private readBranchFields(projectId: string): Partial<Project> {
    const row = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    return row ? toProject(row) : {};
  }

  private expiryFor(ttlHours?: number): number | null {
    const hours = ttlHours ?? this.config.branches.ttlHours;
    return hours > 0 ? Date.now() + hours * 3600_000 : null;
  }

  private uniqueRef(): string {
    for (let i = 0; i < 10; i++) {
      const ref = generateProjectRef();
      if (!this.db.select({ id: projects.id }).from(projects).where(eq(projects.ref, ref)).get()) {
        return ref;
      }
    }
    throw new ProjectError("conflict", "Could not generate a unique project ref.");
  }
}
