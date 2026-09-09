import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import type { Config } from "../config.js";
import { openDatabase } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { admins, auditLog, settings } from "../db/schema.js";
import type { Logger } from "../logger.js";

/**
 * Recovering an instance whose administrator password has been lost.
 *
 * There is no password reset in the product, and there should not be: a reset
 * link needs an email channel this thing does not have, and a security question
 * is worse than nothing. But "no reset" cannot mean "no recovery" — the
 * databases are still running, their credentials are still readable with
 * `JP_MASTER_KEY`, and the only thing missing is a way back in.
 *
 * So this removes the administrator account and nothing else. The instance
 * becomes unclaimed, mints a fresh setup token, and is claimed again through
 * the ordinary first-run flow — the one that is already written, already
 * tested, and already requires proving you are the operator.
 *
 * What it deliberately does not do:
 *
 *  - **Set a new password directly.** That means the password on a command
 *    line, which is shell history on the host and `docker inspect` output for
 *    anyone who can reach the daemon.
 *  - **Touch projects, credentials or backups.** They are encrypted under
 *    `JP_MASTER_KEY`, which this does not know and does not need. Every project
 *    keeps running throughout; only the management UI is briefly unclaimed.
 *
 * Requires shell access to the host, which is the right bar: anyone with that
 * could edit the SQLite file by hand anyway. This exists so they do not have to.
 */
export async function resetAdmin(
  config: Config,
  logger: Logger,
  migrationsDir: string,
): Promise<void> {
  const handle = openDatabase(config, logger);
  runMigrations(handle, migrationsDir, logger);
  const db = handle.db;

  try {
    const existing = db.select().from(admins).all();

    if (existing.length === 0) {
      console.log(
        "\nThis instance has no administrator account, so there is nothing to reset.\n" +
          "It is already unclaimed — start it and the setup token is printed to the log.\n",
      );
      return;
    }

    // Recorded before the account goes, and deliberately not cascaded away:
    // `audit_log` has no foreign key to `admins`, so the entry outlives the
    // account it describes. An administrator being removed is exactly the
    // event a later reader needs to find.
    for (const admin of existing) {
      db.insert(auditLog)
        .values({
          id: randomUUID(),
          actor: admin.email,
          action: "admin.reset",
          projectId: null,
          payload: JSON.stringify({ reason: "password recovery from the host" }),
          ip: null,
          at: Date.now(),
        })
        .run();
    }

    db.delete(admins).run();

    // Any stale token from a previous unclaimed period, so the next boot mints
    // a new one rather than accepting a value that may be sitting in an old log.
    db.delete(settings).where(eq(settings.key, "setup_token")).run();

    const remaining = db.select({ n: count() }).from(admins).get()?.n ?? 0;

    console.log(
      `\n  Removed ${existing.length} administrator account${existing.length === 1 ? "" : "s"}: ` +
        `${existing.map((a) => a.email).join(", ")}\n` +
        `\n  Sessions were removed with them, so any signed-in browser is now signed out.\n` +
        `  Projects, credentials and backups are untouched — every database kept running.\n` +
        `\n  Next: restart the control plane and claim it again.\n` +
        `\n      docker compose restart control-plane\n` +
        `      docker compose logs control-plane | grep jp_setup\n` +
        `\n  Then open the UI and create the account with that token.\n` +
        (remaining === 0 ? "" : `\n  WARNING: ${remaining} account(s) still present.\n`),
    );

    logger.warn(
      { removed: existing.map((a) => a.email) },
      "administrator account reset from the host; instance is unclaimed",
    );
  } finally {
    handle.close();
  }
}
