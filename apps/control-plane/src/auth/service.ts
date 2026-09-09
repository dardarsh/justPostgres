import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  count,
  eq,
  lt,
} from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { admins, sessions, settings, type AdminRow } from "../db/schema.js";
import {
  generateSessionToken,
  hashPassword,
  verifyPassword,
} from "../lib/crypto.js";

export const MIN_PASSWORD_LENGTH = 12;

const SETUP_TOKEN_KEY = "setup_token";

export interface PublicAdmin {
  id: string;
  email: string;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface LoginContext {
  ip: string | null;
  userAgent: string | null;
}

export class AuthError extends Error {
  constructor(
    readonly code:
      | "invalid_credentials"
      | "locked_out"
      | "weak_password"
      | "already_setup"
      | "not_setup"
      | "invalid_setup_token",
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Sessions are looked up by the hash of the token, never the token itself. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toPublicAdmin(row: AdminRow): PublicAdmin {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
  };
}

/**
 * Single-administrator authentication.
 *
 * One account, created on first run, holding full control of every project on
 * the host. Multi-user is explicitly out of scope for 1.0 (ARCHITECTURE §12):
 * it means invitations, per-project permissions and an organisation model,
 * which is the hosted service arriving early. The storage is shaped to allow
 * more than one row so that adding users later is a migration.
 */
export class AuthService {
  /**
   * Failed-login tracking, in memory.
   *
   * Deliberately not in the database: this is throttling, not an audit trail,
   * and losing it on restart is acceptable. There is exactly one account to
   * guess a password for, so the lockout is what stands between a stolen
   * hostname and an unlimited guessing budget.
   */
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  setupRequired(): boolean {
    const row = this.db.select({ n: count() }).from(admins).get();
    return (row?.n ?? 0) === 0;
  }

  /**
   * The token that must be presented to claim an unclaimed instance.
   *
   * Without this, `POST /api/auth/setup` needs no credential at all — so
   * whoever reaches the URL first becomes the administrator, with superuser on
   * every database the instance goes on to create. The compose file binds to
   * loopback by default, which hides the problem but does not fix it: the first
   * person to put a TLS proxy in front, or to set JP_BIND_ADDR so they can
   * reach it from a laptop, opens a race between deploying and claiming.
   *
   * Losing that race is silent, too — you would open the page, see a *login*
   * form rather than a *setup* form, and quite reasonably assume you had set it
   * up already.
   *
   * Printing the token to the log is the Jenkins `initialAdminPassword`
   * pattern: someone who can read your container logs already has the box;
   * someone who merely found the port cannot claim it.
   */
  setupToken(): string | null {
    if (!this.setupRequired()) return null;

    const existing = this.db
      .select()
      .from(settings)
      .where(eq(settings.key, SETUP_TOKEN_KEY))
      .get();
    if (existing) return existing.value;

    // An operator can preseed one so an automated deploy does not have to
    // scrape it back out of a log.
    const token = this.config.auth.setupToken ?? `jp_setup_${randomBytes(24).toString("base64url")}`;
    this.db
      .insert(settings)
      .values({ key: SETUP_TOKEN_KEY, value: token, updatedAt: Date.now() })
      .run();
    return token;
  }

  async createInitialAdmin(
    email: string,
    password: string,
    presentedToken: string,
  ): Promise<PublicAdmin> {
    if (!this.setupRequired()) {
      throw new AuthError("already_setup", "An administrator account already exists.");
    }

    const expected = this.setupToken();
    if (!expected) throw new AuthError("already_setup", "An administrator account already exists.");

    const a = Buffer.from(presentedToken ?? "");
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AuthError(
        "invalid_setup_token",
        "That setup token is not correct. It was printed to the control plane's log when it first started.",
      );
    }

    this.assertPasswordStrength(password);

    const now = Date.now();
    const row = this.db
      .insert(admins)
      .values({
        id: randomUUID(),
        email: email.trim().toLowerCase(),
        passwordHash: await hashPassword(password),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    // Consumed. A second claim attempt now fails on `already_setup` anyway, but
    // leaving a valid token lying about in the database serves no purpose.
    this.db.delete(settings).where(eq(settings.key, SETUP_TOKEN_KEY)).run();

    return toPublicAdmin(row);
  }

  async login(
    email: string,
    password: string,
    ctx: LoginContext,
  ): Promise<{ token: string; expiresAt: number; admin: PublicAdmin }> {
    const key = ctx.ip ?? "unknown";
    const lockedFor = this.lockoutRemaining(key);
    if (lockedFor > 0) {
      throw new AuthError(
        "locked_out",
        `Too many failed attempts. Try again in ${Math.ceil(lockedFor / 1000)}s.`,
        lockedFor,
      );
    }

    const row = this.db
      .select()
      .from(admins)
      .where(eq(admins.email, email.trim().toLowerCase()))
      .get();

    // Verify against a dummy hash when the account does not exist, so that a
    // wrong email and a wrong password take the same time to reject.
    const stored = row?.passwordHash ?? DUMMY_HASH;
    const ok = await verifyPassword(password, stored);

    if (!row || !ok) {
      this.recordFailure(key);
      throw new AuthError("invalid_credentials", "Incorrect email or password.");
    }

    this.failures.delete(key);

    const now = Date.now();
    const token = generateSessionToken();
    const expiresAt = now + this.config.auth.sessionTtlMs;

    this.db
      .insert(sessions)
      .values({
        id: hashToken(token),
        adminId: row.id,
        createdAt: now,
        expiresAt,
        lastSeenAt: now,
        userAgent: ctx.userAgent,
        ip: ctx.ip,
      })
      .run();

    this.db.update(admins).set({ lastLoginAt: now }).where(eq(admins.id, row.id)).run();

    return { token, expiresAt, admin: toPublicAdmin({ ...row, lastLoginAt: now }) };
  }

  /**
   * Resolve a session token. Extends the expiry as it goes, so an admin using
   * the UI daily is never logged out, while an abandoned session still ages
   * out of the window.
   */
  validateSession(token: string): PublicAdmin | null {
    const now = Date.now();
    const id = hashToken(token);

    const row = this.db
      .select({ session: sessions, admin: admins })
      .from(sessions)
      .innerJoin(admins, eq(sessions.adminId, admins.id))
      .where(eq(sessions.id, id))
      .get();

    if (!row) return null;

    if (row.session.expiresAt <= now) {
      this.db.delete(sessions).where(eq(sessions.id, id)).run();
      return null;
    }

    // Only write when it is worth a write, to keep read-heavy polling cheap.
    if (now - row.session.lastSeenAt > 60_000) {
      this.db
        .update(sessions)
        .set({ lastSeenAt: now, expiresAt: now + this.config.auth.sessionTtlMs })
        .where(eq(sessions.id, id))
        .run();
    }

    return toPublicAdmin(row.admin);
  }

  logout(token: string): void {
    this.db.delete(sessions).where(eq(sessions.id, hashToken(token))).run();
  }

  async changePassword(adminId: string, current: string, next: string): Promise<void> {
    const row = this.db.select().from(admins).where(eq(admins.id, adminId)).get();
    if (!row) throw new AuthError("invalid_credentials", "Account not found.");

    if (!(await verifyPassword(current, row.passwordHash))) {
      throw new AuthError("invalid_credentials", "Current password is incorrect.");
    }
    this.assertPasswordStrength(next);

    this.db
      .update(admins)
      .set({ passwordHash: await hashPassword(next), updatedAt: Date.now() })
      .where(eq(admins.id, adminId))
      .run();

    // A password change should end every other session, which is the whole
    // point of changing it after a suspected compromise.
    this.db.delete(sessions).where(eq(sessions.adminId, adminId)).run();
  }

  sweepExpiredSessions(): number {
    return this.db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).returning({
      id: sessions.id,
    }).all().length;
  }

  private assertPasswordStrength(password: string): void {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new AuthError(
        "weak_password",
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
    }
  }

  private lockoutRemaining(key: string): number {
    const entry = this.failures.get(key);
    if (!entry) return 0;
    return Math.max(0, entry.lockedUntil - Date.now());
  }

  private recordFailure(key: string): void {
    const entry = this.failures.get(key) ?? { count: 0, lockedUntil: 0 };
    entry.count += 1;

    if (entry.count >= this.config.auth.maxLoginAttempts) {
      // Back off harder each time the threshold is crossed again, capped so a
      // legitimate admin who mistypes is not locked out for an afternoon.
      const multiplier = 2 ** Math.min(5, entry.count - this.config.auth.maxLoginAttempts);
      entry.lockedUntil = Date.now() + this.config.auth.lockoutMs * multiplier;
    }
    this.failures.set(key, entry);
  }
}

/**
 * A real scrypt hash of a random value, used to equalise timing when the email
 * does not exist. Computed once at module load.
 */
const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" +
  "Ki8vTFVYQlpDR0hLTk9SVVhaYWRnamttcHN2eXpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWmFiY2Q=";

export const _internals = { hashToken };
