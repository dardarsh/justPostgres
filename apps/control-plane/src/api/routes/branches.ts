import { Hono } from "hono";
import { z } from "zod";
import { clientIp } from "../../auth/middleware.js";
import { audit } from "../../lib/audit.js";
import { ProjectError } from "../../projects/service.js";
import type { HonoEnv } from "../context.js";
import { HttpError } from "../errors.js";
import { DiskSpaceError } from "../../storage/disk.js";

const branchSchema = z.object({
  targetTime: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(64).optional(),
  ttlHours: z.number().int().min(0).max(24 * 365).optional(),
});

function toHttpError(err: unknown): never {
  if (err instanceof DiskSpaceError) {
    // 507 Insufficient Storage. The message is the operator's next action, so
    // it goes through to the client verbatim rather than being genericised.
    throw new HttpError(507, err.code, err.message);
  }
  if (err instanceof ProjectError) {
    const status =
      err.code === "not_found" ? 404 : err.code === "invalid_request" ? 400 : 409;
    throw new HttpError(status, err.code, err.message);
  }
  throw err;
}

export function branchRoutes() {
  const app = new Hono<HonoEnv>();

  /**
   * What a branch of this project would cost, before committing to one.
   *
   * Surfaced because the two strategies differ by orders of magnitude and the
   * reason is not something a user should have to infer from how long it took.
   */
  app.get("/:id/branches/plan", (c) => {
    const raw = new URL(c.req.url).searchParams.get("targetTime");
    const targetTime = raw ? Number(raw) : undefined;
    return c.json({
      plan: c.get("ctx").branches.planFor(Number.isFinite(targetTime) ? targetTime : undefined),
      snapshotsAvailable: c.get("ctx").dataStore.supportsSnapshot,
      driver: c.get("ctx").dataStore.kind,
    });
  });

  app.get("/:id/branches", (c) => {
    const tree = c.get("ctx").branches.tree(c.req.param("id"));
    if (!tree) throw HttpError.notFound("project");
    return c.json({ tree });
  });

  app.post("/:id/branches", async (c) => {
    const body = branchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    const admin = c.get("admin")!;
    try {
      const project = await ctx.branches.create(c.req.param("id"), body.data, admin.email);
      audit(ctx.db.db, {
        actor: admin.email,
        action: "branch.create",
        projectId: c.req.param("id"),
        payload: { branch: project.id, ref: project.ref, method: project.branchMethod },
        ip: clientIp(c),
      });
      return c.json({ project }, 201);
    } catch (err) {
      toHttpError(err);
    }
  });

  /** Pin a branch, or give it a new lease. */
  app.patch("/:id/expiry", async (c) => {
    const body = z
      .object({ ttlHours: z.number().int().min(0).max(24 * 365).nullable() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    try {
      const project = ctx.branches.setExpiry(c.req.param("id"), body.data.ttlHours);
      audit(ctx.db.db, {
        actor: c.get("admin")!.email,
        action: "branch.expiry_changed",
        projectId: c.req.param("id"),
        payload: { ttlHours: body.data.ttlHours },
        ip: clientIp(c),
      });
      return c.json({ project });
    } catch (err) {
      toHttpError(err);
    }
  });

  return app;
}
