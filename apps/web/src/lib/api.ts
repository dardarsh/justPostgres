import type {
  BackupRun,
  BranchNode,
  BranchPlan,
  BranchRequest,
  BackupStatus,
  BrowseRequest,
  BrowseResult,
  CellValue,
  CreateProjectRequest,
  ExplainOutcome,
  ApiStatus,
  ExposeTableRequest,
  ExtensionState,
  PolicyTemplate,
  TableSecurity,
  QueryOutcome,
  RelationDetail,
  RestoreCheck,
  RestoreRequest,
  SchemaTree,
  EnqueueJobRequest,
  HealthReport,
  Job,
  Project,
  ProjectAction,
  ProjectConnection,
  ProjectRuntime,
  UpgradePlan,
  UpgradeRecord,
  AuditEntry,
  BackupVerification,
  ControlPlaneBackup,
  ControlPlaneBackupStatus,
  ProjectMetrics,
  ObjectStorageInput,
  ObjectStorageSettings,
  StorageTestResult,
} from "@justpostgres/shared";

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    // Session lives in an httpOnly cookie, so it must ride along explicitly.
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const err = (body as ApiErrorBody | null)?.error;
    throw new ApiError(
      response.status,
      err?.code ?? "unknown",
      err?.message ?? response.statusText,
      err?.details,
    );
  }

  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export interface AdminSummary {
  id: string;
  email: string;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface AuthStatus {
  setupRequired: boolean;
  setupTokenRequired?: boolean;
  authenticated: boolean;
  admin: AdminSummary | null;
}

export interface JobStats {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export const api = {
  // --- auth ---
  authStatus: () => request<AuthStatus>("/auth/status"),
  setup: (email: string, password: string, setupToken: string) =>
    post<{ admin: AdminSummary }>("/auth/setup", { email, password, setupToken }),
  login: (email: string, password: string) =>
    post<{ admin: AdminSummary }>("/auth/login", { email, password }),
  logout: () => post<{ ok: boolean }>("/auth/logout"),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ ok: boolean }>("/auth/password", { currentPassword, newPassword }),

  // --- instance administration ---
  audit: (opts: { projectId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.projectId) params.set("projectId", opts.projectId);
    if (opts.limit) params.set("limit", String(opts.limit));
    const query = params.toString();
    return request<{ entries: AuditEntry[] }>(`/admin/audit${query ? `?${query}` : ""}`);
  },
  objectStorage: () =>
    request<{ settings: ObjectStorageSettings | null }>("/admin/object-storage"),
  saveObjectStorage: (body: ObjectStorageInput) =>
    request<{ settings: ObjectStorageSettings }>("/admin/object-storage", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  testObjectStorage: (body?: ObjectStorageInput) =>
    request<StorageTestResult>("/admin/object-storage/test", {
      method: "POST",
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  clearObjectStorage: () => request<{ ok: boolean }>("/admin/object-storage", { method: "DELETE" }),
  migrateBackupsToObjectStorage: (id: string) =>
    post<{ jobId: string }>(`/projects/${id}/backups/migrate`),

  controlPlaneBackups: () =>
    request<{ status: ControlPlaneBackupStatus; backups: ControlPlaneBackup[] }>(
      "/admin/control-plane-backups",
    ),
  runControlPlaneBackup: () =>
    post<{ backup: ControlPlaneBackup }>("/admin/control-plane-backups"),
  verifyControlPlaneBackup: (name: string) =>
    request<BackupVerification>(`/admin/control-plane-backups/${name}/verify`),

  // --- health ---
  health: () => request<HealthReport>("/health"),

  // --- projects ---
  listProjects: () => request<{ projects: Project[] }>("/projects"),
  getProject: (id: string) =>
    request<{ project: Project; runtime: ProjectRuntime | null }>(`/projects/${id}`),
  createProject: (body: CreateProjectRequest) =>
    post<{ project: Project }>("/projects", body),
  deleteProject: (id: string) => request<{ project: Project }>(`/projects/${id}`, { method: "DELETE" }),
  projectAction: (id: string, action: ProjectAction) =>
    post<{ project: Project }>(`/projects/${id}/actions/${action}`),
  // --- major-version upgrades ---
  upgrades: (id: string) => request<{ upgrades: UpgradeRecord[] }>(`/projects/${id}/upgrades`),
  upgradePlan: (id: string, toMajor: number) =>
    request<UpgradePlan>(`/projects/${id}/upgrades/plan?toMajor=${toMajor}`),
  startUpgrade: (id: string, toMajor: number) =>
    post<{ upgrade: UpgradeRecord }>(`/projects/${id}/upgrades`, { toMajor }),
  discardPreviousData: (id: string, upgradeId: string) =>
    request<{ ok: boolean }>(`/projects/${id}/upgrades/${upgradeId}/previous`, { method: "DELETE" }),

  metrics: (id: string) => request<ProjectMetrics>(`/projects/${id}/metrics`),

  connection: (id: string, reveal = false) =>
    request<{ connection: ProjectConnection }>(
      `/projects/${id}/connection${reveal ? "?reveal=true" : ""}`,
    ),

  // --- data browser ---
  schema: (projectId: string) => request<SchemaTree>(`/projects/${projectId}/schema`),
  relation: (projectId: string, schema: string, table: string) =>
    request<RelationDetail>(
      `/projects/${projectId}/schema/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`,
    ),
  browse: (projectId: string, body: BrowseRequest) =>
    post<BrowseResult>(`/projects/${projectId}/browse`, body),
  insertRow: (projectId: string, schema: string, table: string, values: Record<string, CellValue>) =>
    post<{ row: Record<string, CellValue> }>(`/projects/${projectId}/rows`, { schema, table, values }),
  updateRow: (
    projectId: string,
    schema: string,
    table: string,
    key: Record<string, CellValue>,
    changes: Record<string, CellValue>,
  ) =>
    request<{ row: Record<string, CellValue> }>(`/projects/${projectId}/rows`, {
      method: "PATCH",
      body: JSON.stringify({ schema, table, key, changes }),
    }),
  deleteRow: (projectId: string, schema: string, table: string, key: Record<string, CellValue>) =>
    request<{ ok: boolean }>(`/projects/${projectId}/rows`, {
      method: "DELETE",
      body: JSON.stringify({ schema, table, key }),
    }),
  runQuery: (
    projectId: string,
    body: { sql: string; confirmed?: boolean; timeoutMs?: number; maxRows?: number },
  ) => post<QueryOutcome>(`/projects/${projectId}/query`, body),
  explain: (projectId: string, sql: string, analyze: boolean) =>
    post<ExplainOutcome>(`/projects/${projectId}/explain`, { sql, analyze }),

  // --- backups ---
  backups: (projectId: string) =>
    request<{ status: BackupStatus; runs: BackupRun[]; checks: RestoreCheck[] }>(
      `/projects/${projectId}/backups`,
    ),
  runBackup: (projectId: string, type?: "full" | "incr") =>
    post<{ ok: boolean }>(`/projects/${projectId}/backups/run`, type ? { type } : {}),
  verifyBackup: (projectId: string) => post<{ ok: boolean }>(`/projects/${projectId}/backups/verify`),
  restore: (projectId: string, body: RestoreRequest) =>
    post<{ project: Project }>(`/projects/${projectId}/restore`, body),
  promote: (projectId: string) =>
    post<{ promoted: Project; demoted: Project }>(`/projects/${projectId}/promote`),

  // --- branches ---
  branches: (projectId: string) => request<{ tree: BranchNode }>(`/projects/${projectId}/branches`),
  branchPlan: (projectId: string, targetTime?: number) =>
    request<{ plan: BranchPlan; snapshotsAvailable: boolean; driver: string }>(
      `/projects/${projectId}/branches/plan${targetTime ? `?targetTime=${targetTime}` : ""}`,
    ),
  createBranch: (projectId: string, body: BranchRequest) =>
    post<{ project: Project }>(`/projects/${projectId}/branches`, body),
  setBranchExpiry: (projectId: string, ttlHours: number | null) =>
    request<{ project: Project }>(`/projects/${projectId}/expiry`, {
      method: "PATCH",
      body: JSON.stringify({ ttlHours }),
    }),

  // --- extensions ---
  extensions: (projectId: string) =>
    request<{ extensions: ExtensionState[] }>(`/projects/${projectId}/extensions`),
  enableExtension: (projectId: string, name: string) =>
    post<{ mode: "immediate" | "restart"; version?: string }>(
      `/projects/${projectId}/extensions`,
      { name },
    ),
  disableExtension: (projectId: string, name: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/extensions/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  updateExtension: (projectId: string, name: string) =>
    post<{ version: string | null }>(
      `/projects/${projectId}/extensions/${encodeURIComponent(name)}/update`,
    ),

  // --- REST API and row-level security ---
  apiStatus: (projectId: string, reveal = false) =>
    request<{ status: ApiStatus | null }>(
      `/projects/${projectId}/api${reveal ? "?reveal=true" : ""}`,
    ),
  enableApi: (projectId: string) => post<{ ok: boolean }>(`/projects/${projectId}/api/enable`),
  disableApi: (projectId: string) => post<{ ok: boolean }>(`/projects/${projectId}/api/disable`),
  rotateApiKeys: (projectId: string) =>
    post<{ keys: { anon: string; service: string } }>(`/projects/${projectId}/api/rotate`),
  security: (projectId: string) =>
    request<{ tables: TableSecurity[]; templates: PolicyTemplate[] }>(
      `/projects/${projectId}/security`,
    ),
  exposeTable: (projectId: string, body: ExposeTableRequest) =>
    post<{ ok: boolean }>(`/projects/${projectId}/security/expose`, body),
  unexposeTable: (projectId: string, schema: string, table: string) =>
    post<{ ok: boolean }>(`/projects/${projectId}/security/unexpose`, { schema, table }),
  setRls: (projectId: string, schema: string, table: string, enabled: boolean) =>
    post<{ ok: boolean }>(`/projects/${projectId}/security/rls`, { schema, table, enabled }),

  // --- jobs ---
  listJobs: (limit = 50) => request<{ jobs: Job[]; stats: JobStats }>(`/jobs?limit=${limit}`),
  jobsForProject: (projectId: string) =>
    request<{ jobs: Job[]; stats: JobStats }>(`/jobs?projectId=${projectId}&limit=20`),
  enqueueJob: (body: EnqueueJobRequest) => post<{ job: Job }>("/jobs", body),
  cancelJob: (id: string) => post<{ job: Job }>(`/jobs/${id}/cancel`),
};
