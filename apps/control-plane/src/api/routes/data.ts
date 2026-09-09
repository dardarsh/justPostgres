import { Hono } from "hono";
import { z } from "zod";
import { clientIp } from "../../auth/middleware.js";
import { browseTable, BrowseError, FILTER_OPERATORS } from "../../data/browse.js";
import { UnsafeIdentifierError } from "../../data/identifiers.js";
import { fetchRelationDetail, fetchSchemaTree } from "../../data/introspect.js";
import { deleteRow, insertRow, MutationError, updateRow } from "../../data/mutate.js";
import { explainQuery, runQuery } from "../../data/query.js";
import { audit } from "../../lib/audit.js";
import { ProjectError } from "../../projects/service.js";
import type { HonoEnv } from "../context.js";
import { HttpError } from "../errors.js";

const cellValue = z.union([z.string(), z.null()]);

/** Statements after which PostgREST's cached view of the schema is wrong. */
const DDL_COMMANDS = new Set(["CREATE", "ALTER", "DROP", "COMMENT", "GRANT", "REVOKE"]);

const browseSchema = z.object({
  schema: z.string().min(1).max(128),
  table: z.string().min(1).max(128),
  limit: z.number().int().min(1).max(1000).optional(),
  cursor: z.string().max(8192).optional(),
  sort: z
    .object({ column: z.string().min(1).max(128), direction: z.enum(["asc", "desc"]) })
    .optional(),
  filters: z
    .array(
      z.object({
        column: z.string().min(1).max(128),
        operator: z.enum(FILTER_OPERATORS),
        value: z.string().max(4096).optional(),
      }),
    )
    .max(16)
    .optional(),
  countMode: z.enum(["estimate", "exact"]).optional(),
});

const rowKeySchema = z.record(z.string(), cellValue);

const querySchema = z.object({
  sql: z.string().min(1).max(1024 * 512),
  confirmed: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  maxRows: z.number().int().min(1).max(100_000).optional(),
});

const explainSchema = z.object({
  sql: z.string().min(1).max(1024 * 128),
  analyze: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
});

/**
 * Failures here are the user's SQL being wrong far more often than the server
 * being broken, so they come back as 400s carrying the database's own message.
 * Hiding a syntax error behind a generic 500 would make the editor useless.
 */
function toHttpError(err: unknown): never {
  if (err instanceof ProjectError) {
    const status =
      err.code === "not_found" ? 404 : err.code === "invalid_request" ? 400 : 409;
    throw new HttpError(status, err.code, err.message);
  }
  if (err instanceof BrowseError || err instanceof MutationError || err instanceof UnsafeIdentifierError) {
    throw new HttpError(400, "invalid_request", err.message);
  }
  // A Postgres error object carries a SQLSTATE; anything with one came from the
  // database rather than from us.
  const code = (err as { code?: string }).code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    throw new HttpError(400, `pg_${code}`, (err as Error).message);
  }
  throw err;
}

export function dataRoutes() {
  const app = new Hono<HonoEnv>();

  app.get("/:id/schema", async (c) => {
    try {
      return c.json(await fetchSchemaTree(c.get("ctx").dataPools, c.req.param("id")));
    } catch (err) {
      toHttpError(err);
    }
  });

  app.get("/:id/schema/:schema/:table", async (c) => {
    try {
      const detail = await fetchRelationDetail(
        c.get("ctx").dataPools,
        c.req.param("id"),
        c.req.param("schema"),
        c.req.param("table"),
      );
      if (!detail) throw HttpError.notFound("table");
      return c.json(detail);
    } catch (err) {
      toHttpError(err);
    }
  });

  app.post("/:id/browse", async (c) => {
    const body = browseSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    try {
      return c.json(
        await browseTable(ctx.dataPools, c.req.param("id"), {
          schema: body.data.schema,
          table: body.data.table,
          limit: body.data.limit ?? 50,
          filters: body.data.filters ?? [],
          ...(body.data.sort ? { sort: body.data.sort } : {}),
          ...(body.data.cursor ? { cursor: body.data.cursor } : {}),
          ...(body.data.countMode ? { countMode: body.data.countMode } : {}),
        }),
      );
    } catch (err) {
      toHttpError(err);
    }
  });

  app.post("/:id/rows", async (c) => {
    const body = z
      .object({
        schema: z.string().min(1).max(128),
        table: z.string().min(1).max(128),
        values: z.record(z.string(), cellValue),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    try {
      const row = await insertRow(
        ctx.dataPools,
        c.req.param("id"),
        body.data.schema,
        body.data.table,
        body.data.values,
      );
      audit(ctx.db.db, {
        actor: c.get("admin")!.email,
        action: "data.insert",
        projectId: c.req.param("id"),
        payload: { table: `${body.data.schema}.${body.data.table}` },
        ip: clientIp(c),
      });
      return c.json({ row }, 201);
    } catch (err) {
      toHttpError(err);
    }
  });

  app.patch("/:id/rows", async (c) => {
    const body = z
      .object({
        schema: z.string().min(1).max(128),
        table: z.string().min(1).max(128),
        key: rowKeySchema,
        changes: z.record(z.string(), cellValue),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    try {
      const row = await updateRow(
        ctx.dataPools,
        c.req.param("id"),
        body.data.schema,
        body.data.table,
        body.data.key,
        body.data.changes,
      );
      audit(ctx.db.db, {
        actor: c.get("admin")!.email,
        action: "data.update",
        projectId: c.req.param("id"),
        payload: {
          table: `${body.data.schema}.${body.data.table}`,
          columns: Object.keys(body.data.changes),
        },
        ip: clientIp(c),
      });
      return c.json({ row });
    } catch (err) {
      toHttpError(err);
    }
  });

  app.delete("/:id/rows", async (c) => {
    const body = z
      .object({
        schema: z.string().min(1).max(128),
        table: z.string().min(1).max(128),
        key: rowKeySchema,
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    try {
      await deleteRow(
        ctx.dataPools,
        c.req.param("id"),
        body.data.schema,
        body.data.table,
        body.data.key,
      );
      audit(ctx.db.db, {
        actor: c.get("admin")!.email,
        action: "data.delete",
        projectId: c.req.param("id"),
        payload: { table: `${body.data.schema}.${body.data.table}`, key: body.data.key },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    } catch (err) {
      toHttpError(err);
    }
  });

  app.post("/:id/query", async (c) => {
    const body = querySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    try {
      const outcome = await runQuery(ctx.dataPools, ctx.config, c.req.param("id"), body.data);

      // A migration through the SQL editor changes the shape PostgREST cached
      // at startup. Without this, a table created here is invisible to the API
      // until something restarts it — which reads as a bug in the API rather
      // than a stale cache.
      if (outcome.results.some((r) => DDL_COMMANDS.has((r.command ?? "").toUpperCase()))) {
        void ctx.rest.reloadSchemaCache(c.req.param("id"));
      }

      // Only log statements that actually ran. Logging the SQL itself would put
      // whatever the user selected — quite possibly personal data in a WHERE
      // clause — into a table that outlives the project.
      if (!outcome.requiresConfirmation && outcome.results.length > 0) {
        audit(ctx.db.db, {
          actor: c.get("admin")!.email,
          action: "data.query",
          projectId: c.req.param("id"),
          payload: {
            statements: outcome.results.length,
            commands: outcome.results.map((r) => r.command).filter(Boolean),
          },
          ip: clientIp(c),
        });
      }
      return c.json(outcome);
    } catch (err) {
      toHttpError(err);
    }
  });

  app.post("/:id/explain", async (c) => {
    const body = explainSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    try {
      return c.json(
        await explainQuery(ctx.dataPools, ctx.config, c.req.param("id"), body.data.sql, {
          ...(body.data.analyze !== undefined ? { analyze: body.data.analyze } : {}),
          ...(body.data.timeoutMs !== undefined ? { timeoutMs: body.data.timeoutMs } : {}),
        }),
      );
    } catch (err) {
      toHttpError(err);
    }
  });

  return app;
}
