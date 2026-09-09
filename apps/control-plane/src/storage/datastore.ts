import type { Config } from "../config.js";
import type { ContainerSpec, DockerDriver } from "../docker/driver.js";
import type { Logger } from "../logger.js";

/**
 * The result of proving the store can actually do what it claims.
 *
 * `ok: false` is a configuration error, not an outage — but it is the kind that
 * silently destroys data if it is not caught, so it is reported rather than
 * thrown past the operator.
 */
export interface DataStoreStatus {
  ok: boolean;
  kind: DataStore["kind"];
  root: string | null;
  /** One line, written for a human reading a log at 3am. */
  detail: string;
  checkedAt: number;
}

/**
 * Where a project's data directory physically lives, and whether it can be
 * cloned.
 *
 * Two implementations, answering two different questions:
 *
 *  - **Plain Docker volumes** (the default). Portable, no assumptions about the
 *    host filesystem, and no way to clone. Branching falls back to a
 *    point-in-time restore, which is correct everywhere and costs O(database
 *    size).
 *  - **Copy-on-write** (btrfs or ZFS). The operator mounts a filesystem and
 *    points `JP_COW_ROOT` at it; each project's data directory becomes a
 *    subvolume inside it, and a branch is a snapshot — near-instant, and
 *    sharing storage with its parent until one of them writes.
 *
 * The seam is deliberately narrow. Everything else in the system — container
 * specs, mounts, backups — is identical either way, because the CoW store still
 * presents its subvolumes as ordinary Docker volumes.
 */
export interface DataStore {
  readonly kind: "volume" | "btrfs" | "zfs";
  /** Whether `snapshot` is available. Decides branching strategy. */
  readonly supportsSnapshot: boolean;

  /**
   * Prove the store works, before anything depends on it.
   *
   * For copy-on-write stores this is not a formality. Docker creates a missing
   * bind source as an empty directory, so a typo in `JP_COW_ROOT` — or a btrfs
   * mount that did not come back after a host reboot — looks exactly like a
   * working configuration right up until a project's data is written to the
   * root disk instead of the pool. Worse, remounting later shadows that data,
   * which is data loss that arrives days after the mistake.
   */
  verify(): Promise<DataStoreStatus>;

  /** The last verification result, without running one. */
  lastStatus(): DataStoreStatus | null;

  /** Create the data directory for a project. Returns the Docker volume name to mount. */
  create(ref: string, labels: Record<string, string>): Promise<string>;

  /** Remove a project's data directory and everything in it. */
  remove(ref: string): Promise<void>;

  /**
   * Clone one project's data directory into another, copy-on-write.
   *
   * Only meaningful when `supportsSnapshot` is true. The source must be
   * quiesced enough to be crash-consistent — Postgres is crash-safe, so an
   * atomic filesystem snapshot of a running cluster recovers cleanly on start.
   */
  snapshot(sourceRef: string, targetRef: string, labels: Record<string, string>): Promise<string>;
}

/** Docker named volumes. No cloning; branching uses point-in-time restore. */
export class VolumeDataStore implements DataStore {
  readonly kind = "volume" as const;
  readonly supportsSnapshot = false;
  private status: DataStoreStatus | null = null;

  constructor(private readonly docker: DockerDriver) {}

  /** Nothing to prove: Docker manages the volume and there is no host path to get wrong. */
  async verify(): Promise<DataStoreStatus> {
    this.status = {
      ok: true,
      kind: this.kind,
      root: null,
      detail: "Docker named volumes. Branching falls back to a point-in-time restore.",
      checkedAt: Date.now(),
    };
    return this.status;
  }

  lastStatus(): DataStoreStatus | null {
    return this.status;
  }

  async create(ref: string, labels: Record<string, string>): Promise<string> {
    const name = dataVolumeName(ref);
    await this.docker.createVolume(name, labels);
    return name;
  }

  async remove(ref: string): Promise<void> {
    await this.docker.removeVolume(dataVolumeName(ref), { force: true });
  }

  async snapshot(): Promise<string> {
    throw new Error("This data store cannot snapshot. Branching falls back to a restore.");
  }
}

/**
 * Copy-on-write data directories on btrfs or ZFS.
 *
 * The filesystem commands run in a short-lived privileged container with the
 * CoW root bind-mounted. That is not a new privilege: the control plane already
 * holds the Docker socket, which is root-equivalent on the host, so it could
 * start such a container regardless. Doing it explicitly and narrowly is better
 * than requiring the control plane itself to run privileged.
 */
export class CowDataStore implements DataStore {
  readonly supportsSnapshot = true;
  private readonly root: string;
  private readonly helperImage: string;
  private status: DataStoreStatus | null = null;

  constructor(
    readonly kind: "btrfs" | "zfs",
    config: Config,
    private readonly docker: DockerDriver,
    private readonly logger: Logger,
    helperImage: string,
  ) {
    if (!config.cow.root) throw new Error("JP_COW_ROOT is required for copy-on-write branching.");
    this.root = config.cow.root.replace(/\/+$/, "");
    this.helperImage = helperImage;
  }

  /**
   * Prove the configured filesystem is really there and really works.
   *
   * The weak check would be "does the directory exist" — which is worthless,
   * because Docker creates a missing bind source for you. The check that
   * matters is what filesystem is mounted there, and then whether the exact
   * operations branching depends on succeed. So this creates a subvolume,
   * snapshots it, and deletes both. A few seconds at boot in exchange for
   * finding out now rather than at the first branch, or — much worse — after a
   * host reboot silently dropped the mount and projects started writing to the
   * root disk.
   */
  async verify(): Promise<DataStoreStatus> {
    const nonce = Math.random().toString(36).slice(2, 10);
    const outcome = await this.docker
      .runToCompletion(this.helperSpec(["sh", "-c", this.verifyScript(nonce)]), {
        timeoutMs: 120_000,
      })
      .catch((err) => ({
        exitCode: -1,
        logs: err instanceof Error ? err.message : String(err),
      }));

    const logs = outcome.logs.trim();
    this.status = {
      ok: outcome.exitCode === 0,
      kind: this.kind,
      root: this.root,
      detail: outcome.exitCode === 0 ? this.okDetail() : this.explainFailure(outcome.exitCode, logs),
      checkedAt: Date.now(),
    };
    return this.status;
  }

  lastStatus(): DataStoreStatus | null {
    return this.status;
  }

  private okDetail(): string {
    return `${this.kind} at ${this.root}: subvolume create, snapshot and delete all succeeded.`;
  }

  /**
   * Turn an exit code into the sentence an operator needs, including the fix.
   *
   * Each of these is a real way to get this wrong, and the raw helper output
   * for any of them ("ERROR: not a btrfs filesystem") does not say what to do.
   */
  private explainFailure(exitCode: number, logs: string): string {
    const tail = logs.split("\n").filter(Boolean).slice(-3).join(" / ");
    switch (exitCode) {
      case 2:
        return `JP_COW_ROOT=${this.root} does not exist on the host. Create and mount it, or set JP_COW_DRIVER=none.`;
      case 3:
        return (
          `JP_COW_ROOT=${this.root} is not a ${this.kind} filesystem (${tail || "unknown"}). ` +
          `Nothing is mounted there, or the wrong thing is. Docker will happily create that path as an ` +
          `ordinary directory, so this looks like a working setup until project data lands on the root disk.`
        );
      case 4:
        return (
          `The helper image ${this.helperImage} has no \`zfs\` command. ZFS needs a helper image with ` +
          `zfsutils-linux and /dev/zfs available: set JP_COW_HELPER_IMAGE. See docs/ARCHITECTURE.md §6.`
        );
      case 5:
        return `The ZFS dataset ${this.datasetRoot()} does not exist. Create it with: zfs create ${this.datasetRoot()}`;
      case 6:
        return `${this.root} is mounted but not writable by the helper. Check permissions and whether it is read-only.`;
      case 7:
        return `${this.root} is ${this.kind}, but a probe snapshot failed: ${tail}`;
      case -1:
        return `Could not run the copy-on-write helper at all: ${tail}. Docker may be unreachable.`;
      default:
        return `Copy-on-write verification failed (exit ${exitCode}): ${tail}`;
    }
  }

  private verifyScript(nonce: string): string {
    const probe = `/cow/.jp-verify-${nonce}`;
    if (this.kind === "btrfs") {
      return [
        `test -d /cow || exit 2`,
        // Docker auto-creates a missing bind source, so existence proves
        // nothing. The filesystem type is the actual question.
        `fs=$(stat -f -c %T /cow 2>/dev/null || echo unknown)`,
        `[ "$fs" = "btrfs" ] || { echo "filesystem at /cow is $fs, not btrfs"; exit 3; }`,
        `test -w /cow || exit 6`,
        `btrfs subvolume create ${probe} >/dev/null 2>&1 || exit 7`,
        `btrfs subvolume snapshot ${probe} ${probe}-snap >/dev/null 2>&1 || {`,
        `  btrfs subvolume delete ${probe} >/dev/null 2>&1; exit 7; }`,
        `btrfs subvolume delete ${probe}-snap >/dev/null 2>&1`,
        `btrfs subvolume delete ${probe} >/dev/null 2>&1`,
        `echo "btrfs verified"`,
      ].join("\n");
    }
    return [
      `command -v zfs >/dev/null 2>&1 || exit 4`,
      `zfs list -H -o name ${this.datasetRoot()} >/dev/null 2>&1 || exit 5`,
      `test -w /cow || exit 6`,
      `echo "zfs dataset present"`,
    ].join("\n");
  }

  /** Refuses to write project data anywhere until the store has been proven. */
  private async ensureVerified(): Promise<void> {
    // Not cached on failure: an operator who mounts the filesystem should not
    // have to restart the control plane to be believed.
    if (this.status?.ok) return;
    const status = await this.verify();
    if (!status.ok) {
      throw new Error(
        `Copy-on-write storage is not usable, so no project data will be written. ${status.detail}`,
      );
    }
  }

  async create(ref: string, labels: Record<string, string>): Promise<string> {
    await this.ensureVerified();
    await this.runHelper(`create ${ref}`, this.createArgs(ref));
    return this.bindVolume(ref, labels);
  }

  async snapshot(
    sourceRef: string,
    targetRef: string,
    labels: Record<string, string>,
  ): Promise<string> {
    await this.ensureVerified();
    const started = Date.now();
    await this.runHelper(`snapshot ${sourceRef} -> ${targetRef}`, this.snapshotArgs(sourceRef, targetRef));
    this.logger.info(
      { sourceRef, targetRef, durationMs: Date.now() - started, driver: this.kind },
      "copy-on-write snapshot taken",
    );
    return this.bindVolume(targetRef, labels);
  }

  async remove(ref: string): Promise<void> {
    // The Docker volume is only a pointer at the subvolume; both have to go,
    // and the volume first so nothing is holding the path.
    await this.docker.removeVolume(dataVolumeName(ref), { force: true }).catch(() => {});
    await this.runHelper(`delete ${ref}`, this.deleteArgs(ref), { tolerateFailure: true });
  }

  /**
   * A Docker volume that is really a bind to the subvolume path.
   *
   * This is what keeps the seam narrow: container specs mount a volume by name
   * and never learn that it is a btrfs subvolume underneath.
   */
  private async bindVolume(ref: string, labels: Record<string, string>): Promise<string> {
    const name = dataVolumeName(ref);
    await this.docker.createVolume(name, labels, {
      type: "none",
      device: this.path(ref),
      o: "bind",
    });
    return name;
  }

  private path(ref: string): string {
    return `${this.root}/${ref}`;
  }

  private createArgs(ref: string): string[] {
    return this.kind === "btrfs"
      ? ["btrfs", "subvolume", "create", `/cow/${ref}`]
      : ["zfs", "create", `${this.datasetRoot()}/${ref}`];
  }

  private snapshotArgs(sourceRef: string, targetRef: string): string[] {
    if (this.kind === "btrfs") {
      return ["btrfs", "subvolume", "snapshot", `/cow/${sourceRef}`, `/cow/${targetRef}`];
    }
    // ZFS needs a named snapshot to clone from, so the two steps are chained.
    const source = `${this.datasetRoot()}/${sourceRef}`;
    const snap = `${source}@branch-${targetRef}`;
    return [
      "sh",
      "-c",
      `zfs snapshot ${snap} && zfs clone ${snap} ${this.datasetRoot()}/${targetRef}`,
    ];
  }

  private deleteArgs(ref: string): string[] {
    return this.kind === "btrfs"
      ? ["btrfs", "subvolume", "delete", `/cow/${ref}`]
      : ["zfs", "destroy", "-R", `${this.datasetRoot()}/${ref}`];
  }

  /** For ZFS the root is a dataset name, not a path; strip the leading slash. */
  private datasetRoot(): string {
    return this.root.replace(/^\//, "");
  }

  /** One short-lived privileged container, described in exactly one place. */
  private helperSpec(command: string[]): ContainerSpec {
    return {
      name: `jp-cow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      image: this.helperImage,
      entrypoint: [command[0]!],
      command: command.slice(1),
      env: {},
      labels: { "io.justpostgres.managed": "true", "io.justpostgres.role": "cow-helper" },
      volumes: {},
      // The CoW root is bound in rather than the whole host filesystem, so
      // the helper can reach exactly the one directory it needs.
      hostBinds: { [this.root]: "/cow" },
      privileged: true,
      memoryBytes: 256 * 1024 * 1024,
      nanoCpus: 1e9,
      restartPolicy: "no",
    };
  }

  private async runHelper(
    description: string,
    command: string[],
    opts: { tolerateFailure?: boolean } = {},
  ): Promise<void> {
    const outcome = await this.docker.runToCompletion(this.helperSpec(command), {
      timeoutMs: 10 * 60_000,
    });

    if (outcome.exitCode !== 0) {
      const message = `Copy-on-write helper failed (${description}): ${outcome.logs.trim().slice(-800)}`;
      if (opts.tolerateFailure) {
        this.logger.warn({ description }, message);
        return;
      }
      throw new Error(message);
    }
  }
}

export function dataVolumeName(ref: string): string {
  return `jp-${ref}-data`;
}

/**
 * Build the data store the configuration asks for.
 *
 * Deliberately fails loudly rather than silently falling back: an operator who
 * configured copy-on-write and quietly got plain volumes would discover it as
 * "why is branching slow" months later.
 */
export function createDataStore(
  config: Config,
  docker: DockerDriver,
  logger: Logger,
  defaultHelperImage: string,
): DataStore {
  if (config.cow.driver === "none") return new VolumeDataStore(docker);

  return new CowDataStore(
    config.cow.driver,
    config,
    docker,
    logger,
    config.cow.helperImage ?? defaultHelperImage,
  );
}
