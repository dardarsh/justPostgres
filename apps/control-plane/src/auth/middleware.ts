import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { resolveClientIp } from "./trusted-proxy.js";
import type { HonoEnv } from "../api/context.js";
import { HttpError } from "../api/errors.js";

export const SESSION_COOKIE = "jp_session";

/**
 * Set `Secure` only when the request actually arrived over TLS.
 *
 * Hardcoding it would lock out every self-hoster who reaches the control plane
 * over plain HTTP on a private network before putting a proxy in front, and
 * the failure mode — login silently never persisting — is miserable to debug.
 */
function isSecureRequest(c: Context): boolean {
  const forwarded = c.req.header("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]!.trim() === "https";
  return new URL(c.req.url).protocol === "https:";
}

export function setSessionCookie(c: Context, token: string, expiresAt: number): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c),
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

/**
 * Client address, honouring a proxy header when one is present and falling
 * back to the socket.
 *
 * The fallback matters: it is the key the login lockout is bucketed by, and
 * without it every direct connection shares one bucket — so a single attacker
 * could lock the real administrator out, and the throttle would not actually
 * be per-attacker.
 */
/**
 * The address a request came from, for the audit log and the login lockout.
 *
 * `X-Forwarded-For` is only believed when the connection came from a proxy the
 * operator listed in `JP_TRUSTED_PROXIES`. Believing it unconditionally — which
 * this did — let anyone defeat the per-address login lockout by sending a
 * different forged value on each attempt.
 */
export function clientIp(c: Context): string | null {
  let socketAddress: string | null = null;
  try {
    socketAddress = getConnInfo(c).remote.address ?? null;
  } catch {
    socketAddress = null;
  }

  return resolveClientIp({
    socketAddress,
    forwardedFor: c.req.header("x-forwarded-for") ?? null,
    realIp: c.req.header("x-real-ip") ?? null,
    trusted: c.get("ctx").config.auth.trustedProxies,
  });
}

/**
 * Require a valid session.
 *
 * Applied to every API route except health liveness and the auth endpoints
 * themselves. There is no anonymous read path: the project list alone reveals
 * what databases exist on the host.
 */
export function requireAuth(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const ctx = c.get("ctx");

    if (ctx.auth.setupRequired()) {
      throw new HttpError(
        401,
        "setup_required",
        "No administrator account exists yet. Complete first-run setup.",
      );
    }

    const token = readSessionCookie(c);
    if (!token) throw new HttpError(401, "unauthenticated", "Sign in to continue.");

    const admin = ctx.auth.validateSession(token);
    if (!admin) {
      clearSessionCookie(c);
      throw new HttpError(401, "unauthenticated", "Your session has expired. Sign in again.");
    }

    c.set("admin", admin);
    await next();
  };
}
