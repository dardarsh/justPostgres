import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * HS256 JWTs, minted and verified in about forty lines.
 *
 * This is the whole of the identity story, and that is the point. justpostgres
 * issues keys and validates the ones it issued; it does not manage users,
 * sessions, password resets or OAuth providers. Anyone who needs those brings a
 * provider that can sign with the project's secret — Clerk, Auth0, WorkOS,
 * Better Auth — and its claims flow into RLS policies unchanged.
 *
 * That line is deliberate. A full authentication service is GoTrue, and
 * building one is how this project would become a worse Supabase
 * (ARCHITECTURE §7).
 */

export interface JwtClaims {
  /** The Postgres role PostgREST will `SET ROLE` to. The claim that matters. */
  role: string;
  iss?: string;
  iat?: number;
  exp?: number;
  sub?: string;
  [claim: string]: unknown;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signJwt(claims: JwtClaims, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function verifyJwt(token: string, secret: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JwtClaims;
    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * The signing secret.
 *
 * PostgREST requires at least 32 characters for HS256 and refuses to start
 * otherwise, so this is not a length anyone should be free to shorten.
 */
export function generateJwtSecret(): string {
  return randomBytes(48).toString("base64url");
}

export const ANON_ROLE = "anon";
export const SERVICE_ROLE = "service_role";
export const AUTHENTICATOR_ROLE = "authenticator";

/**
 * Long-lived API keys.
 *
 * No expiry, matching how every comparable product issues them: these are
 * configuration values that live in a deploy environment, and a key that
 * silently stops working at 3am is worse than one that has to be rotated
 * deliberately. Rotation is what `keyVersion` and the rotate endpoint are for.
 */
export function issueKeys(secret: string, keyVersion: number): { anon: string; service: string } {
  const issuedAt = Math.floor(Date.now() / 1000);
  const base = { iss: "justpostgres", iat: issuedAt, kv: keyVersion };

  return {
    anon: signJwt({ ...base, role: ANON_ROLE }, secret),
    service: signJwt({ ...base, role: SERVICE_ROLE }, secret),
  };
}
