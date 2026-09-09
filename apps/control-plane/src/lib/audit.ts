import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { auditLog } from "../db/schema.js";

export interface AuditEntry {
  actor: string;
  action: string;
  projectId?: string | null;
  payload?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Record an action.
 *
 * Deliberately never throws: an audit failure must not roll back the operation
 * it describes. A missing log line is bad; a failed project deletion because
 * logging broke is worse.
 */
export function audit(db: Db, entry: AuditEntry): void {
  try {
    db.insert(auditLog)
      .values({
        id: randomUUID(),
        actor: entry.actor,
        action: entry.action,
        projectId: entry.projectId ?? null,
        payload: entry.payload ? JSON.stringify(entry.payload) : null,
        ip: entry.ip ?? null,
        at: Date.now(),
      })
      .run();
  } catch {
    // Intentionally swallowed. See above.
  }
}

export function listAudit(db: Db, opts: { projectId?: string; limit?: number } = {}) {
  return db
    .select()
    .from(auditLog)
    .where(opts.projectId ? eq(auditLog.projectId, opts.projectId) : undefined)
    .orderBy(desc(auditLog.at))
    .limit(Math.min(opts.limit ?? 100, 500))
    .all();
}
