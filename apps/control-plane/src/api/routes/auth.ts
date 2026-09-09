import { Hono } from "hono";
import { z } from "zod";
import {
  clearSessionCookie,
  clientIp,
  readSessionCookie,
  requireAuth,
  setSessionCookie,
} from "../../auth/middleware.js";
import { AuthError, MIN_PASSWORD_LENGTH } from "../../auth/service.js";
import { audit } from "../../lib/audit.js";
import type { HonoEnv } from "../context.js";
import { HttpError } from "../errors.js";

const credentialsSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
});

const setupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
  /** Proves the claimant can read the instance's log, not merely reach its port. */
  setupToken: z.string().min(1).max(256),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
});

/** AuthError carries the code the UI branches on; map it rather than leaking a 500. */
function toHttpError(err: unknown): HttpError {
  if (err instanceof AuthError) {
    const status =
      err.code === "locked_out"
        ? 429
        : err.code === "already_setup"
          ? 409
          : err.code === "invalid_setup_token"
            ? 403
            : 400;
    return new HttpError(status, err.code, err.message);
  }
  throw err;
}

export function authRoutes() {
  const app = new Hono<HonoEnv>();

  /**
   * Unauthenticated on purpose: the login screen needs to know whether to show
   * first-run setup or a sign-in form. It reveals only whether an account
   * exists, which an attacker learns from the login page anyway.
   */
  app.get("/status", (c) => {
    const ctx = c.get("ctx");
    if (ctx.auth.setupRequired()) {
      // That a token is needed is not itself a secret — the UI has to know to
      // ask for it, and an attacker learns the same thing by trying.
      return c.json({
        setupRequired: true,
        setupTokenRequired: true,
        authenticated: false,
        admin: null,
      });
    }

    const token = readSessionCookie(c);
    const admin = token ? ctx.auth.validateSession(token) : null;
    return c.json({ setupRequired: false, authenticated: admin !== null, admin });
  });

  app.post("/setup", async (c) => {
    const body = setupSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    try {
      const admin = await ctx.auth.createInitialAdmin(
        body.data.email,
        body.data.password,
        body.data.setupToken,
      );

      // Sign the new admin straight in; making them log in immediately after
      // choosing a password is friction with no security value.
      const session = await ctx.auth.login(body.data.email, body.data.password, {
        ip: clientIp(c),
        userAgent: c.req.header("user-agent") ?? null,
      });
      setSessionCookie(c, session.token, session.expiresAt);

      audit(ctx.db.db, {
        actor: admin.email,
        action: "admin.setup",
        ip: clientIp(c),
      });
      ctx.logger.warn({ email: admin.email, ip: clientIp(c) }, "instance claimed by an administrator");
      return c.json({ admin }, 201);
    } catch (err) {
      const mapped = toHttpError(err);
      if (mapped.code === "invalid_setup_token") {
        // Worth seeing in a log: somebody reached an unclaimed instance and
        // tried to take it. Also written to the audit table, because the log is
        // where this scrolls away and the audit table is where an operator
        // actually looks.
        ctx.logger.warn({ ip: clientIp(c) }, "setup attempted with an incorrect token");
        audit(ctx.db.db, {
          actor: body.data.email,
          action: "admin.setup_failed",
          payload: { reason: mapped.code },
          ip: clientIp(c),
        });
      }
      throw mapped;
    }
  });

  app.post("/login", async (c) => {
    const body = credentialsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    try {
      const session = await ctx.auth.login(body.data.email, body.data.password, {
        ip: clientIp(c),
        userAgent: c.req.header("user-agent") ?? null,
      });
      setSessionCookie(c, session.token, session.expiresAt);

      audit(ctx.db.db, {
        actor: session.admin.email,
        action: "admin.login",
        ip: clientIp(c),
      });
      return c.json({ admin: session.admin });
    } catch (err) {
      const mapped = toHttpError(err);
      ctx.logger.warn({ ip: clientIp(c), code: mapped.code }, "failed login attempt");
      // Recorded, not just logged. There is one administrator account on this
      // instance and it holds superuser credentials for every database on the
      // host; a run of failed attempts against it is precisely what the audit
      // log exists to make visible. The address is kept, the password is not.
      audit(ctx.db.db, {
        actor: body.data.email,
        action: "admin.login_failed",
        payload: { reason: mapped.code },
        ip: clientIp(c),
      });
      throw mapped;
    }
  });

  app.post("/logout", (c) => {
    const token = readSessionCookie(c);
    if (token) c.get("ctx").auth.logout(token);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.get("/me", requireAuth(), (c) => c.json({ admin: c.get("admin") }));

  app.post("/password", requireAuth(), async (c) => {
    const body = changePasswordSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    const admin = c.get("admin")!;
    try {
      await ctx.auth.changePassword(admin.id, body.data.currentPassword, body.data.newPassword);
    } catch (err) {
      throw toHttpError(err);
    }

    // changePassword drops every session including this one, by design.
    clearSessionCookie(c);
    audit(ctx.db.db, { actor: admin.email, action: "admin.password_changed", ip: clientIp(c) });
    return c.json({ ok: true, reauthenticationRequired: true });
  });

  return app;
}
