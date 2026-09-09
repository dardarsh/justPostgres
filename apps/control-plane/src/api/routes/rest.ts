import { Hono } from "hono";
import { z } from "zod";
import { clientIp } from "../../auth/middleware.js";
import { audit } from "../../lib/audit.js";
import { ProjectError } from "../../projects/service.js";
import { POLICY_COMMANDS, POLICY_TEMPLATES } from "../../rest/rls.js";
import type { HonoEnv } from "../context.js";
import { HttpError } from "../errors.js";

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

export function restRoutes() {
  const app = new Hono<HonoEnv>();

  app.get("/:id/api", async (c) => {
    const reveal = new URL(c.req.url).searchParams.get("reveal") === "true";
    const ctx = c.get("ctx");
    try {
      const status = await ctx.rest.status(c.req.param("id"), { reveal });
      if (reveal && status) {
        audit(ctx.db.db, {
          actor: c.get("admin")!.email,
          action: "api.keys_revealed",
          projectId: c.req.param("id"),
          ip: clientIp(c),
        });
      }
      return c.json({ status });
    } catch (err) {
      toHttpError(err);
    }
  });

  app.post("/:id/api/enable", (c) => {
    const ctx = c.get("ctx");
    const admin = c.get("admin")!;
    try {
      ctx.rest.enable(c.req.param("id"), admin.email);
      audit(ctx.db.db, {
        actor: admin.email,
        action: "api.enable",
        projectId: c.req.param("id"),
        ip: clientIp(c),
      });
      return c.json({ ok: true }, 202);
    } catch (err) {
      toHttpError(err);
    }
  });

  app.post("/:id/api/disable", async (c) => {
    const ctx = c.get("ctx");
    const admin = c.get("admin")!;
    try {
      await ctx.rest.disable(c.req.param("id"), admin.email);
      audit(ctx.db.db, {
        actor: admin.email,
        action: "api.disable",
        projectId: c.req.param("id"),
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    } catch (err) {
      toHttpError(err);
    }
  });

  app.post("/:id/api/rotate", async (c) => {
    const ctx = c.get("ctx");
    const admin = c.get("admin")!;
    try {
      const keys = await ctx.rest.rotateKeys(c.req.param("id"), admin.email);
      audit(ctx.db.db, {
        actor: admin.email,
        action: "api.keys_rotated",
        projectId: c.req.param("id"),
        ip: clientIp(c),
      });
      return c.json({ keys });
    } catch (err) {
      toHttpError(err);
    }
  });

  // --- row-level security ---------------------------------------------------

  app.get("/:id/security", async (c) => {
    const schema = new URL(c.req.url).searchParams.get("schema") ?? "public";
    try {
      return c.json({
        tables: await c.get("ctx").rls.securityFor(c.req.param("id"), schema),
        templates: POLICY_TEMPLATES.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          needsColumn: t.needsColumn,
          columnLabel: "columnLabel" in t ? t.columnLabel : null,
          extraField: "extraField" in t ? t.extraField : null,
        })),
      });
    } catch (err) {
      toHttpError(err);
    }
  });

  app.post("/:id/security/expose", async (c) => {
    const body = z
      .object({
        schema: z.string().min(1).max(128).default("public"),
        table: z.string().min(1).max(128),
        privileges: z.array(z.enum(["SELECT", "INSERT", "UPDATE", "DELETE"])).min(1),
        template: z.enum(POLICY_TEMPLATES.map((t) => t.id) as [string, ...string[]]),
        column: z.string().min(1).max(128).optional(),
        claim: z.string().min(1).max(128).optional(),
        policyName: z.string().min(1).max(128).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    try {
      await ctx.rls.expose(c.req.param("id"), body.data as never);
      await ctx.rest.reloadSchemaCache(c.req.param("id"));
      audit(ctx.db.db, {
        actor: c.get("admin")!.email,
        action: "security.table_exposed",
        projectId: c.req.param("id"),
        payload: {
          table: `${body.data.schema}.${body.data.table}`,
          privileges: body.data.privileges,
          template: body.data.template,
        },
        ip: clientIp(c),
      });
      return c.json({ ok: true }, 201);
    } catch (err) {
      toHttpError(err);
    }
  });

  app.post("/:id/security/unexpose", async (c) => {
    const body = z
      .object({ schema: z.string().default("public"), table: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    try {
      await ctx.rls.unexpose(c.req.param("id"), body.data.schema, body.data.table);
      await ctx.rest.reloadSchemaCache(c.req.param("id"));
      audit(ctx.db.db, {
        actor: c.get("admin")!.email,
        action: "security.table_unexposed",
        projectId: c.req.param("id"),
        payload: { table: `${body.data.schema}.${body.data.table}` },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    } catch (err) {
      toHttpError(err);
    }
  });

  app.post("/:id/security/rls", async (c) => {
    const body = z
      .object({
        schema: z.string().default("public"),
        table: z.string().min(1),
        enabled: z.boolean(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    try {
      await ctx.rls.setRlsEnabled(
        c.req.param("id"),
        body.data.schema,
        body.data.table,
        body.data.enabled,
      );
      await ctx.rest.reloadSchemaCache(c.req.param("id"));
      audit(ctx.db.db, {
        actor: c.get("admin")!.email,
        action: body.data.enabled ? "security.rls_enabled" : "security.rls_disabled",
        projectId: c.req.param("id"),
        payload: { table: `${body.data.schema}.${body.data.table}` },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    } catch (err) {
      toHttpError(err);
    }
  });

  app.post("/:id/security/policies", async (c) => {
    const body = z
      .object({
        schema: z.string().default("public"),
        table: z.string().min(1),
        name: z.string().min(1).max(128),
        command: z.enum(POLICY_COMMANDS),
        roles: z.array(z.string().min(1).max(128)).default([]),
        using: z.string().max(8192).optional(),
        withCheck: z.string().max(8192).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    try {
      await ctx.rls.createRawPolicy(c.req.param("id"), body.data);
      audit(ctx.db.db, {
        actor: c.get("admin")!.email,
        action: "security.policy_created",
        projectId: c.req.param("id"),
        payload: { table: `${body.data.schema}.${body.data.table}`, name: body.data.name },
        ip: clientIp(c),
      });
      return c.json({ ok: true }, 201);
    } catch (err) {
      toHttpError(err);
    }
  });

  app.delete("/:id/security/policies/:name", async (c) => {
    const url = new URL(c.req.url);
    const schema = url.searchParams.get("schema") ?? "public";
    const table = url.searchParams.get("table");
    if (!table) throw HttpError.badRequest("A table is required.");

    const ctx = c.get("ctx");
    try {
      await ctx.rls.dropPolicy(c.req.param("id"), schema, table, c.req.param("name"));
      audit(ctx.db.db, {
        actor: c.get("admin")!.email,
        action: "security.policy_dropped",
        projectId: c.req.param("id"),
        payload: { table: `${schema}.${table}`, name: c.req.param("name") },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    } catch (err) {
      toHttpError(err);
    }
  });

  return app;
}
