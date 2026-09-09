import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Control-plane metadata.
 *
 * SQLite, deliberately — see ARCHITECTURE §3. The control plane's job includes
 * explaining why your Postgres is down, so its own state must not live in a
 * Postgres container it manages.
 *
 * All timestamps are epoch milliseconds stored as INTEGER. Doing this
 * consistently avoids the usual mess of comparing text dates in SQLite.
 */

const now = sql`(unixepoch('subsec') * 1000)`;

/**
 * Durable job queue.
 *
 * Backups, restores, branch creation and version upgrades run for minutes and
 * must survive a control-plane restart, so job state lives in the database
 * rather than in memory. Claiming is lease-based: a worker takes a job by
 * stamping its own id and an expiry, and heartbeats to extend it. A worker that
 * dies stops heartbeating, the lease expires, and another worker (or the same
 * one after a restart) picks the job back up.
 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    projectId: text("project_id"),
    /** JSON. Handler-specific input, validated by the handler's own schema. */
    payload: text("payload").notNull().default("{}"),

    state: text("state").notNull().default("queued"),
    /** Higher runs first. */
    priority: integer("priority").notNull().default(0),
    /** Earliest time this job may run; used for scheduling and retry backoff. */
    runAt: integer("run_at").notNull(),

    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),

    /** Instance id of the worker currently holding the job, if any. */
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),

    /**
     * JSON checkpoint written by the handler as it works. This is what makes a
     * job resumable rather than merely retryable: after a crash the handler is
     * handed back its last checkpoint instead of starting over. It matters most
     * for the jobs that will exist from M4 on, where starting over means
     * re-running a multi-gigabyte restore.
     */
    progress: text("progress"),
    lastError: text("last_error"),

    /** Set by a cancel request; the handler observes it between steps. */
    cancelRequested: integer("cancel_requested", { mode: "boolean" })
      .notNull()
      .default(false),

    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    // The claim query's access path: find runnable work cheaply.
    index("jobs_claim_idx").on(t.state, t.runAt, t.priority),
    index("jobs_lease_idx").on(t.state, t.leaseExpiresAt),
    index("jobs_project_idx").on(t.projectId, t.createdAt),
  ],
);

/**
 * Projects. Declared in M0 so the API and UI are written against the real
 * shape; provisioning that actually fills this in arrives in M1.
 *
 * `nodeId` exists from the first migration even though M0 and M1 only ever
 * have one node. Retrofitting a fleet concept into a schema that assumes
 * locality is the expensive version of this mistake (ARCHITECTURE §11).
 */
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    /** Short public identifier, used in hostnames and connection strings. */
    ref: text("ref").notNull().unique(),
    name: text("name").notNull(),
    nodeId: text("node_id").notNull().default("local"),

    pgMajor: integer("pg_major").notNull(),
    /** Resolved at creation and pinned, so a changed default cannot silently move an existing project. */
    image: text("image").notNull(),
    state: text("state").notNull().default("creating"),
    /** Why the project is in `failed`, surfaced directly in the UI. */
    lastError: text("last_error"),

    containerId: text("container_id"),
    containerName: text("container_name"),
    volumeName: text("volume_name"),
    networkName: text("network_name"),
    /** Holds this project's pgBackRest repository. One repo per project. */
    backupVolumeName: text("backup_volume_name"),
    /**
     * While a restored project is still recovering it needs the source
     * project's repository mounted read-only. The dependency is dropped once it
     * has taken a full backup of its own.
     */
    sourceRepoVolumeName: text("source_repo_volume_name"),

    /**
     * Published host port. Temporary: this is routing mode 3 from
     * ARCHITECTURE §5, the fallback that exists so the product works before the
     * router lands in M2 and after it, if the router ever disappoints.
     */
    hostPort: integer("host_port"),

    memoryBytes: integer("memory_bytes").notNull(),
    nanoCpus: integer("nano_cpus").notNull(),

    /**
     * JSON array of libraries for `shared_preload_libraries`.
     *
     * Stored on the project because it is a startup-only Postgres setting: it
     * has to be reapplied every time the container is recreated, and losing it
     * would silently break every extension that depends on it.
     */
    preloadLibraries: text("preload_libraries"),

    /** Set for branches and restores; null for a root project. */
    parentProjectId: text("parent_project_id"),
    branchPoint: integer("branch_point"),
    /** How the copy was made: `pitr` replays WAL, `cow` clones the filesystem. */
    branchMethod: text("branch_method"),
    /**
     * When an unpinned branch is deleted automatically.
     *
     * Branches are made to be thrown away, and the ones that are not thrown
     * away are the ones that quietly consume a host. Null means pinned — an
     * explicit decision to keep it, including for every promoted restore.
     */
    expiresAt: integer("expires_at"),

    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    index("projects_state_idx").on(t.state),
    index("projects_parent_idx").on(t.parentProjectId),
  ],
);

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;

/**
 * The control-plane administrator.
 *
 * Single admin by design for 1.0. Multi-user means invitations, per-project
 * permissions and an organisation model, which is the hosted service arriving
 * early — see ARCHITECTURE §12 open question 1. The table is shaped to hold
 * more than one row so that adding users later is a migration, not a rewrite.
 */
export const admins = sqliteTable("admins", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
  lastLoginAt: integer("last_login_at"),
});

/**
 * Login sessions.
 *
 * `id` is the SHA-256 of the token, never the token itself: someone who reads
 * this table gets no usable cookie.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    adminId: text("admin_id")
      .notNull()
      .references(() => admins.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull().default(now),
    expiresAt: integer("expires_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull().default(now),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (t) => [index("sessions_admin_idx").on(t.adminId), index("sessions_expiry_idx").on(t.expiresAt)],
);

/**
 * Per-project database credentials, encrypted at rest with JP_MASTER_KEY.
 *
 * This table is why the control plane is the crown jewels of a deployment: it
 * holds superuser access to every database on the host.
 */
export const credentials = sqliteTable(
  "credentials",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    database: text("database").notNull(),
    passwordEnc: text("password_enc").notNull(),
    /** The credential handed out in the UI's connection string. */
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("credentials_project_idx").on(t.projectId)],
);

/**
 * Audit log.
 *
 * Not optional (ARCHITECTURE §10). A tool holding superuser credentials for
 * every database on the box has to be able to answer "who deleted that
 * project", and the answer has to survive the project's deletion — hence no
 * foreign key to `projects`.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    projectId: text("project_id"),
    payload: text("payload"),
    ip: text("ip"),
    at: integer("at").notNull().default(now),
  },
  (t) => [index("audit_at_idx").on(t.at), index("audit_project_idx").on(t.projectId)],
);

export type AdminRow = typeof admins.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type CredentialRow = typeof credentials.$inferSelect;

/**
 * Backup configuration, one row per project.
 *
 * **One repository per project, not a shared repository with a stanza each.**
 * pgBackRest's idiomatic layout is the latter, and per-stanza retention would
 * work fine — but the repository has to be reachable from inside the project's
 * own container, because `archive_command` runs as a subprocess of Postgres.
 * The user holds superuser there and can execute arbitrary code
 * (ARCHITECTURE §4), so a shared repository mount is a cross-project read of
 * everyone else's backups. Isolation wins over idiom.
 *
 * The same reasoning is why S3 is offered with a caveat rather than as the
 * default: credentials that reach the container reach the whole bucket unless
 * the operator scopes them per prefix.
 */
export const backupConfigs = sqliteTable("backup_configs", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),

  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** pgBackRest stanza name. The project ref, so two repos never collide. */
  stanza: text("stanza").notNull(),
  repoType: text("repo_type").notNull().default("posix"),
  /** JSON, encrypted: S3 bucket, endpoint, region, key and secret. */
  repoConfigEnc: text("repo_config_enc"),

  /** How often to run a backup at all. */
  intervalHours: integer("interval_hours").notNull().default(24),
  /** A run older than this since the last full becomes a full rather than an incremental. */
  fullEveryDays: integer("full_every_days").notNull().default(7),
  /** pgBackRest repo1-retention-full: how many full backups to keep. */
  retentionFull: integer("retention_full").notNull().default(4),

  lastRunAt: integer("last_run_at"),
  lastSuccessAt: integer("last_success_at"),
  lastError: text("last_error"),

  /**
   * WAL archiving health, checked separately from backups.
   *
   * A project whose archiving has been failing for a week looks completely
   * healthy right up to the moment someone needs a recovery point. This is an
   * alert condition, not a metric (ARCHITECTURE §9).
   */
  archivingHealthy: integer("archiving_healthy", { mode: "boolean" }),
  archivingCheckedAt: integer("archiving_checked_at"),
  archivingError: text("archiving_error"),

  /** Set after a major-version upgrade, until the first full backup on the new stanza lands. */
  awaitingFirstBackup: integer("awaiting_first_backup", { mode: "boolean" })
    .notNull()
    .default(true),

  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

/**
 * History of backup runs this control plane started.
 *
 * Not the source of truth for what is restorable — `pgbackrest info` is, and
 * the UI reads the recovery window from there. This table exists so a failed or
 * still-running attempt is visible, which `pgbackrest info` cannot tell you
 * because a backup that failed leaves nothing behind.
 */
export const backupRuns = sqliteTable(
  "backup_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    jobId: text("job_id"),
    type: text("type").notNull(),
    /** pgBackRest's own label for the resulting backup set, once it has one. */
    label: text("label"),
    status: text("status").notNull().default("running"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    sizeBytes: integer("size_bytes"),
    error: text("error"),
    /** True for a run made by the automatic restore-verification job. */
    verification: integer("verification", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("backup_runs_project_idx").on(t.projectId, t.startedAt)],
);

/**
 * Restore-verification results.
 *
 * Automatic, periodic proof that a backup actually restores and starts. A
 * backup nobody has ever restored is a hypothesis, and this is the only
 * defensible position for a tool that promises recovery (ROADMAP, Risks).
 */
export const restoreChecks = sqliteTable(
  "restore_checks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    status: text("status").notNull().default("running"),
    /** What the restored copy reported, e.g. row counts or the latest LSN. */
    detail: text("detail"),
    error: text("error"),
  },
  (t) => [index("restore_checks_project_idx").on(t.projectId, t.startedAt)],
);

export type BackupConfigRow = typeof backupConfigs.$inferSelect;
export type BackupRunRow = typeof backupRuns.$inferSelect;
export type RestoreCheckRow = typeof restoreChecks.$inferSelect;

/**
 * The optional REST API in front of a project.
 *
 * Off by default. Turning it on is a deliberate act, because it changes a
 * private database into something reachable over HTTP — and the safety of that
 * rests entirely on row-level security, which is why exposing a table and
 * enabling RLS on it are the same action here rather than two.
 *
 * Only the signing secret is stored. The anon and service keys are JWTs derived
 * from it, so keeping them would mean storing two more secrets that add nothing.
 */
export const apiConfigs = sqliteTable("api_configs", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),

  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  /** HS256 signing secret, encrypted with JP_MASTER_KEY. */
  jwtSecretEnc: text("jwt_secret_enc").notNull(),
  /** Password for the `authenticator` role PostgREST logs in as. */
  authenticatorPasswordEnc: text("authenticator_password_enc").notNull(),

  /** Comma-separated schemas PostgREST exposes. */
  schemas: text("schemas").notNull().default("public"),
  /** Hard cap on rows any single request can return. */
  maxRows: integer("max_rows").notNull().default(1000),

  containerId: text("container_id"),
  containerName: text("container_name"),
  /**
   * Host port PostgREST is published on, bound to loopback only.
   *
   * The control plane's proxy is the intended route in, but it has to be able
   * to reach the container — and it may itself be running on the host rather
   * than on the project's Docker network. Binding to 127.0.0.1 keeps the port
   * off the network while remaining reachable by the proxy.
   */
  hostPort: integer("host_port"),
  /** Bumped on rotation, so an old key can be recognised as deliberately retired. */
  keyVersion: integer("key_version").notNull().default(1),

  lastError: text("last_error"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

export type ApiConfigRow = typeof apiConfigs.$inferSelect;

/**
 * Small key/value settings for the instance itself, as opposed to a project.
 *
 * Currently holds exactly one thing: the token that must be presented to claim
 * an unclaimed instance. Kept as a table rather than a file so it lives with
 * everything else the control plane owns and is covered by the same backup.
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull().default(now),
});

export type SettingRow = typeof settings.$inferSelect;

/**
 * One row per major-version upgrade attempt.
 *
 * Kept as history rather than a column on the project, for two reasons. The
 * old data directory is retained after a successful upgrade and something has
 * to remember its name so it can be offered for deletion later — a volume with
 * no owner is a volume nobody dares remove. And an upgrade that failed and
 * rolled back is exactly the thing an operator needs to be able to read back
 * afterwards, which a column overwritten by the next attempt cannot provide.
 */
export const upgrades = sqliteTable(
  "upgrades",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fromMajor: integer("from_major").notNull(),
    toMajor: integer("to_major").notNull(),
    /** running | succeeded | failed | rolled_back */
    state: text("state").notNull().default("running"),
    jobId: text("job_id"),

    /**
     * The data directory the project had before the upgrade, kept intact.
     *
     * This is the rollback, and it is also the only honest answer to "what if
     * the dump lost something". It stays until an operator says otherwise.
     */
    previousVolumeName: text("previous_volume_name"),
    previousImage: text("previous_image"),
    /** Set once the retained old data directory has been deleted. */
    previousDiscardedAt: integer("previous_discarded_at"),

    /**
     * Object counts taken from the old cluster and re-taken on the new one.
     *
     * A dump-and-restore that silently drops a database or a table is the
     * failure this product cannot afford, so the two are compared before the
     * upgrade is called a success.
     */
    manifestBefore: text("manifest_before"),
    manifestAfter: text("manifest_after"),

    error: text("error"),
    startedAt: integer("started_at").notNull().default(now),
    finishedAt: integer("finished_at"),
  },
  (table) => [index("upgrades_project_idx").on(table.projectId, table.startedAt)],
);

export type UpgradeRow = typeof upgrades.$inferSelect;

/**
 * Periodic size and connection readings, per project.
 *
 * The only metric that is stored rather than read on demand, because "is this
 * growing, and how fast" cannot be answered from one reading — and on a single
 * host that is the question that decides whether the month ends with a full
 * disk. Everything else in the metrics view comes straight from the project's
 * own catalogue.
 */
export const metricSamples = sqliteTable(
  "metric_samples",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    at: integer("at").notNull(),
    databaseBytes: integer("database_bytes").notNull(),
    connections: integer("connections").notNull(),
  },
  (table) => [index("metric_samples_project_idx").on(table.projectId, table.at)],
);

export type MetricSampleRow = typeof metricSamples.$inferSelect;
