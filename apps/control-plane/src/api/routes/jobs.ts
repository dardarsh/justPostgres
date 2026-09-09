import { Hono } from "hono";
import { z } from "zod";
import { JOB_STATES, JOB_TYPES } from "@justpostgres/shared";
import type { HonoEnv } from "../context.js";
import { HttpError } from "../errors.js";

const listQuerySchema = z.object({
  state: z.enum(JOB_STATES).optional(),
  projectId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const enqueueSchema = z.object({
  type: z.enum(JOB_TYPES),
  payload: z.record(z.string(), z.unknown()).optional(),
  projectId: z.string().nullable().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
});

export function jobRoutes() {
  const app = new Hono<HonoEnv>();

  app.get("/", (c) => {
    const query = listQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (!query.success) throw HttpError.badRequest(query.error);

    const queue = c.get("ctx").queue;
    return c.json({ jobs: queue.list(query.data), stats: queue.stats() });
  });

  app.get("/:id", (c) => {
    const job = c.get("ctx").queue.get(c.req.param("id"));
    if (!job) throw HttpError.notFound("job");
    return c.json({ job });
  });

  /**
   * Enqueue a job. In M0 the only registered type is `noop`, which exists so
   * the queue's behaviour can be exercised from the UI: watch it checkpoint,
   * kill the control plane mid-run, and see it resume.
   */
  app.post("/", async (c) => {
    const body = enqueueSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const job = c.get("ctx").queue.enqueue(body.data);
    return c.json({ job }, 201);
  });

  app.post("/:id/cancel", (c) => {
    const job = c.get("ctx").queue.requestCancel(c.req.param("id"));
    if (!job) throw HttpError.notFound("job");
    return c.json({ job });
  });

  return app;
}
