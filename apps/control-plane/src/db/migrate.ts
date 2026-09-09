import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Logger } from "../logger.js";
import type { DbHandle } from "./index.js";

/**
 * Migrations are applied at boot, synchronously, before anything else starts.
 * A control plane that serves requests against a half-migrated schema is worse
 * than one that refuses to start.
 */
export function runMigrations(handle: DbHandle, migrationsFolder: string, logger: Logger): void {
  const started = Date.now();
  migrate(handle.db, { migrationsFolder });
  logger.info({ durationMs: Date.now() - started }, "migrations applied");
}
