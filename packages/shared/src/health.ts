export type ComponentStatus = "ok" | "degraded" | "down";

export interface ComponentHealth {
  status: ComponentStatus;
  /** Human-readable detail, shown directly in the UI. */
  detail: string;
  /** Round-trip time of the check, in milliseconds. */
  latencyMs?: number;
}

/**
 * The control plane reports health for each dependency independently, and stays
 * up when any of them is down.
 *
 * This is the practical form of the argument in ARCHITECTURE §3 for keeping
 * metadata in SQLite: when Docker is unreachable, the UI must still boot and
 * say so, rather than failing to start alongside the thing it is meant to
 * diagnose.
 */
export interface HealthReport {
  status: ComponentStatus;
  version: string;
  instanceId: string;
  uptimeSeconds: number;
  components: {
    database: ComponentHealth;
    docker: ComponentHealth;
    worker: ComponentHealth;
    /** Whether project data can actually be written where the config says. */
    storage: ComponentHealth;
    /** Free space, and whether the reserve has been eaten into. */
    disk: ComponentHealth;
  };
  /** Per-filesystem detail behind the `disk` component. */
  filesystems: FilesystemUsage[];
}

export interface FilesystemUsage {
  label: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
  hasHeadroom: boolean;
}
