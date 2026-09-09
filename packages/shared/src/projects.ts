export const PROJECT_STATES = [
  "creating",
  "running",
  "stopped",
  "failed",
  "deleting",
  /** Mid major-version upgrade. Owned by the upgrade job, not the reconciler. */
  "upgrading",
] as const;

export type ProjectState = (typeof PROJECT_STATES)[number];

/** A project in one of these states is being worked on by a job. */
export const TRANSIENT_PROJECT_STATES: readonly ProjectState[] = [
  "creating",
  "deleting",
  "upgrading",
];

export const PG_MAJOR_VERSIONS = [16, 17, 18] as const;
export type PgMajorVersion = (typeof PG_MAJOR_VERSIONS)[number];

export interface Project {
  id: string;
  /** Short public identifier, used in container names and connection strings. */
  ref: string;
  name: string;
  pgMajor: number;
  image: string;
  state: ProjectState;
  /** Why the project failed, when it did. */
  lastError: string | null;
  /** Published host port. Temporary until the router lands in M2. */
  hostPort: number | null;
  memoryBytes: number;
  nanoCpus: number;
  /** Set for branches and restores; null for a root project. */
  parentProjectId: string | null;
  branchPoint: number | null;
  /** How the copy was made: `cow` clones the filesystem, `pitr` replays WAL. */
  branchMethod: string | null;
  /** When an unpinned branch is deleted automatically. Null means pinned. */
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export const CONNECTION_KINDS = ["direct", "pooled", "container"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export interface ConnectionEndpoint {
  kind: ConnectionKind;
  label: string;
  /** What this endpoint is for, shown next to it so the choice is not a guess. */
  description: string;
  /** Caveats that will bite if ignored — transaction pooling's session-state rules. */
  caveat?: string;
  host: string;
  port: number;
  user: string;
  database: string;
  /** Present only when the password was explicitly requested. */
  url?: string;
  /** Always present; password replaced with dots. */
  maskedUrl: string;
  psql?: string;
}

export interface ProjectConnection {
  endpoints: ConnectionEndpoint[];
}

export interface CreateProjectRequest {
  name: string;
  pgMajor?: PgMajorVersion;
  memoryMb?: number;
  cpus?: number;
}

export const PROJECT_ACTIONS = ["start", "stop", "restart"] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

/** Live container facts, read from the runtime rather than the metadata store. */
export interface ProjectRuntime {
  containerExists: boolean;
  running: boolean;
  status: string | null;
  startedAt: string | null;
}


export interface BranchRequest {
  /** Epoch millis. Omitted branches from the current state. */
  targetTime?: number;
  name?: string;
  /** Hours until auto-deletion. 0 pins the branch indefinitely. */
  ttlHours?: number;
}

export interface BranchPlan {
  method: "cow" | "pitr";
  reason: string;
}

export interface BranchNode {
  project: Project;
  method: string | null;
  expiresAt: number | null;
  children: BranchNode[];
}


/** One major-version upgrade attempt, as the API reports it. */
export interface UpgradeRecord {
  id: string;
  projectId: string;
  fromMajor: number;
  toMajor: number;
  state: "running" | "succeeded" | "failed" | "rolled_back";
  jobId: string | null;
  /** The pre-upgrade data directory, kept until an operator discards it. */
  previousVolumeName: string | null;
  previousImage: string | null;
  previousDiscardedAt: number | null;
  manifestBefore: string | null;
  manifestAfter: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** What an upgrade would involve, shown before it is started. */
export interface UpgradePlan {
  fromMajor: number;
  toMajor: number;
  targetImage: string;
  imageAvailable: boolean;
  steps: string[];
  warnings: string[];
}

/** A stored reading, for the growth trend. */
export interface MetricSample {
  at: number;
  databaseBytes: number;
  connections: number;
}

export interface SlowQuery {
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
}

export interface IndexHint {
  kind: "unused_index" | "needs_vacuum";
  target: string;
  detail: string;
}

export interface ArchiverStatus {
  archivedCount: number;
  failedCount: number;
  lastArchivedAt: number | null;
  lastFailedAt: number | null;
  lastFailedWal: string | null;
  /** The most recent attempt failed. Alert-level, not a metric. */
  failingNow: boolean;
}

/** Everything the project overview shows about a running database. */
export interface ProjectMetrics {
  connections: number;
  maxConnections: number;
  activeQueries: number;
  /** Holds locks, pins the oldest transaction, and blocks vacuum. */
  idleInTransaction: number;
  longestQuerySeconds: number | null;
  longestTransactionSeconds: number | null;
  cacheHitRatio: number | null;
  databaseBytes: number;
  walBytes: number;
  archiver: ArchiverStatus;
  /** Null when pg_stat_statements is not installed. */
  slowQueries: SlowQuery[] | null;
  indexHints: IndexHint[];
  history: MetricSample[];
  /** Bytes per day over the last week, once there is enough history. */
  growthBytesPerDay?: number | null;
  sampledAt: number;
}
