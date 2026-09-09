import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
  close(): void;
}

/**
 * Put a backup of the metadata store in place before anything opens it.
 *
 * Restoring the control plane's own database cannot be an online operation: the
 * process holds open file handles and has jobs mid-flight, and swapping the
 * file underneath it produces a corrupt database and a job worker acting on
 * state that no longer exists. So it happens here, before the first handle is
 * opened, and only into an empty data directory.
 *
 * Refusing to overwrite an existing database is the important half. An operator
 * who leaves `JP_RESTORE_CONTROL_PLANE_FROM` set in their compose file — which
 * is exactly what happens after a successful restore — would otherwise roll the
 * instance back to that snapshot on every single restart, silently losing every
 * project created since.
 */
function restoreIfRequested(config: Config, logger: Logger): void {
  const source = config.controlPlaneBackups.restoreFrom;
  if (!source) return;

  if (existsSync(config.sqlitePath)) {
    logger.warn(
      { source, target: config.sqlitePath },
      "JP_RESTORE_CONTROL_PLANE_FROM is set but a metadata store already exists, so it was ignored. " +
        "Restoring would discard the current state. Move the existing file aside first, and unset " +
        "this variable once the restore has been done.",
    );
    return;
  }

  if (!existsSync(source)) {
    throw new Error(
      `JP_RESTORE_CONTROL_PLANE_FROM points at ${source}, which does not exist. Refusing to start ` +
        `with an empty database when a restore was asked for.`,
    );
  }

  mkdirSync(dirname(config.sqlitePath), { recursive: true });
  copyFileSync(source, config.sqlitePath);

  logger.warn(
    { source, target: config.sqlitePath },
    "RESTORED the control-plane metadata store from a backup.\n" +
      "\n  Projects, credentials and backup configuration now come from that snapshot.\n" +
      "  The reconciler will reconcile the running containers against it shortly.\n" +
      "  Unset JP_RESTORE_CONTROL_PLANE_FROM before the next restart.\n" +
      "  The credentials in it are encrypted: without the same JP_MASTER_KEY they are unreadable.\n",
  );
}

export function openDatabase(config: Config, logger: Logger): DbHandle {
  restoreIfRequested(config, logger);
  mkdirSync(dirname(config.sqlitePath), { recursive: true });

  const sqlite = new Database(config.sqlitePath);

  // WAL lets readers proceed during writes, which matters because the HTTP
  // handlers read the same database the job worker is writing to.
  sqlite.pragma("journal_mode = WAL");
  // NORMAL is the right durability trade for WAL: a crash cannot corrupt the
  // database, only lose the last transaction or two. Nothing here is worth an
  // fsync per commit.
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  // Wait rather than immediately throwing SQLITE_BUSY when a write lock is held.
  sqlite.pragma("busy_timeout = 5000");

  logger.debug({ path: config.sqlitePath }, "sqlite opened");

  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}
