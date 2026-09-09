import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { parseMasterKey } from "@justpostgres/secrets";

const booleanish = z
  .string()
  .transform((v) => ["1", "true", "yes", "on"].includes(v.toLowerCase()));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  JP_LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  /** Same data directory as the control plane. The router reads it, never writes it. */
  JP_DATA_DIR: z.string().default("./data"),
  JP_MASTER_KEY: z.string(),

  /** Session mode: one client connection to one server connection, relayed. */
  JP_ROUTER_SESSION_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  /** Transaction mode: server connections are pooled and shared between clients. */
  JP_ROUTER_POOL_PORT: z.coerce.number().int().min(1).max(65535).default(6543),
  JP_ROUTER_HOST: z.string().default("0.0.0.0"),

  /** PEM paths. Without them the router answers SSLRequest with 'N' and SNI routing is unavailable. */
  JP_ROUTER_TLS_CERT: z.string().optional(),
  JP_ROUTER_TLS_KEY: z.string().optional(),
  /** Suffix stripped from the SNI hostname to get a project ref: <ref>.db.example.com */
  JP_ROUTER_DOMAIN_SUFFIX: z.string().optional(),

  /** How the router reaches a project's Postgres. */
  JP_ROUTER_BACKEND_HOST: z.string().default("127.0.0.1"),

  JP_POOL_SIZE: z.coerce.number().int().min(1).max(500).default(10),
  JP_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(300_000),
  JP_POOL_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).default(10_000),
  /**
   * Statement run on a server connection when it is returned to the pool.
   * Empty by default, matching PgBouncer and Supavisor — see pool.ts.
   */
  JP_POOL_RESET_QUERY: z.string().default(""),
  JP_POOL_CLIENT_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(0),

  JP_ROUTE_REFRESH_MS: z.coerce.number().int().min(500).default(5000),
  JP_ROUTER_METRICS: booleanish.optional(),
});

export interface RouterConfig {
  nodeEnv: string;
  isProduction: boolean;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  sqlitePath: string;
  masterKey: Buffer;
  host: string;
  sessionPort: number;
  poolPort: number;
  tls: { cert: Buffer; key: Buffer } | null;
  domainSuffix: string | null;
  backendHost: string;
  pool: {
    size: number;
    idleTimeoutMs: number;
    connectTimeoutMs: number;
    resetQuery: string;
    clientIdleTimeoutMs: number;
  };
  routeRefreshMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid router configuration:\n${issues}`);
  }

  const c = parsed.data;

  let tls: RouterConfig["tls"] = null;
  if (c.JP_ROUTER_TLS_CERT && c.JP_ROUTER_TLS_KEY) {
    if (!existsSync(c.JP_ROUTER_TLS_CERT) || !existsSync(c.JP_ROUTER_TLS_KEY)) {
      throw new Error(
        `TLS was configured but a file is missing: ${c.JP_ROUTER_TLS_CERT}, ${c.JP_ROUTER_TLS_KEY}`,
      );
    }
    tls = {
      cert: readFileSync(c.JP_ROUTER_TLS_CERT),
      key: readFileSync(c.JP_ROUTER_TLS_KEY),
    };
  } else if (c.JP_ROUTER_TLS_CERT || c.JP_ROUTER_TLS_KEY) {
    throw new Error("JP_ROUTER_TLS_CERT and JP_ROUTER_TLS_KEY must be set together.");
  }

  const dataDir = resolve(c.JP_DATA_DIR);

  return {
    nodeEnv: c.NODE_ENV,
    isProduction: c.NODE_ENV === "production",
    logLevel: c.JP_LOG_LEVEL,
    sqlitePath: resolve(dataDir, "justpostgres.sqlite"),
    masterKey: parseMasterKey(c.JP_MASTER_KEY),
    host: c.JP_ROUTER_HOST,
    sessionPort: c.JP_ROUTER_SESSION_PORT,
    poolPort: c.JP_ROUTER_POOL_PORT,
    tls,
    domainSuffix: c.JP_ROUTER_DOMAIN_SUFFIX ?? null,
    backendHost: c.JP_ROUTER_BACKEND_HOST,
    pool: {
      size: c.JP_POOL_SIZE,
      idleTimeoutMs: c.JP_POOL_IDLE_TIMEOUT_MS,
      connectTimeoutMs: c.JP_POOL_CONNECT_TIMEOUT_MS,
      resetQuery: c.JP_POOL_RESET_QUERY,
      clientIdleTimeoutMs: c.JP_POOL_CLIENT_IDLE_TIMEOUT_MS,
    },
    routeRefreshMs: c.JP_ROUTE_REFRESH_MS,
  };
}
