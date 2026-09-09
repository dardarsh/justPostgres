import type { QueryResult } from "pg";
import type { Config } from "../config.js";
import type { DataPoolManager } from "./pool.js";
import { findDestructiveStatements, splitStatements, type DestructiveWarning } from "./sql-text.js";

export interface QueryField {
  name: string;
  dataTypeId: number;
}

export interface StatementResult {
  statement: string;
  command: string | null;
  fields: QueryField[];
  rows: Array<Record<string, string | null>>;
  rowCount: number | null;
  /** True when the result was cut to the row cap; `rowCount` is the real total. */
  truncated: boolean;
  durationMs: number;
}

export interface QueryOutcome {
  results: StatementResult[];
  totalDurationMs: number;
  /** Present when the script needs confirmation and none was given. */
  requiresConfirmation?: DestructiveWarning[];
  error?: {
    message: string;
    detail?: string;
    hint?: string;
    position?: number;
    statement?: string;
  };
}

export interface RunQueryOptions {
  sql: string;
  /** Set once the user has acknowledged the destructive-statement warning. */
  confirmed?: boolean;
  timeoutMs?: number;
  maxRows?: number;
}

/**
 * Run a SQL script against a project.
 *
 * Statements are executed one at a time on a single connection rather than
 * handed to Postgres as one multi-statement string. That costs a round trip
 * each, and buys the two things the UI needs: per-statement timing, and an
 * error that names the statement that failed instead of an offset into a blob.
 *
 * Deliberately not wrapped in a transaction. A script may legitimately contain
 * `CREATE INDEX CONCURRENTLY` or `VACUUM`, which cannot run inside one, and
 * silently opening a transaction around someone's script changes its meaning.
 */
export async function runQuery(
  pools: DataPoolManager,
  config: Config,
  projectId: string,
  options: RunQueryOptions,
): Promise<QueryOutcome> {
  const statements = splitStatements(options.sql);
  if (statements.length === 0) {
    return { results: [], totalDurationMs: 0 };
  }

  if (!options.confirmed) {
    const warnings = findDestructiveStatements(options.sql);
    if (warnings.length > 0) {
      return { results: [], totalDurationMs: 0, requiresConfirmation: warnings };
    }
  }

  const maxRows = Math.min(options.maxRows ?? config.data.maxRows, config.data.maxRows);
  const timeoutMs = options.timeoutMs ?? config.data.statementTimeoutMs;

  return pools.withClient(projectId, async (client) => {
    await client.query(`SET statement_timeout = ${Number(timeoutMs)}`);

    const results: StatementResult[] = [];
    const startedAll = Date.now();

    for (const statement of statements) {
      const started = Date.now();
      try {
        const result = (await client.query(statement.text)) as QueryResult<
          Record<string, string | null>
        >;
        results.push(toStatementResult(statement.text, result, maxRows, Date.now() - started));
      } catch (err) {
        // Return what already succeeded alongside the failure. Losing the
        // output of the first four statements because the fifth had a typo is
        // needlessly hostile.
        return {
          results,
          totalDurationMs: Date.now() - startedAll,
          error: toQueryError(err, statement.text),
        };
      }
    }

    return { results, totalDurationMs: Date.now() - startedAll };
  });
}

function toStatementResult(
  statement: string,
  result: QueryResult<Record<string, string | null>>,
  maxRows: number,
  durationMs: number,
): StatementResult {
  const truncated = result.rows.length > maxRows;
  return {
    statement,
    command: result.command ?? null,
    fields: (result.fields ?? []).map((f) => ({ name: f.name, dataTypeId: f.dataTypeID })),
    rows: truncated ? result.rows.slice(0, maxRows) : result.rows,
    rowCount: result.rowCount,
    truncated,
    durationMs,
  };
}

interface PgError {
  message?: string;
  detail?: string;
  hint?: string;
  position?: string;
}

function toQueryError(err: unknown, statement: string): NonNullable<QueryOutcome["error"]> {
  const pgErr = err as PgError;
  return {
    message: pgErr.message ?? String(err),
    ...(pgErr.detail ? { detail: pgErr.detail } : {}),
    ...(pgErr.hint ? { hint: pgErr.hint } : {}),
    ...(pgErr.position ? { position: Number(pgErr.position) } : {}),
    statement,
  };
}

export interface ExplainOutcome {
  plan: unknown;
  /** The plan as Postgres renders it in text form, for reading rather than parsing. */
  text: string;
  durationMs: number;
}

/**
 * EXPLAIN, optionally ANALYZE.
 *
 * ANALYZE actually runs the statement, so a destructive one is wrapped in a
 * transaction that is always rolled back. Without that, "let me just check the
 * plan" on a `DELETE` would delete the rows.
 */
export async function explainQuery(
  pools: DataPoolManager,
  config: Config,
  projectId: string,
  sql: string,
  opts: { analyze?: boolean; timeoutMs?: number } = {},
): Promise<ExplainOutcome> {
  const statements = splitStatements(sql);
  if (statements.length !== 1) {
    throw new Error("EXPLAIN needs exactly one statement.");
  }
  const statement = statements[0]!.text;
  const analyze = opts.analyze ?? false;

  return pools.withClient(projectId, async (client) => {
    await client.query(`SET statement_timeout = ${Number(opts.timeoutMs ?? config.data.statementTimeoutMs)}`);

    const started = Date.now();
    const options = analyze ? "ANALYZE, BUFFERS, VERBOSE" : "VERBOSE";

    const run = async () => {
      const json = await client.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (${options}, FORMAT JSON) ${statement}`,
      );
      const text = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (${options}) ${statement}`,
      );
      return {
        plan: json.rows[0]?.["QUERY PLAN"] ?? null,
        text: text.rows.map((r) => r["QUERY PLAN"]).join("\n"),
      };
    };

    if (!analyze) {
      const out = await run();
      return { ...out, durationMs: Date.now() - started };
    }

    // ANALYZE executes the statement for real. Roll it back unconditionally.
    await client.query("BEGIN");
    try {
      const out = await run();
      return { ...out, durationMs: Date.now() - started };
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
  });
}
