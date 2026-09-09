import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import type { DockerDriver } from "../docker/driver.js";
import type { DiskMonitor } from "../storage/disk.js";

/**
 * What job handlers are allowed to reach.
 *
 * Handlers are built as factories over this rather than importing singletons,
 * so a handler can be exercised against a fake Docker driver without standing
 * up a control plane.
 */
export interface JobDeps {
  db: Db;
  config: Config;
  docker: DockerDriver;
  /** Free space, for the handlers that write a lot of it. */
  disk: DiskMonitor;
}
