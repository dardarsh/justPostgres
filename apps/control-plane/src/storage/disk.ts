import { statfs } from "node:fs/promises";
import type { Config } from "../config.js";
import type { DockerDriver } from "../docker/driver.js";
import type { Logger } from "../logger.js";

/**
 * How full the disks are, and what that means for what the host will accept.
 *
 * A full disk is the single worst thing that can happen to this product, and it
 * is worse here than in most systems. Postgres does not degrade when it cannot
 * write — it PANICs, and the container restarts into the same wall. WAL that
 * cannot be archived accumulates, so the disk fills *faster* once archiving
 * starts failing. And because projects share a host, one project's runaway
 * table takes down every other project on the box.
 *
 * The control plane cannot prevent a database from growing. What it can do is
 * refuse to start new work when the remaining headroom is what stands between
 * the host and that failure, and say so in plain terms while there is still
 * time to act. That is the whole policy: measure, refuse early, explain.
 */

/** One filesystem, at one moment. */
export interface DiskUsage {
  /** What this filesystem holds, for the operator reading it. */
  label: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
  /** False once free space is under the configured reserve. */
  hasHeadroom: boolean;
}

export interface DiskReport {
  /** Filesystems, worst first. */
  filesystems: DiskUsage[];
  /** The one closest to full; the policy is decided by this one. */
  tightest: DiskUsage | null;
  sampledAt: number;
  /** Present when the sample itself failed. */
  error: string | null;
}

/** Raised when an operation is refused because the host is out of room. */
export class DiskSpaceError extends Error {
  readonly code = "insufficient_disk_space";
  constructor(message: string) {
    super(message);
    this.name = "DiskSpaceError";
  }
}

const GIB = 1024 ** 3;

export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * Samples free space and answers "may this allocate?".
 *
 * Two filesystems are watched, and they are genuinely different questions:
 *
 *  - **Project storage** — where Docker keeps volumes, or the copy-on-write
 *    root. Filling it kills the databases.
 *  - **The control plane's own data directory** — SQLite, and on a default
 *    install the backup repository too. Filling it kills the thing that would
 *    have told you the disk was full, which is how a small problem becomes an
 *    unexplained one.
 *
 * Project storage is measured from inside a container with a probe volume
 * mounted, because that reports the filesystem Docker actually puts volumes on
 * without the control plane needing to know or bind any host path. The control
 * plane's own directory is measured with `statfs`, which costs nothing.
 */
export class DiskMonitor {
  private report: DiskReport = {
    filesystems: [],
    tightest: null,
    sampledAt: 0,
    error: "not sampled yet",
  };
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<DiskReport> | null = null;

  constructor(
    private readonly config: Config,
    private readonly docker: DockerDriver,
    private readonly logger: Logger,
    private readonly probeImage: string,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), this.config.disk.sampleIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The last sample. Never blocks; the guard path must stay fast. */
  latest(): DiskReport {
    return this.report;
  }

  async sample(): Promise<DiskReport> {
    // Overlapping samples would start two probe containers for one answer.
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doSample().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doSample(): Promise<DiskReport> {
    const filesystems: DiskUsage[] = [];
    const errors: string[] = [];

    const own = await this.measureLocal(this.config.dataDir, "control plane and backups");
    if (own instanceof Error) errors.push(own.message);
    else filesystems.push(own);

    const projects = await this.measureProjectStorage();
    if (projects instanceof Error) errors.push(projects.message);
    else if (!filesystems.some((f) => sameFilesystem(f, projects))) filesystems.push(projects);

    filesystems.sort((a, b) => a.freeBytes - b.freeBytes);
    const previous = this.report.tightest;

    this.report = {
      filesystems,
      tightest: filesystems[0] ?? null,
      sampledAt: Date.now(),
      error: filesystems.length === 0 && errors.length > 0 ? errors.join("; ") : null,
    };

    // Logged on the transition, not every sample: an operator should be told
    // once, loudly, rather than have the warning become background noise they
    // learn to scroll past.
    const now = this.report.tightest;
    if (now && previous && previous.hasHeadroom && !now.hasHeadroom) {
      this.logger.error(
        { path: now.path, freeBytes: now.freeBytes },
        `DISK HEADROOM EXHAUSTED on ${now.path} (${formatBytes(now.freeBytes)} free of ` +
          `${formatBytes(now.totalBytes)}). New projects, branches and restores are refused ` +
          `until there is room. Existing databases keep running — until they cannot.`,
      );
    } else if (now && previous && !previous.hasHeadroom && now.hasHeadroom) {
      this.logger.info({ path: now.path }, "disk headroom recovered");
    }

    return this.report;
  }

  private async measureLocal(path: string, label: string): Promise<DiskUsage | Error> {
    try {
      const st = await statfs(path);
      // bavail, not bfree: the reserved-for-root blocks are not ours to spend.
      const total = Number(st.blocks) * Number(st.bsize);
      const free = Number(st.bavail) * Number(st.bsize);
      return this.toUsage(label, path, total, free);
    } catch (err) {
      return new Error(
        `could not measure ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Measure the filesystem Docker puts volumes on, from inside a container.
   *
   * A named probe volume is mounted and `df` reports on it. This deliberately
   * avoids asking the operator to tell us where Docker's storage lives, and it
   * stays correct when Docker is configured with a data root somewhere unusual
   * — a case that would otherwise silently measure the wrong disk and report
   * healthy while the real one filled.
   */
  private async measureProjectStorage(): Promise<DiskUsage | Error> {
    const label = this.config.cow.driver === "none" ? "project volumes" : `project data (${this.config.cow.driver})`;
    const probeVolume = "jp-disk-probe";

    try {
      await this.docker.createVolume(probeVolume, {
        "io.justpostgres.managed": "true",
        "io.justpostgres.role": "disk-probe",
      });

      const outcome = await this.docker.runToCompletion(
        {
          name: `jp-df-${Date.now().toString(36)}`,
          image: this.probeImage,
          entrypoint: ["sh"],
          // POSIX df in 1-KiB blocks, then the fields we need, so the output is
          // stable across busybox and coreutils.
          command: ["-c", "df -P -k /probe | tail -1 | awk '{print $2, $4}'"],
          env: {},
          labels: { "io.justpostgres.managed": "true", "io.justpostgres.role": "disk-probe" },
          volumes: { [probeVolume]: "/probe" },
          memoryBytes: 64 * 1024 * 1024,
          nanoCpus: 5e8,
          restartPolicy: "no",
        },
        { timeoutMs: 60_000 },
      );

      if (outcome.exitCode !== 0) {
        return new Error(`disk probe failed: ${outcome.logs.trim().slice(-200)}`);
      }

      const [totalKb, freeKb] = outcome.logs
        .trim()
        .split("\n")
        .pop()!
        .trim()
        .split(/\s+/)
        .map((n) => Number(n));

      if (!Number.isFinite(totalKb) || !Number.isFinite(freeKb) || totalKb === 0) {
        return new Error(`disk probe returned nothing usable: ${outcome.logs.trim().slice(-200)}`);
      }

      return this.toUsage(
        label,
        this.config.cow.root ?? "docker volumes",
        totalKb! * 1024,
        freeKb! * 1024,
      );
    } catch (err) {
      return new Error(
        `could not measure project storage: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private toUsage(label: string, path: string, totalBytes: number, freeBytes: number): DiskUsage {
    return {
      label,
      path,
      totalBytes,
      freeBytes,
      usedPercent: totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0,
      hasHeadroom: freeBytes >= this.requiredFree(totalBytes),
    };
  }

  /** The larger of the two reserves. See the config comment for why both exist. */
  requiredFree(totalBytes: number): number {
    return Math.max(
      Math.round((totalBytes * this.config.disk.minFreePercent) / 100),
      this.config.disk.minFreeBytes,
    );
  }

  /**
   * Refuse work that allocates, while there is still room to fix it.
   *
   * Called by everything that creates a database directory: new projects,
   * branches and restores. Deletes are never blocked — the way out of a full
   * disk must always be open.
   *
   * A stale or failed sample does not block. Refusing to provision because a
   * `df` did not run would be the monitor causing the outage it exists to
   * prevent.
   */
  assertCanAllocate(what: string): void {
    const tightest = this.report.tightest;
    if (!tightest || tightest.hasHeadroom) return;

    throw new DiskSpaceError(
      `Not enough disk space to ${what}. ${tightest.path} has ${formatBytes(tightest.freeBytes)} ` +
        `free of ${formatBytes(tightest.totalBytes)}, and justpostgres keeps ` +
        `${formatBytes(this.requiredFree(tightest.totalBytes))} in reserve so that the databases ` +
        `already running do not hit a full disk. Delete a project or a branch, shorten backup ` +
        `retention, or grow the disk.`,
    );
  }

  /**
   * Whether a backup may run.
   *
   * Separated from `assertCanAllocate` because the trade-off genuinely differs.
   * A backup to a local repository writes to the disk that is already nearly
   * full, so running it can be what finally kills the host — but refusing it
   * means the recovery point stops advancing exactly when the risk of needing
   * one is highest. A remote repository has no such conflict and is always
   * allowed.
   *
   * The call is made in favour of the host: a failed backup is recoverable, a
   * full disk during a backup can corrupt the cluster it was protecting.
   */
  backupBlockedReason(): string | null {
    if (this.config.backups.repoType !== "posix") return null;
    const tightest = this.report.tightest;
    if (!tightest || tightest.hasHeadroom) return null;
    return (
      `${tightest.path} is below the reserved headroom (${formatBytes(tightest.freeBytes)} free), ` +
      `and this repository is on that same disk. Running the backup could fill it and take the ` +
      `database down with it. Free space, or move the repository to S3.`
    );
  }
}

/** Same size and same free space, to within a sample: almost certainly one filesystem. */
function sameFilesystem(a: DiskUsage, b: DiskUsage): boolean {
  return a.totalBytes === b.totalBytes && Math.abs(a.freeBytes - b.freeBytes) < 16 * 1024 ** 2;
}
