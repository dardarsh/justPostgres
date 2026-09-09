import { Hono } from "hono";
import { z } from "zod";
import { clientIp } from "../../auth/middleware.js";
import { audit } from "../../lib/audit.js";
import { ProjectError } from "../../projects/service.js";
import type { HonoEnv } from "../context.js";
import { HttpError } from "../errors.js";

const nameSchema = z.object({ name: z.string().min(1).max(128) });

function toHttpError(err: unknown): never {
  if (err instanceof ProjectError) {
    throw new HttpError(
      err.code === "not_found" ? 404 : err.code === "invalid_request" ? 400 : 409,
      err.code,
      err.message,
    );
  }
  const code = (err as { code?: string }).code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    throw new HttpError(400, `pg_${code}`, (err as Error).message);
  }
  throw err;
}

export function extensionRoutes() {
  const app = new Hono<HonoEnv>();

  app.get("/:id/extensions", async (c) => {
    try {
      return c.json({ extensions: await c.get("ctx").extensions.list(c.req.param("id")) });
    } catch (err) {
      toHttpError(err);
    }
  });

  app.post("/:id/extensions", async (c) => {
    const body = nameSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    const admin = c.get("admin")!;
    try {
      const result = await ctx.extensions.enable(c.req.param("id"), body.data.name, admin.email);
      audit(ctx.db.db, {
        actor: admin.email,
        action: "extension.enable",
        projectId: c.req.param("id"),
        payload: { name: body.data.name, mode: result.mode },
        ip: clientIp(c),
      });
      // 202 when a restart is queued: the extension is not usable yet, and
      // saying 200 would invite the UI to claim otherwise.
      return c.json(result, result.mode === "restart" ? 202 : 201);
    } catch (err) {
      toHttpError(err);
    }
  });

  app.delete("/:id/extensions/:name", async (c) => {
    const ctx = c.get("ctx");
    const admin = c.get("admin")!;
    try {
      await ctx.extensions.disable(c.req.param("id"), c.req.param("name"), admin.email);
      audit(ctx.db.db, {
        actor: admin.email,
        action: "extension.disable",
        projectId: c.req.param("id"),
        payload: { name: c.req.param("name") },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    } catch (err) {
      toHttpError(err);
    }
  });

  app.post("/:id/extensions/:name/update", async (c) => {
    const ctx = c.get("ctx");
    const admin = c.get("admin")!;
    try {
      const version = await ctx.extensions.update(c.req.param("id"), c.req.param("name"), admin.email);
      audit(ctx.db.db, {
        actor: admin.email,
        action: "extension.update",
        projectId: c.req.param("id"),
        payload: { name: c.req.param("name"), version },
        ip: clientIp(c),
      });
      return c.json({ version });
    } catch (err) {
      toHttpError(err);
    }
  });

  return app;
}
