import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { DataPoolManager } from "../data/pool.js";
import type { Db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { quoteIdent } from "../data/identifiers.js";
import type { JobQueue } from "../jobs/queue.js";
import type { Logger } from "../logger.js";
import { parsePreload } from "../projects/container.js";
import { ProjectError } from "../projects/service.js";
import { EXTENSION_CATALOGUE, metaFor, type ExtensionCategory } from "./catalogue.js";

export interface ExtensionState {
  name: string;
  title: string;
  description: string | null;
  category: ExtensionCategory | null;
  docsUrl: string | null;
  /** Installed version, or null when the extension is available but not enabled. */
  installedVersion: string | null;
  /** Newest version this image can provide. */
  defaultVersion: string | null;
  /** True when an installed extension has a newer version available. */
  updateAvailable: boolean;
  /** Enabling or disabling this restarts the database. */
  requiresRestart: boolean;
  /** Already in `shared_preload_libraries` on this project. */
  preloaded: boolean;
  /** False when the image does not ship it at all. */
  availableInImage: boolean;
  comment: string | null;
}

export class ExtensionService {
  constructor(
    private readonly db: Db,
    private readonly pools: DataPoolManager,
    private readonly queue: JobQueue,
    private readonly logger: Logger,
  ) {}

  /**
   * What this project can run, and what it is running.
   *
   * Availability comes from the database rather than from a hardcoded list,
   * because it is a property of the image the project was created with — two
   * projects on the same host can legitimately differ.
   */
  async list(projectId: string): Promise<ExtensionState[]> {
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project || project.deletedAt) throw new ProjectError("not_found", "No such project.");

    const preloaded = new Set(parsePreload(project.preloadLibraries));

    const { rows } = await this.pools.query<{
      name: string;
      default_version: string | null;
      installed_version: string | null;
      comment: string | null;
    }>(
      projectId,
      `SELECT name, default_version, installed_version, comment
         FROM pg_available_extensions
        ORDER BY name`,
    );

    const states: ExtensionState[] = rows.map((row) => {
      const meta = metaFor(row.name);
      return {
        name: row.name,
        title: meta?.title ?? row.name,
        description: meta?.description ?? null,
        category: meta?.category ?? null,
        docsUrl: meta?.docsUrl ?? null,
        installedVersion: row.installed_version,
        defaultVersion: row.default_version,
        updateAvailable:
          row.installed_version !== null &&
          row.default_version !== null &&
          row.installed_version !== row.default_version,
        requiresRestart: meta?.preloadLibrary !== undefined,
        preloaded: meta?.preloadLibrary ? preloaded.has(meta.preloadLibrary) : false,
        availableInImage: true,
        comment: row.comment,
      };
    });

    // Curated extensions the image does not ship still appear, greyed out.
    // Silently omitting them turns "why can't I use PostGIS" into a support
    // question instead of an answer on the page.
    const present = new Set(states.map((s) => s.name));
    for (const meta of EXTENSION_CATALOGUE) {
      if (present.has(meta.name)) continue;
      states.push({
        name: meta.name,
        title: meta.title,
        description: meta.description,
        category: meta.category,
        docsUrl: meta.docsUrl ?? null,
        installedVersion: null,
        defaultVersion: null,
        updateAvailable: false,
        requiresRestart: meta.preloadLibrary !== undefined,
        preloaded: false,
        availableInImage: false,
        comment: null,
      });
    }

    return states.sort((a, b) => {
      // Installed first, then curated, then everything else alphabetically.
      const rank = (s: ExtensionState) =>
        s.installedVersion ? 0 : s.description ? 1 : 2;
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });
  }

  /**
   * Enable an extension.
   *
   * Returns immediately for the ordinary case. Extensions needing
   * `shared_preload_libraries` are queued as a job instead, because the only
   * way to load a library into Postgres is to start it again.
   */
  async enable(
    projectId: string,
    name: string,
    actor: string,
  ): Promise<{ mode: "immediate" | "restart"; version?: string }> {
    const project = this.requireRunning(projectId);
    const meta = metaFor(name);

    await this.assertAvailable(projectId, name);

    if (meta?.preloadLibrary) {
      this.queue.enqueue({
        type: "extension.enable",
        projectId,
        payload: { projectId, name },
        priority: 8,
        maxAttempts: 2,
      });
      this.logger.info({ ref: project.ref, name, actor }, "extension enable queued (needs a restart)");
      return { mode: "restart" };
    }

    // Identifier, not a parameter — and validated against pg_available_extensions
    // first, so the quoting is a second line of defence rather than the only one.
    await this.pools.query(projectId, `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(name)} CASCADE`);
    const version = await this.installedVersion(projectId, name);
    this.logger.info({ ref: project.ref, name, version, actor }, "extension enabled");
    return { mode: "immediate", ...(version ? { version } : {}) };
  }

  async disable(projectId: string, name: string, actor: string): Promise<void> {
    const project = this.requireRunning(projectId);
    await this.pools.query(projectId, `DROP EXTENSION IF EXISTS ${quoteIdent(name)}`);

    // The library stays in shared_preload_libraries. Removing it would need
    // another restart, and leaving it loaded costs a little memory and nothing
    // else — a second unrequested outage is the worse trade.
    this.logger.info({ ref: project.ref, name, actor }, "extension dropped");
  }

  async update(projectId: string, name: string, actor: string): Promise<string | null> {
    const project = this.requireRunning(projectId);
    await this.pools.query(projectId, `ALTER EXTENSION ${quoteIdent(name)} UPDATE`);
    const version = await this.installedVersion(projectId, name);
    this.logger.info({ ref: project.ref, name, version, actor }, "extension updated");
    return version;
  }

  private async installedVersion(projectId: string, name: string): Promise<string | null> {
    const { rows } = await this.pools.query<{ extversion: string }>(
      projectId,
      `SELECT extversion FROM pg_extension WHERE extname = $1`,
      [name],
    );
    return rows[0]?.extversion ?? null;
  }

  /** Reject a name the image cannot provide, before it reaches a SQL statement. */
  private async assertAvailable(projectId: string, name: string): Promise<void> {
    const { rows } = await this.pools.query<{ name: string }>(
      projectId,
      `SELECT name FROM pg_available_extensions WHERE name = $1`,
      [name],
    );
    if (rows.length === 0) {
      throw new ProjectError(
        "invalid_request",
        `This project's image does not provide the extension "${name}".`,
      );
    }
  }

  private requireRunning(projectId: string) {
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project || project.deletedAt) throw new ProjectError("not_found", "No such project.");
    if (project.state !== "running") {
      throw new ProjectError("invalid_state", `Project is ${project.state}; start it first.`);
    }
    return project;
  }
}
