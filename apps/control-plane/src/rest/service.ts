import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { DataPoolManager } from "../data/pool.js";
import type { Db } from "../db/index.js";
import { apiConfigs, projects, type ApiConfigRow } from "../db/schema.js";
import type { DockerDriver } from "../docker/driver.js";
import type { JobQueue } from "../jobs/queue.js";
import { decryptSecret, encryptSecret, generateDatabasePassword } from "../lib/crypto.js";
import type { Logger } from "../logger.js";
import { physicalNames } from "../projects/naming.js";
import { ProjectError } from "../projects/service.js";
import { generateJwtSecret, issueKeys } from "./jwt.js";
import { revokeApiAccess } from "./bootstrap.js";

export interface ApiStatus {
  enabled: boolean;
  running: boolean;
  schemas: string;
  maxRows: number;
  keyVersion: number;
  lastError: string | null;
  /** Where requests go. Path form always works; hostname needs wildcard DNS. */
  endpoints: { path: string; host: string | null };
  /** Only returned when explicitly revealed. */
  keys?: { anon: string; service: string };
}

export const restContainerName = (ref: string) => `jp-${ref}-rest`;
/** PostgREST's port inside its container, mapped to a loopback host port. */
export const REST_PORT = 3000;

export class RestService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly docker: DockerDriver,
    private readonly pools: DataPoolManager,
    private readonly queue: JobQueue,
    private readonly logger: Logger,
  ) {}

  get(projectId: string): ApiConfigRow | null {
    return this.db.select().from(apiConfigs).where(eq(apiConfigs.projectId, projectId)).get() ?? null;
  }

  async status(projectId: string, opts: { reveal?: boolean } = {}): Promise<ApiStatus | null> {
    const row = this.get(projectId);
    if (!row) return null;

    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    const running =
      row.enabled && row.containerId
        ? Boolean((await this.docker.inspectContainer(row.containerId).catch(() => null))?.running)
        : false;

    const status: ApiStatus = {
      enabled: row.enabled,
      running,
      schemas: row.schemas,
      maxRows: row.maxRows,
      keyVersion: row.keyVersion,
      lastError: row.lastError,
      endpoints: {
        path: `/rest/${project?.ref ?? ""}/`,
        host: this.config.rest.domainSuffix && project ? `${project.ref}.${this.config.rest.domainSuffix}` : null,
      },
    };

    if (opts.reveal) {
      const secret = decryptSecret(row.jwtSecretEnc, this.config.masterKey);
      status.keys = issueKeys(secret, row.keyVersion);
    }
    return status;
  }

  /**
   * Turn the API on.
   *
   * Queued as a job rather than done inline: it creates roles, installs an
   * `auth` schema and starts another container, and the user should see it
   * progress rather than watch a request hang.
   */
  enable(projectId: string, actor: string): ApiConfigRow {
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project || project.deletedAt) throw new ProjectError("not_found", "No such project.");
    if (project.state !== "running") {
      throw new ProjectError("invalid_state", `Project is ${project.state}; start it first.`);
    }

    const existing = this.get(projectId);
    const now = Date.now();

    const row =
      existing ??
      this.db
        .insert(apiConfigs)
        .values({
          projectId,
          enabled: false,
          jwtSecretEnc: encryptSecret(generateJwtSecret(), this.config.masterKey),
          authenticatorPasswordEnc: encryptSecret(
            generateDatabasePassword(32),
            this.config.masterKey,
          ),
          containerName: restContainerName(project.ref),
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

    this.queue.enqueue({
      type: "rest.enable",
      projectId,
      payload: { projectId },
      priority: 8,
      maxAttempts: 2,
    });

    this.logger.info({ ref: project.ref, actor }, "REST API enable queued");
    return row;
  }

  /**
   * Turn it off.
   *
   * The container goes and the grants are revoked, so the database is private
   * again even if something later restarts a container by hand. The signing
   * secret is kept: re-enabling should not silently invalidate every key an
   * application is already configured with.
   */
  async disable(projectId: string, actor: string): Promise<void> {
    const row = this.get(projectId);
    if (!row) throw new ProjectError("not_found", "The API is not configured for this project.");

    if (row.containerId) {
      await this.docker.stopContainer(row.containerId, 15).catch(() => {});
      await this.docker.removeContainer(row.containerId, { force: true }).catch(() => {});
    }

    await this.pools
      .withClient(projectId, (client) => revokeApiAccess(client))
      .catch((err) => this.logger.warn({ err }, "could not revoke API grants; container is already gone"));

    this.db
      .update(apiConfigs)
      .set({ enabled: false, containerId: null, lastError: null, updatedAt: Date.now() })
      .where(eq(apiConfigs.projectId, projectId))
      .run();

    this.logger.info({ projectId, actor }, "REST API disabled");
  }

  /**
   * Issue a new signing secret, invalidating every existing key.
   *
   * Deliberately abrupt: rotation exists for the case where a key has leaked,
   * and a grace period during which the leaked key still works would defeat the
   * purpose. Applications must be updated.
   */
  async rotateKeys(projectId: string, actor: string): Promise<{ anon: string; service: string }> {
    const row = this.get(projectId);
    if (!row) throw new ProjectError("not_found", "The API is not configured for this project.");

    const secret = generateJwtSecret();
    const keyVersion = row.keyVersion + 1;

    this.db
      .update(apiConfigs)
      .set({
        jwtSecretEnc: encryptSecret(secret, this.config.masterKey),
        keyVersion,
        updatedAt: Date.now(),
      })
      .where(eq(apiConfigs.projectId, projectId))
      .run();

    // PostgREST reads the secret at startup, so the running container still
    // trusts the old one until it is replaced.
    if (row.enabled) {
      this.queue.enqueue({
        type: "rest.enable",
        projectId,
        payload: { projectId },
        priority: 9,
        maxAttempts: 2,
      });
    }

    this.logger.info({ projectId, keyVersion, actor }, "API keys rotated");
    return issueKeys(secret, keyVersion);
  }

  /** Where a proxied request should be forwarded. */
  async targetFor(ref: string): Promise<{ projectId: string; host: string; port: number } | null> {
    const project = this.db.select().from(projects).where(eq(projects.ref, ref)).get();
    if (!project || project.deletedAt) return null;

    const row = this.get(project.id);
    if (!row?.enabled || row.hostPort === null) return null;

    // The same host the data browser uses to reach a project's Postgres:
    // loopback when the control plane runs on the host, the host gateway when
    // it runs in a container.
    return { projectId: project.id, host: this.config.data.connectHost, port: row.hostPort };
  }

  /**
   * Tell PostgREST to re-read the schema.
   *
   * PostgREST caches the database's shape at startup, so a table created after
   * it came up is simply invisible — the API answers "could not find the table
   * in the schema cache" for something that plainly exists. Since this product
   * ships a SQL editor next to the API, that is not an edge case; it is what
   * happens the first time someone runs a migration.
   *
   * Best-effort by design: a failed reload should never fail the migration that
   * triggered it.
   */
  async reloadSchemaCache(projectId: string): Promise<void> {
    const row = this.get(projectId);
    if (!row?.enabled) return;

    try {
      await this.pools.query(projectId, `NOTIFY pgrst, 'reload schema'`);
    } catch (err) {
      this.logger.debug({ err, projectId }, "could not ask PostgREST to reload its schema cache");
    }
  }

  secretFor(projectId: string): string | null {
    const row = this.get(projectId);
    return row ? decryptSecret(row.jwtSecretEnc, this.config.masterKey) : null;
  }
}
