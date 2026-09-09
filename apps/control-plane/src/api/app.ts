import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { AppContext, HonoEnv } from "./context.js";
import { HttpError } from "./errors.js";
import { requireAuth } from "../auth/middleware.js";
import { authRoutes } from "./routes/auth.js";
import { backupRoutes } from "./routes/backups.js";
import { branchRoutes } from "./routes/branches.js";
import { extensionRoutes } from "./routes/extensions.js";
import { restRoutes } from "./routes/rest.js";
import { upgradeRoutes } from "./routes/upgrades.js";
import { refFromHost, restProxyRoutes } from "../rest/proxy.js";
import { dataRoutes } from "./routes/data.js";
import { healthRoutes } from "./routes/health.js";
import { adminRoutes } from "./routes/admin.js";
import { jobRoutes } from "./routes/jobs.js";
import { projectRoutes } from "./routes/projects.js";

export function createApp(ctx: AppContext): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    await next();
  });

  // Request logging with a correlation id, echoed back so a user reporting a
  // problem can quote the id from their network tab.
  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? randomUUID();
    const started = Date.now();
    c.header("x-request-id", requestId);

    await next();

    const log = ctx.logger.child({ requestId });
    const entry = {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Date.now() - started,
    };
    // Health polling every few seconds would drown the log at info level.
    if (c.res.status >= 500) log.error(entry, "request failed");
    else if (c.res.status >= 400) log.warn(entry, "request rejected");
    else log.debug(entry, "request");
  });

  // A project's REST API is a public surface with its own authentication — the
  // JWT PostgREST validates. It is mounted before the admin session guard
  // because requiring an admin cookie would make it unusable by the
  // applications it exists for.
  if (ctx.config.rest.domainSuffix) {
    app.use("*", async (c, next) => {
      const ref = refFromHost(c.req.header("host"), ctx.config.rest.domainSuffix);
      if (!ref) return next();
      // Rewrite `<ref>.api.example.com/thing` to the path form and let the
      // proxy handle it, so there is one implementation rather than two.
      const url = new URL(c.req.url);
      const rewritten = new Request(
        `${url.origin}/rest/${ref}${url.pathname}${url.search}`,
        c.req.raw,
      );
      return app.fetch(rewritten, c.env);
    });
  }
  app.route("/rest", restProxyRoutes());

  // Unauthenticated: liveness for the container healthcheck, and the auth
  // endpoints themselves.
  app.get("/api/health/live", (c) => c.json({ status: "ok" }));
  app.route("/api/auth", authRoutes());

  // Everything else requires a session. There is no anonymous read path — the
  // project list alone reveals which databases exist on this host.
  app.use("/api/*", requireAuth());
  app.route("/api/health", healthRoutes());
  app.route("/api/admin", adminRoutes());
  app.route("/api/jobs", jobRoutes());
  app.route("/api/projects", projectRoutes());
  // Data browsing sits under the same prefix but in its own module: it talks to
  // the projects' databases, not to the control plane's.
  app.route("/api/projects", dataRoutes());
  app.route("/api/projects", backupRoutes());
  app.route("/api/projects", branchRoutes());
  app.route("/api/projects", extensionRoutes());
  app.route("/api/projects", restRoutes());
  app.route("/api/projects", upgradeRoutes());

  app.all("/api/*", (c) => c.json(HttpError.notFound("endpoint").toBody(), 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(err.toBody(), err.status as 400);
    ctx.logger.error({ err, path: new URL(c.req.url).pathname }, "unhandled error");
    return c.json(
      { error: { code: "internal_error", message: "Internal server error" } },
      500,
    );
  });

  if (ctx.config.ui.serve) {
    mountUi(app, ctx);
  }

  return app;
}

/**
 * Serve the built UI. In development Vite serves it instead and proxies /api
 * here, so this is only mounted when JP_SERVE_UI is on (the default in
 * production, where control plane and UI ship as one image).
 */
function mountUi(app: Hono<HonoEnv>, ctx: AppContext): void {
  const indexPath = join(ctx.config.ui.dir, "index.html");

  if (!existsSync(indexPath)) {
    ctx.logger.warn({ dir: ctx.config.ui.dir }, "UI assets not found; serving API only");
    return;
  }

  app.use("/*", serveStatic({ root: ctx.config.ui.dir }));

  // SPA fallback: any non-API path that matched no file returns index.html and
  // lets the client router decide.
  app.get("/*", async (c) => {
    const html = await readFile(indexPath, "utf8");
    return c.html(html);
  });

  ctx.logger.info({ dir: ctx.config.ui.dir }, "serving UI");
}
