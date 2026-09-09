import { Hono } from "hono";
import { z } from "zod";
import { STORAGE_PROVIDERS } from "@justpostgres/shared";
import { clientIp } from "../../auth/middleware.js";
import { audit, listAudit } from "../../lib/audit.js";
import type { HonoEnv } from "../context.js";
import { SkipBackup } from "../../admin/cp-backup.js";
import { StorageError } from "../../backups/object-storage.js";
import { HttpError } from "../errors.js";

const storageSchema = z.object({
  provider: z.enum(STORAGE_PROVIDERS),
  bucket: z.string().min(1).max(255),
  prefix: z.string().max(255).optional(),
  region: z.string().max(64).optional(),
  endpoint: z.string().max(255).nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  accountId: z.string().max(128).nullish(),
  uriStyle: z.enum(["host", "path"]).optional(),
  verifyTls: z.boolean().optional(),
  accessKeyId: z.string().min(1).max(255),
  // Omitted on an edit that does not change it, so the stored one is kept.
  secretAccessKey: z.string().max(512).optional(),
});

const auditQuery = z.object({
  projectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * Instance-level operations, as opposed to per-project ones.
 *
 * The audit log and the control plane's own backups live together because they
 * answer the same question from opposite directions: what happened here, and
 * what would survive if this host did not.
 */
export function adminRoutes() {
  const app = new Hono<HonoEnv>();

  app.get("/audit", (c) => {
    const parsed = auditQuery.safeParse({
      projectId: c.req.query("projectId"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) throw HttpError.badRequest(parsed.error);

    const ctx = c.get("ctx");
    return c.json({
      entries: listAudit(ctx.db.db, {
        ...(parsed.data.projectId ? { projectId: parsed.data.projectId } : {}),
        ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
      }),
    });
  });

  // --- object storage for backups ------------------------------------------

  app.get("/object-storage", (c) => {
    const ctx = c.get("ctx");
    return c.json({ settings: ctx.objectStorage.status() });
  });

  app.put("/object-storage", async (c) => {
    const body = storageSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    try {
      const saved = ctx.objectStorage.save(body.data);
      audit(ctx.db.db, {
        actor: c.get("admin")!.email,
        action: "storage.configured",
        // The bucket and endpoint, never the keys.
        payload: { provider: saved.provider, bucket: saved.bucket, endpoint: saved.endpoint },
        ip: clientIp(c),
      });
      return c.json({ settings: saved });
    } catch (err) {
      if (err instanceof StorageError) throw new HttpError(400, "invalid_request", err.message);
      throw err;
    }
  });

  /**
   * Test without saving.
   *
   * The body is optional: with one, it tests what the person is currently
   * typing, which is the only useful moment to find out the region is wrong.
   * Without one, it re-tests what is stored.
   */
  app.post("/object-storage/test", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = raw ? storageSchema.safeParse(raw) : null;
    if (parsed && !parsed.success) throw HttpError.badRequest(parsed.error);

    const ctx = c.get("ctx");
    try {
      return c.json(await ctx.objectStorage.test(parsed?.data));
    } catch (err) {
      if (err instanceof StorageError) throw new HttpError(400, "invalid_request", err.message);
      throw err;
    }
  });

  app.delete("/object-storage", (c) => {
    const ctx = c.get("ctx");
    ctx.objectStorage.clear();
    audit(ctx.db.db, {
      actor: c.get("admin")!.email,
      action: "storage.cleared",
      ip: clientIp(c),
    });
    return c.json({ ok: true });
  });

  app.get("/control-plane-backups", (c) => {
    const ctx = c.get("ctx");
    return c.json({
      status: ctx.controlPlaneBackups.status(),
      backups: ctx.controlPlaneBackups.list(),
    });
  });

  app.post("/control-plane-backups", async (c) => {
    const ctx = c.get("ctx");
    try {
      const backup = await ctx.controlPlaneBackups.run();
      audit(ctx.db.db, {
        actor: c.get("admin")!.email,
        action: "control_plane.backup",
        payload: { name: backup.name },
        ip: clientIp(c),
      });
      return c.json({ backup }, 201);
    } catch (err) {
      if (err instanceof SkipBackup) throw new HttpError(409, err.code, err.message);
      throw new HttpError(
        500,
        "backup_failed",
        err instanceof Error ? err.message : "Could not back up the metadata store.",
      );
    }
  });

  app.get("/control-plane-backups/:name/verify", (c) => {
    const ctx = c.get("ctx");
    return c.json(ctx.controlPlaneBackups.verify(c.req.param("name")));
  });

  /**
   * Download one.
   *
   * The point of a backup that never leaves the host is limited, so this exists
   * — but it hands out every project's encrypted credentials in one file, which
   * is why it is behind the admin session and written to the audit log.
   */
  app.get("/control-plane-backups/:name/download", (c) => {
    const ctx = c.get("ctx");
    const name = c.req.param("name");
    const stream = ctx.controlPlaneBackups.streamFor(name);
    if (!stream) throw HttpError.notFound("backup");

    audit(ctx.db.db, {
      actor: c.get("admin")!.email,
      action: "control_plane.backup_downloaded",
      payload: { name },
      ip: clientIp(c),
    });

    return new Response(stream as unknown as ReadableStream, {
      headers: {
        "content-type": "application/vnd.sqlite3",
        "content-disposition": `attachment; filename="${name}"`,
      },
    });
  });

  return app;
}
