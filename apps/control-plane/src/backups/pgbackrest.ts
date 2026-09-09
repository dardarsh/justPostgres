import type { BackupSetInfo, RecoveryWindow, StanzaInfo } from "@justpostgres/shared";
import type { Config } from "../config.js";
import type { DockerDriver } from "../docker/driver.js";
import { PGDATA } from "../projects/naming.js";

/**
 * pgBackRest, configured entirely through the environment.
 *
 * pgBackRest reads every option from `PGBACKREST_<OPTION>` variables as well as
 * from a config file, and using only the former means no file has to be written
 * into a container, mounted from the host, or kept in sync after a restart. The
 * container's environment *is* the configuration.
 *
 * This matters more than it sounds: `archive_command` runs as a subprocess of
 * the Postgres process, so it inherits the container environment and needs no
 * separate configuration path of its own.
 */

/** Where each project's own repository is mounted. */
export const REPO_MOUNT = "/var/lib/pgbackrest";
/** Where a source project's repository is mounted while a restore recovers. */
export const SOURCE_REPO_MOUNT = "/var/lib/pgbackrest-source";
/** pgBackRest needs somewhere writable for locks and spool; tmpfs is fine. */
const LOCK_PATH = "/tmp/pgbackrest";

export interface S3RepoConfig {
  bucket: string;
  endpoint?: string;
  /** Non-default port, for a self-hosted endpoint like MinIO on :9000. */
  port?: number;
  region: string;
  key: string;
  secret: string;
  uriStyle: "host" | "path";
  verifyTls: boolean;
}

export interface RepoSpec {
  type: "posix" | "s3";
  /** Path inside the repo. For posix this is the mount point; for s3 a prefix. */
  path: string;
  s3?: S3RepoConfig;
}

/**
 * Environment for a project's own repository (repo1) and, optionally, a source
 * project's repository to restore from (repo2).
 */
export function backupEnv(opts: {
  stanza: string;
  repo: RepoSpec;
  retentionFull: number;
  sourceRepo?: { stanza: string; spec: RepoSpec };
}): Record<string, string> {
  const env: Record<string, string> = {
    PGBACKREST_STANZA: opts.stanza,
    PGBACKREST_PG1_PATH: PGDATA,
    PGBACKREST_LOCK_PATH: LOCK_PATH,
    // No log directory exists in the image and creating one per project buys
    // nothing: the control plane captures stdout from every invocation.
    PGBACKREST_LOG_LEVEL_FILE: "off",
    PGBACKREST_LOG_LEVEL_CONSOLE: "info",
    PGBACKREST_REPO1_RETENTION_FULL: String(opts.retentionFull),
    // Without this, restoring into a directory that already has content fails
    // rather than reconciling it — and a restore always lands in a fresh
    // volume here, so delta is a cheap safety net rather than a risk.
    PGBACKREST_DELTA: "y",
    ...repoEnv(1, opts.repo),
  };

  if (opts.sourceRepo) {
    Object.assign(env, repoEnv(2, opts.sourceRepo.spec));
  }

  return env;
}

function repoEnv(index: 1 | 2, spec: RepoSpec): Record<string, string> {
  const prefix = `PGBACKREST_REPO${index}`;
  if (spec.type === "posix") {
    return { [`${prefix}_TYPE`]: "posix", [`${prefix}_PATH`]: spec.path };
  }

  const s3 = spec.s3;
  if (!s3) throw new Error("An s3 repository was requested without S3 settings.");

  return {
    [`${prefix}_TYPE`]: "s3",
    [`${prefix}_PATH`]: spec.path,
    [`${prefix}_S3_BUCKET`]: s3.bucket,
    [`${prefix}_S3_REGION`]: s3.region,
    [`${prefix}_S3_KEY`]: s3.key,
    [`${prefix}_S3_KEY_SECRET`]: s3.secret,
    [`${prefix}_S3_URI_STYLE`]: s3.uriStyle,
    ...(s3.endpoint ? { [`${prefix}_S3_ENDPOINT`]: s3.endpoint } : {}),
    ...(s3.port ? { [`${prefix}_STORAGE_PORT`]: String(s3.port) } : {}),
    ...(s3.verifyTls ? {} : { [`${prefix}_STORAGE_VERIFY_TLS`]: "n" }),
  };
}

/**
 * The `restore_command` a recovering cluster uses to fetch WAL from another
 * project's repository.
 *
 * Every option is on the command line rather than in the environment, and that
 * is the whole point. `archive-push` writes to **every configured repository**,
 * so putting the source repository in the container's environment as repo2
 * makes the restored cluster try to archive its own WAL into the source
 * project's repo — under a stanza that does not exist there. Archiving then
 * fails permanently, and the first backup of the restored project times out
 * waiting for a segment that can never arrive.
 *
 * Keeping the source repository visible only to this one command means
 * `archive_command` sees exactly one repository: the project's own.
 */
export function sourceRestoreCommand(opts: { stanza: string; repoPath: string }): string {
  return [
    "pgbackrest",
    `--stanza=${opts.stanza}`,
    `--repo1-path=${opts.repoPath}`,
    "--repo1-type=posix",
    `--pg1-path=${PGDATA}`,
    `--lock-path=${LOCK_PATH}`,
    "--log-level-console=warn",
    "--log-level-file=off",
    "archive-get",
    "%f",
    '"%p"',
  ].join(" ");
}

/** Postgres settings that turn on continuous archiving into repo1. */
export function archivingPostgresArgs(stanza: string): string[] {
  return [
    "-c",
    "archive_mode=on",
    "-c",
    // %p is Postgres's placeholder for the WAL path; it must survive to
    // pgBackRest untouched.
    `archive_command=pgbackrest --stanza=${stanza} archive-push %p`,
    "-c",
    "wal_level=replica",
    // A slow or briefly failing archive_command should not stall commits.
    // Postgres retries archiving on its own; what it will not do is let pg_wal
    // grow without bound, which is why archiving failure is an alert.
    "-c",
    "archive_timeout=60",
  ];
}

/**
 * Pull the actual failure out of pgBackRest's output.
 *
 * Every invocation logs its full command line and progress before it fails, so
 * the raw output starts with "backup command begin ..." and buries the reason
 * hundreds of characters later. Surfacing that verbatim as a project's
 * `lastError` puts the least useful part of the message where a human looks
 * first — and this is an alert-level condition, so it has to read clearly.
 */
export function summariseFailure(output: string): string {
  const lines = output.split("\n");
  const errorIndex = lines.findIndex((line) => /\bERROR:/.test(line));

  if (errorIndex === -1) {
    // No ERROR line: fall back to the tail, which is where a crash lands.
    return lines.filter((l) => l.trim()).slice(-4).join("\n").slice(0, 1000);
  }

  // The ERROR line plus its HINT/DETAIL continuations, which is where
  // pgBackRest puts the advice worth reading.
  const relevant = [lines[errorIndex]!];
  for (let i = errorIndex + 1; i < lines.length && relevant.length < 6; i++) {
    const line = lines[i]!;
    if (/^\s{10,}/.test(line) || /^\s*(HINT|DETAIL):/.test(line)) relevant.push(line);
    else break;
  }

  return relevant
    .join("\n")
    // Strip the timestamp and process prefix; it is noise in a UI.
    .replace(/^\d{4}-\d{2}-\d{2} [\d:.]+ P\d+\s+/gm, "")
    .replace(/\s+$/gm, "")
    .slice(0, 1000);
}

export interface ExecOutcome {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run pgBackRest inside a project's container.
 *
 * Always as the `postgres` user: pgBackRest refuses to run as root, and rightly
 * so — files it created as root would be unreadable by the server that has to
 * use them later.
 */
export async function runPgBackRest(
  docker: DockerDriver,
  containerId: string,
  args: string[],
): Promise<ExecOutcome> {
  const result = await docker.exec(containerId, ["pgbackrest", ...args], { user: "postgres" });
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// --- `pgbackrest info --output=json` -----------------------------------------

/**
 * These describe the API contract, so they live in the shared package and are
 * re-exported here rather than declared twice. They were declared twice, and
 * two structurally-compatible copies of a type is a silent drift waiting to
 * happen: a field added to one and not the other compiles cleanly and is simply
 * absent at runtime.
 */
export type { BackupSetInfo, RecoveryWindow, StanzaInfo } from "@justpostgres/shared";

interface RawInfo {
  name: string;
  status: { code: number; message: string };
  /** Version history, oldest first. Gains an entry on every stanza-upgrade. */
  db?: Array<{ id: number; version: string; "system-id"?: number }>;
  backup?: Array<{
    label: string;
    type: string;
    timestamp: { start: number; stop: number };
    info?: { size?: number; repository?: { delta?: number; size?: number } };
    archive?: { start?: string | null; stop?: string | null };
    database?: { id?: number };
  }>;
  archive?: Array<{ min?: string | null; max?: string | null }>;
}

export function parseInfo(stdout: string): StanzaInfo[] {
  const parsed = JSON.parse(stdout) as RawInfo[];
  return parsed.map((stanza) => ({
    name: stanza.name,
    status: stanza.status,
    history: (stanza.db ?? []).map((d) => ({ id: d.id, version: d.version })),
    // The highest id is the version the cluster is on now. Anything below it
    // was left behind by a major-version upgrade.
    currentDbId: (stanza.db ?? []).reduce<number | null>(
      (max, d) => (max === null || d.id > max ? d.id : max),
      null,
    ),
    backups: (stanza.backup ?? []).map((backup) => ({
      label: backup.label,
      type: (backup.type as BackupSetInfo["type"]) ?? "full",
      dbId: backup.database?.id ?? 1,
      // pgBackRest reports seconds; everything else in this system is millis.
      startedAt: backup.timestamp.start * 1000,
      finishedAt: backup.timestamp.stop * 1000,
      repoSizeBytes: backup.info?.repository?.delta ?? backup.info?.repository?.size ?? 0,
      databaseSizeBytes: backup.info?.size ?? 0,
      walStart: backup.archive?.start ?? null,
      walStop: backup.archive?.stop ?? null,
    })),
    archive: (stanza.archive ?? []).map((a) => ({ min: a.min ?? null, max: a.max ?? null })),
  }));
}

/**
 * Compute what is actually restorable.
 *
 * The earliest point is the end of the oldest backup, not its start: a backup
 * is only consistent once it finishes. The latest is now, provided WAL is still
 * arriving — which is exactly why archiving health is tracked separately. A
 * stanza with backups but broken archiving can only be restored to the end of
 * its most recent backup, and saying otherwise would be a lie with consequences.
 */
export function recoveryWindow(stanza: StanzaInfo | undefined, archivingHealthy: boolean): RecoveryWindow {
  if (!stanza || stanza.backups.length === 0) {
    return { earliest: null, latest: null, backupCount: 0, strandedByUpgrade: 0, empty: true };
  }

  // Only backups taken on the version the cluster is running now. pgBackRest
  // keeps the older ones after a stanza-upgrade, and they restore a cluster the
  // current binaries will refuse to start — so counting them here would put a
  // recovery point in the UI that does not exist. This is the second half of
  // the version-locking trap: the first half is remembering to upgrade the
  // stanza, and this is remembering that doing so does not make old backups
  // usable.
  const usable =
    stanza.currentDbId === null
      ? stanza.backups
      : stanza.backups.filter((b) => b.dbId === stanza.currentDbId);
  const strandedByUpgrade = stanza.backups.length - usable.length;

  if (usable.length === 0) {
    return { earliest: null, latest: null, backupCount: 0, strandedByUpgrade, empty: true };
  }

  const finished = usable.map((b) => b.finishedAt).sort((a, b) => a - b);
  const newestBackup = finished[finished.length - 1]!;

  return {
    earliest: finished[0]!,
    latest: archivingHealthy ? Date.now() : newestBackup,
    backupCount: usable.length,
    strandedByUpgrade,
    empty: false,
  };
}

/** Resolve the repository a project should use, from global config. */
export function repoSpecFor(config: Config, ref: string): RepoSpec {
  if (config.backups.repoType === "posix") {
    return { type: "posix", path: REPO_MOUNT };
  }

  const s3 = config.backups.s3;
  if (!s3.bucket || !s3.key || !s3.secret) {
    throw new Error(
      "JP_BACKUP_REPO_TYPE is s3 but JP_BACKUP_S3_BUCKET, JP_BACKUP_S3_KEY and " +
        "JP_BACKUP_S3_SECRET are not all set.",
    );
  }

  return {
    type: "s3",
    // A prefix per project, so one project's expiry cannot touch another's.
    path: `/${ref}`,
    s3: {
      bucket: s3.bucket,
      ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
      region: s3.region,
      key: s3.key,
      secret: s3.secret,
      uriStyle: s3.uriStyle,
      verifyTls: s3.verifyTls,
    },
  };
}
