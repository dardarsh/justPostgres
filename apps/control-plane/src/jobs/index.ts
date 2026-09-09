import type { ObjectStorageService } from "../backups/object-storage.js";
import type { BackupService } from "../backups/service.js";
import type { DataStore } from "../storage/datastore.js";
import { createBackupMigrateHandler } from "./handlers/backup-migrate.js";
import { createBackupRunHandler } from "./handlers/backup-run.js";
import { createBranchRunHandler } from "./handlers/branch-run.js";
import { createExtensionEnableHandler } from "./handlers/extension-enable.js";
import { createRestEnableHandler } from "./handlers/rest-enable.js";
import type { DataPoolManager } from "../data/pool.js";
import { createProjectCreateHandler } from "./handlers/project-create.js";
import { createRestoreRunHandler } from "./handlers/restore-run.js";
import { createRestoreVerifyHandler } from "./handlers/restore-verify.js";
import { createProjectDeleteHandler } from "./handlers/project-delete.js";
import { createProjectUpgradeHandler } from "./handlers/project-upgrade.js";
import { noopHandler } from "./handlers/noop.js";
import type { JobDeps } from "./deps.js";
import { JobRegistry } from "./registry.js";

export { JobQueue } from "./queue.js";
export { JobWorker } from "./worker.js";
export { JobRegistry, JobCancelledError } from "./registry.js";
export type { JobHandler, JobContext } from "./registry.js";
export type { JobDeps } from "./deps.js";

/**
 * The single place handlers are wired up. Adding a job type means writing a
 * handler and adding one line here.
 */
export function createRegistry(
  deps: JobDeps,
  backups: BackupService,
  store: DataStore,
  pools: DataPoolManager,
  storage: ObjectStorageService,
): JobRegistry {
  const registry = new JobRegistry();
  registry.register(noopHandler);
  registry.register(createProjectCreateHandler(deps, store, backups));
  registry.register(createProjectDeleteHandler(deps, store));
  registry.register(createBranchRunHandler(deps, backups, store));
  registry.register(createBackupRunHandler(deps, backups));
  registry.register(createBackupMigrateHandler(deps, backups, storage));
  registry.register(createRestoreRunHandler(deps, backups, store));
  registry.register(createRestoreVerifyHandler(deps, backups));
  registry.register(createExtensionEnableHandler(deps, backups, pools));
  registry.register(createRestEnableHandler(deps, pools));
  registry.register(createProjectUpgradeHandler(deps, backups, store));
  return registry;
}
