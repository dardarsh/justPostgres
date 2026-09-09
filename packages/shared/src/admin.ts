/** A backup of the control plane's own metadata store. */
export interface ControlPlaneBackup {
  name: string;
  sizeBytes: number;
  createdAt: number;
  /** SHA-256, so a copy taken off the host can be checked against the original. */
  sha256: string;
}

export interface ControlPlaneBackupStatus {
  lastRunAt: number | null;
  lastError: string | null;
  count: number;
  dir: string;
}

export interface BackupVerification {
  ok: boolean;
  detail: string;
  contents?: Record<string, number>;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  projectId: string | null;
  /** JSON, or null. Shape depends on the action. */
  payload: string | null;
  ip: string | null;
  at: number;
}
