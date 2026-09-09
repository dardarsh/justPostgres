import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { DbHandle } from "../db/index.js";
import type { Logger } from "../logger.js";

/**
 * Backing up the control plane's own database.
 *
 * ARCHITECTURE §3 argues for SQLite because the process that explains an outage
 * must survive it. That argument has a bill attached, and this is it: the
 * metadata store is a single file on one host, and losing it loses the mapping
 * from projects to containers, the backup configuration for every project, and
 * — worst — the encrypted superuser credentials. The databases would still be
 * running and still hold their data, but nothing would know how to reach them.
 *
 * Two things this deliberately does not do:
 *
 *  - **It does not include `JP_MASTER_KEY`.** The credentials in here are
 *    encrypted with it, so a backup without the key is unreadable and a backup
 *    with the key beside it is the whole crown jewels in one archive. The key
 *    belongs somewhere else, and the docs say so.
 *  - **It does not restore into a running control plane.** Swapping the
 *    database out from under a process holding open handles and mid-flight jobs
 *    is how you get a corrupt file and a confused job worker. Restore is a
 *    startup path, guarded and loud.
 */

export interface ControlPlaneBackup {
  name: string;
  sizeBytes: number;
  createdAt: number;
  /** SHA-256 of the file, so a copy taken off the host can be checked. */
  sha256: string;
}

export interface BackupVerification {
  ok: boolean;
  detail: string;
  /** Row counts for the tables that matter, when the file is readable. */
  contents?: Record<string, number>;
}

/** Not a failure: there is deliberately nothing to do. */
export class SkipBackup extends Error {
  readonly code = "nothing_to_back_up";
}

/** Written by this service, and the only names it will read back. */
const NAME_PATTERN = /^cp-\d{8}T\d{6}Z\.sqlite$/;

/** Counted during verification: a backup with no projects in it is suspicious. */
const CHECKED_TABLES = ["projects", "credentials", "admins", "backup_configs", "upgrades"];

export class ControlPlaneBackupService {
  private readonly dir: string;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config,
    private readonly handle: DbHandle,
    private readonly logger: Logger,
  ) {
    this.dir = config.controlPlaneBackups.dir;
  }

  start(): void {
    if (this.timer) return;
    if (this.config.controlPlaneBackups.intervalHours <= 0) {
      this.logger.warn(
        "Control-plane backups are disabled. The metadata store is the one piece of state " +
          "justpostgres cannot rebuild from the host, so this is a deliberate risk.",
      );
      return;
    }

    // One on boot. A host that reboots daily and is never up long enough to
    // hit the interval would otherwise never take one at all.
    void this.run().catch(() => {});
    this.timer = setInterval(
      () => void this.run().catch(() => {}),
      this.config.controlPlaneBackups.intervalHours * 3_600_000,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): { lastRunAt: number | null; lastError: string | null; count: number; dir: string } {
    return {
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      count: this.list().length,
      dir: this.dir,
    };
  }

  list(): ControlPlaneBackup[] {
    mkdirSync(this.dir, { recursive: true });
    return readdirSync(this.dir)
      .filter((name) => NAME_PATTERN.test(name))
      .map((name) => {
        const path = join(this.dir, name);
        const stat = statSync(path);
        return {
          name,
          sizeBytes: stat.size,
          createdAt: stat.mtimeMs,
          sha256: sha256Of(path, stat),
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Take one, verify it, and prune.
   *
   * `sqlite.backup()` is SQLite's online backup API, not a file copy: it takes
   * a consistent snapshot of a database that is being written to, which a `cp`
   * of a WAL-mode file emphatically is not. Getting this wrong produces a
   * backup that restores to a torn state, and only on the day it is needed.
   */
  async run(): Promise<ControlPlaneBackup> {
    // An unclaimed instance has nothing worth keeping, and the verification
    // below would reject the backup for having no administrator — which is
    // correct, but reporting it as a failure every few hours would train an
    // operator to ignore the one message that matters when it is real.
    if (!this.hasAdmin()) {
      throw new SkipBackup("this instance has not been claimed yet, so there is nothing to back up");
    }

    mkdirSync(this.dir, { recursive: true });
    const name = `cp-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.sqlite`;
    const path = join(this.dir, name);

    try {
      await this.handle.sqlite.backup(path);

      // Verified now, while someone is watching. A backup nobody has opened is
      // a hypothesis — the same argument that puts restore checks in M4.
      const verification = this.verify(name);
      if (!verification.ok) {
        unlinkSync(path);
        throw new Error(`the backup just taken did not verify: ${verification.detail}`);
      }

      this.prune();
      this.lastRunAt = Date.now();
      this.lastError = null;

      const stat = statSync(path);
      this.logger.info(
        { name, sizeBytes: stat.size, contents: verification.contents },
        "control-plane backup taken",
      );
      return { name, sizeBytes: stat.size, createdAt: stat.mtimeMs, sha256: sha256Of(path, stat) };
    } catch (err) {
      if (err instanceof SkipBackup) {
        this.logger.debug(err.message);
        throw err;
      }
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger.error({ err }, "control-plane backup failed");
      throw err;
    }
  }

  private hasAdmin(): boolean {
    try {
      const row = this.handle.sqlite.prepare("select count(*) as n from admins").get() as {
        n: number;
      };
      return row.n > 0;
    } catch {
      // If the table cannot even be read, let the normal path run and report
      // the real error rather than silently deciding not to back up.
      return true;
    }
  }

  /** Open a backup read-only and check it is a database with content in it. */
  verify(name: string): BackupVerification {
    const path = this.pathFor(name);
    if (!path) return { ok: false, detail: "no such backup" };

    let db: Database.Database | null = null;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });

      const integrity = db.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") {
        return { ok: false, detail: `integrity_check said: ${String(integrity)}` };
      }

      const contents: Record<string, number> = {};
      for (const table of CHECKED_TABLES) {
        const row = db.prepare(`select count(*) as n from ${table}`).get() as { n: number };
        contents[table] = row.n;
      }

      // An admin row is what makes the instance usable at all. A backup without
      // one restores to a control plane that asks to be claimed again, which
      // would not look like a corrupt backup — it would look like a fresh
      // install, and someone would claim it.
      if ((contents.admins ?? 0) === 0) {
        return { ok: false, detail: "no administrator account in this backup", contents };
      }

      return { ok: true, detail: "opens cleanly and has an administrator", contents };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    } finally {
      db?.close();
    }
  }

  /** A readable stream for one backup, for downloading it off the host. */
  streamFor(name: string): NodeJS.ReadableStream | null {
    const path = this.pathFor(name);
    return path ? createReadStream(path) : null;
  }

  /**
   * Resolve a name to a path, refusing anything this service did not write.
   *
   * The name arrives in a URL, so it is attacker-controlled input naming a file
   * to read. Matching against the exact pattern and then confirming the
   * resolved path is still inside the directory covers both the obvious
   * traversal and the encoded ones.
   */
  private pathFor(name: string): string | null {
    if (!NAME_PATTERN.test(name)) return null;
    const path = resolve(this.dir, name);
    if (!path.startsWith(resolve(this.dir) + "/")) return null;
    try {
      statSync(path);
      return path;
    } catch {
      return null;
    }
  }

  private prune(): void {
    const keep = this.config.controlPlaneBackups.keep;
    for (const backup of this.list().slice(keep)) {
      try {
        unlinkSync(join(this.dir, backup.name));
        this.logger.debug({ name: backup.name }, "old control-plane backup removed");
      } catch (err) {
        this.logger.warn({ err, name: backup.name }, "could not remove old control-plane backup");
      }
    }
  }
}

/**
 * Hash a backup, memoised on size and mtime.
 *
 * The digest is worth listing — it is how someone checks that the copy they
 * pulled off the host is the file the host has — but the listing is polled, and
 * re-reading every backup on every poll would make a status endpoint the most
 * expensive thing in the process.
 */
const hashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

function sha256Of(path: string, stat: { size: number; mtimeMs: number }): string {
  const cached = hashCache.get(path);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.sha256;

  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  hashCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
  return sha256;
}
