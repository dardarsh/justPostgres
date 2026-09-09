import type { AuthService, PublicAdmin } from "../auth/service.js";
import type { Config } from "../config.js";
import type { BackupService } from "../backups/service.js";
import type { RestoreService } from "../backups/restore.js";
import type { BranchService } from "../branches/service.js";
import type { DataStore } from "../storage/datastore.js";
import type { DiskMonitor } from "../storage/disk.js";
import type { UpgradeService } from "../upgrades/service.js";
import type { ControlPlaneBackupService } from "../admin/cp-backup.js";
import type { MetricsService } from "../metrics/service.js";
import type { ObjectStorageService } from "../backups/object-storage.js";
import type { DataPoolManager } from "../data/pool.js";
import type { ExtensionService } from "../extensions/service.js";
import type { RestService } from "../rest/service.js";
import type { RlsService } from "../rest/rls.js";
import type { DbHandle } from "../db/index.js";
import type { DockerDriver } from "../docker/driver.js";
import type { JobQueue, JobWorker } from "../jobs/index.js";
import type { Reconciler } from "../projects/reconciler.js";
import type { ProjectService } from "../projects/service.js";
import type { Logger } from "../logger.js";

/** Everything the HTTP layer is allowed to reach. Assembled once in index.ts. */
export interface AppContext {
  config: Config;
  logger: Logger;
  db: DbHandle;
  queue: JobQueue;
  worker: JobWorker;
  docker: DockerDriver;
  auth: AuthService;
  projects: ProjectService;
  reconciler: Reconciler;
  dataPools: DataPoolManager;
  extensions: ExtensionService;
  rest: RestService;
  rls: RlsService;
  backups: BackupService;
  restores: RestoreService;
  branches: BranchService;
  dataStore: DataStore;
  disk: DiskMonitor;
  upgrades: UpgradeService;
  controlPlaneBackups: ControlPlaneBackupService;
  metrics: MetricsService;
  objectStorage: ObjectStorageService;
  startedAt: number;
  version: string;
}

export type HonoEnv = {
  Variables: {
    ctx: AppContext;
    /** Set by requireAuth(); absent on the unauthenticated routes. */
    admin?: PublicAdmin;
  };
};
