import { Hono } from "hono";
import { z } from "zod";
import { clientIp } from "../../auth/middleware.js";
import { audit } from "../../lib/audit.js";
import { ProjectError } from "../../projects/service.js";
import { DiskSpaceError } from "../../storage/disk.js";
import type { HonoEnv } from "../context.js";
import { HttpError } from "../errors.js";

function toHttpError(err: unknown): never {
  if (err instanceof DiskSpaceError) {
    throw new HttpError(507, err.code, err.message);
  }
  if (err instanceof ProjectError) {
    const status =
      err.code === "not_found" ? 404 : err.code === "conflict" || err.code === "invalid_state" ? 409 : 400;
    throw new HttpError(status, err.code, err.message);
  }
  throw err;
}

const startSchema = z.object({ toMajor: z.number().int().min(1).max(99) });

export function upgradeRoutes() {
  const app = new Hono<HonoEnv>();

  /** Past and present upgrades, newest first. */
  app.get("/:id/upgrades", (c) => {
    const ctx = c.get("ctx");
    return c.json({ upgrades: ctx.upgrades.history(c.req.param("id")) });
  });

  /**
   * What an upgrade would do, without doing it.
   *
   * Separate from starting one on purpose. A major-version upgrade takes the
   * database down for as long as the data takes to reload and leaves the
   * project without a valid recovery point until a new backup completes —
   * neither of which should first become apparent from a progress bar.
   */
  app.get("/:id/upgrades/plan", async (c) => {
    const ctx = c.get("ctx");
    const toMajor = Number(c.req.query("toMajor"));
    if (!Number.isInteger(toMajor)) {
      throw HttpError.badRequest("toMajor must be a Postgres major version, e.g. 18");
    }
    try {
      return c.json(await ctx.upgrades.plan(c.req.param("id"), toMajor));
    } catch (err) {
      toHttpError(err);
    }
  });

  app.post("/:id/upgrades", async (c) => {
    const body = startSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    try {
      const upgrade = await ctx.upgrades.start(
        c.req.param("id"),
        body.data.toMajor,
        c.get("admin")!.email,
      );
      audit(ctx.db.db, {
        actor: c.get("admin")!.email,
        action: "project.upgrade",
        projectId: c.req.param("id"),
        payload: { from: upgrade.fromMajor, to: upgrade.toMajor },
        ip: clientIp(c),
      });
      return c.json({ upgrade }, 202);
    } catch (err) {
      toHttpError(err);
    }
  });

  /** Delete the data directory retained from before an upgrade. */
  app.delete("/:id/upgrades/:upgradeId/previous", async (c) => {
    const ctx = c.get("ctx");
    try {
      await ctx.upgrades.discardPrevious(c.req.param("upgradeId"), c.get("admin")!.email);
      audit(ctx.db.db, {
        actor: c.get("admin")!.email,
        action: "project.upgrade.discard_previous",
        projectId: c.req.param("id"),
        payload: { upgradeId: c.req.param("upgradeId") },
        ip: clientIp(c),
      });
      return c.json({ ok: true });
    } catch (err) {
      toHttpError(err);
    }
  });

  return app;
}
