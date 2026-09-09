/**
 * The container runtime, behind an interface.
 *
 * Everything the control plane does to a project passes through here. Keeping
 * it narrow and explicit is what makes the hosted service possible later
 * (ARCHITECTURE §11): a remote driver targeting another host, or a different
 * runtime entirely, implements this and nothing else changes.
 *
 * M0 defines the surface and implements it; only `ping` is exercised until M1.
 */

export interface DockerVersion {
  serverVersion: string;
  apiVersion: string;
}

export interface ContainerSpec {
  name: string;
  image: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  /** Named volume -> mount path inside the container. */
  volumes: Record<string, string>;
  /** Container port -> host port. Empty when traffic arrives via the router. */
  ports?: Record<number, number>;
  /**
   * Interface the published ports bind to. Defaults to all interfaces.
   *
   * `127.0.0.1` makes a port reachable by processes on the host but not from
   * the network — which is what a service that should only be reached through
   * the control plane's proxy wants.
   */
  portBindAddress?: string;
  network?: string;
  /**
   * Overrides the image's default command. Used to pass `-c` settings to
   * Postgres, which take precedence over postgresql.conf and so avoid having
   * to write a config file into the container at all.
   */
  command?: string[];
  /** Overrides the image entrypoint, for one-shot maintenance containers. */
  entrypoint?: string[];
  /** Runs the container as this user. Avoids nested `su -c` shell quoting. */
  user?: string;
  /** Read-only bind of another project's volume, e.g. a source repo on restore. */
  readOnlyVolumes?: Record<string, string>;
  /** Host path -> container path. Only for maintenance helpers, never a project. */
  hostBinds?: Record<string, string>;
  /**
   * Runs the container privileged. Reserved for the copy-on-write helper, which
   * needs filesystem-level access to snapshot a subvolume. Project containers
   * are never privileged (ARCHITECTURE §4).
   */
  privileged?: boolean;
  /** Hard limits. Never optional in practice: one project must not starve the host. */
  memoryBytes: number;
  nanoCpus: number;
  /** Maximum process count. Defaults to 512; the limit memory and CPU do not give you. */
  pidsLimit?: number;
  /**
   * Size of /dev/shm. Docker defaults to 64MB, which Postgres parallel workers
   * can exhaust — the symptom is "could not resize shared memory segment",
   * which reads like a Postgres bug and is not one.
   */
  shmBytes?: number;
  restartPolicy?: "no" | "unless-stopped" | "always";
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  running: boolean;
  health?: "starting" | "healthy" | "unhealthy" | "none";
  startedAt: string | null;
  labels: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface VolumeInfo {
  name: string;
  mountpoint: string;
  labels: Record<string, string>;
}

export interface DockerDriver {
  ping(): Promise<DockerVersion>;

  /** Is this image already on the host? */
  imageExists(image: string): Promise<boolean>;
  pullImage(image: string, onProgress?: (line: string) => void): Promise<void>;

  createContainer(spec: ContainerSpec): Promise<string>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, timeoutSeconds?: number): Promise<void>;
  removeContainer(id: string, opts?: { force?: boolean }): Promise<void>;
  inspectContainer(id: string): Promise<ContainerInfo | null>;
  listContainers(labelFilter?: Record<string, string>): Promise<ContainerInfo[]>;

  exec(id: string, command: string[], opts?: { user?: string }): Promise<ExecResult>;

  /** Recent log output, for explaining why a container will not stay up. */
  containerLogs(id: string, tail?: number): Promise<string>;

  /**
   * Create, start and wait for a container, then remove it.
   *
   * For work that needs a container but not a service: restoring a backup into
   * a fresh volume, fixing ownership on a new mount. Returns the exit code and
   * output rather than leaving anything behind.
   */
  runToCompletion(
    spec: ContainerSpec,
    opts?: { timeoutMs?: number },
  ): Promise<{ exitCode: number; logs: string }>;

  /**
   * `driverOpts` lets a "volume" actually be a bind to a host path, which is
   * how a copy-on-write subvolume is presented to the rest of the system as an
   * ordinary named volume.
   */
  createVolume(
    name: string,
    labels?: Record<string, string>,
    driverOpts?: Record<string, string>,
  ): Promise<VolumeInfo>;
  removeVolume(name: string, opts?: { force?: boolean }): Promise<void>;
  listVolumes(labelFilter?: Record<string, string>): Promise<VolumeInfo[]>;

  createNetwork(name: string, labels?: Record<string, string>): Promise<string>;
  removeNetwork(name: string): Promise<void>;
}

/** Every object justpostgres creates carries these, so the reconciler can find its own work. */
export const JP_LABELS = {
  managed: "io.justpostgres.managed",
  projectId: "io.justpostgres.project-id",
  projectRef: "io.justpostgres.project-ref",
  role: "io.justpostgres.role",
} as const;
