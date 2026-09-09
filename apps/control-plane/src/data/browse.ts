import type { PoolClient } from "pg";
import { quoteIdent, quoteQualified } from "./identifiers.js";
import { fetchRelationDetail, type ColumnInfo, type RelationDetail } from "./introspect.js";
import type { DataPoolManager } from "./pool.js";

export const FILTER_OPERATORS = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "like",
  "ilike",
  "in",
  "is_null",
  "is_not_null",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface Filter {
  column: string;
  operator: FilterOperator;
  value?: string;
}

export interface BrowseRequest {
  schema: string;
  table: string;
  limit: number;
  filters: Filter[];
  sort?: { column: string; direction: "asc" | "desc" };
  /** Opaque keyset cursor from a previous page. */
  cursor?: string;
  countMode?: "estimate" | "exact";
}

export interface BrowseResult {
  columns: Array<{ name: string; type: string; isPrimaryKey: boolean; nullable: boolean }>;
  rows: Array<Record<string, string | null>>;
  /** Cursor for the next page, or null when this is the last one. */
  nextCursor: string | null;
  /** True when the server had to fall back to OFFSET — see below. */
  usedOffset: boolean;
  offsetNote: string | null;
  total: { mode: "estimate" | "exact"; value: number } | null;
  editable: boolean;
  editableReason: string | null;
  primaryKey: string[];
}

export class BrowseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowseError";
  }
}

const SQL_OPERATORS: Record<Exclude<FilterOperator, "is_null" | "is_not_null" | "in">, string> = {
  eq: "=",
  neq: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  like: "LIKE",
  ilike: "ILIKE",
};

/** Validate a column name against what the database reports, then quote it. */
function column(detail: RelationDetail, name: string): ColumnInfo {
  const found = detail.columns.find((c) => c.name === name);
  if (!found) throw new BrowseError(`No column "${name}" on ${detail.relation.name}.`);
  return found;
}

interface Cursor {
  /** Values of the ordering columns from the last row of the previous page. */
  values: Array<string | null>;
  direction: "asc" | "desc";
  columns: string[];
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if (!Array.isArray(parsed.values) || !Array.isArray(parsed.columns)) throw new Error();
    return parsed;
  } catch {
    throw new BrowseError("Invalid pagination cursor.");
  }
}

/**
 * Read a page of a table.
 *
 * Pagination is keyset, not OFFSET: `OFFSET 500000` makes Postgres walk and
 * discard half a million rows for every page, so a table browser built on it
 * gets slower the further you scroll and eventually times out. Keyset asks for
 * "the next N rows after this key", which costs the same on page 1 and page
 * 10,000.
 *
 * It needs a stable total ordering, so the sort column is always followed by
 * the primary key as a tiebreaker. Two cases fall back to OFFSET, and the
 * result says so rather than pretending otherwise:
 *
 *  - the table has no primary key, so no unique ordering exists
 *  - the sort column is nullable, and SQL row comparison against NULL does not
 *    give the total order keyset needs
 */
export async function browseTable(
  pools: DataPoolManager,
  projectId: string,
  request: BrowseRequest,
): Promise<BrowseResult> {
  const detail = await fetchRelationDetail(pools, projectId, request.schema, request.table);
  if (!detail) throw new BrowseError(`No table ${request.schema}.${request.table}.`);

  const params: unknown[] = [];
  // Filter clauses are kept apart from the keyset clause: the count query needs
  // the filters and must not inherit the cursor comparison. Their parameters
  // occupy positions 1..filterParamCount, which is why filters are built first.
  const filterClauses: string[] = [];

  for (const filter of request.filters) {
    const col = column(detail, filter.column);
    const ident = quoteIdent(col.name);

    if (filter.operator === "is_null") {
      filterClauses.push(`${ident} IS NULL`);
      continue;
    }
    if (filter.operator === "is_not_null") {
      filterClauses.push(`${ident} IS NOT NULL`);
      continue;
    }
    if (filter.value === undefined) {
      throw new BrowseError(`Filter on "${col.name}" needs a value.`);
    }
    if (filter.operator === "in") {
      const items = filter.value.split(",").map((v) => v.trim()).filter(Boolean);
      if (items.length === 0) throw new BrowseError(`Filter on "${col.name}" needs at least one value.`);
      const placeholders = items.map((item) => {
        params.push(item);
        return `$${params.length}::text::${col.fullType}`;
      });
      filterClauses.push(`${ident} IN (${placeholders.join(", ")})`);
      continue;
    }

    params.push(filter.value);
    // Text pattern operators only make sense against text, so cast the column
    // rather than the parameter for those.
    if (filter.operator === "like" || filter.operator === "ilike") {
      filterClauses.push(`${ident}::text ${SQL_OPERATORS[filter.operator]} $${params.length}`);
    } else {
      filterClauses.push(
        `${ident} ${SQL_OPERATORS[filter.operator]} $${params.length}::text::${col.fullType}`,
      );
    }
  }

  // Everything after this point may append keyset parameters.
  const filterParamCount = params.length;
  const where = [...filterClauses];

  // --- ordering ---
  const direction = request.sort?.direction ?? "asc";
  const orderColumns: ColumnInfo[] = [];
  if (request.sort) orderColumns.push(column(detail, request.sort.column));
  for (const pk of detail.primaryKey) {
    if (!orderColumns.some((c) => c.name === pk)) orderColumns.push(column(detail, pk));
  }

  let usedOffset = false;
  let offsetNote: string | null = null;

  if (detail.primaryKey.length === 0) {
    usedOffset = true;
    offsetNote =
      "This table has no primary key, so pages are addressed by offset. Paging deep into a large table will get slower.";
  } else if (orderColumns.some((c) => c.nullable)) {
    usedOffset = true;
    offsetNote =
      "The sort column is nullable, so pages are addressed by offset. Sort by a NOT NULL column for fast deep paging.";
  }

  if (orderColumns.length === 0) {
    // No sort and no primary key: fall back to physical order so at least the
    // page boundaries are stable within one snapshot.
    orderColumns.push(detail.columns[0]!);
  }

  const orderBy = orderColumns
    .map((c) => `${quoteIdent(c.name)} ${direction === "desc" ? "DESC" : "ASC"}`)
    .join(", ");

  let offset = 0;
  if (request.cursor) {
    const cursor = decodeCursor(request.cursor);
    if (usedOffset) {
      offset = Number(cursor.values[0] ?? 0);
      if (!Number.isFinite(offset) || offset < 0) offset = 0;
    } else {
      if (cursor.columns.join(",") !== orderColumns.map((c) => c.name).join(",")) {
        throw new BrowseError("Sort order changed; start from the first page.");
      }
      const lhs = orderColumns.map((c) => quoteIdent(c.name)).join(", ");
      const rhs = orderColumns
        .map((c) => {
          params.push(cursor.values[orderColumns.indexOf(c)]);
          return `$${params.length}::text::${c.fullType}`;
        })
        .join(", ");
      where.push(`(${lhs}) ${direction === "desc" ? "<" : ">"} (${rhs})`);
    }
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.max(1, request.limit);

  const selectList = detail.columns.map((c) => quoteIdent(c.name)).join(", ");
  const sql =
    `SELECT ${selectList} FROM ${quoteQualified(request.schema, request.table)} ` +
    `${whereClause} ORDER BY ${orderBy} LIMIT ${limit + 1}` +
    (usedOffset && offset > 0 ? ` OFFSET ${offset}` : "");

  const result = await pools.withClient(projectId, async (client) => {
    await client.query(`SET statement_timeout = 15000`);
    const page = await client.query<Record<string, string | null>>(sql, params as never[]);
    const total = await countRows(client, request, detail, filterClauses, params.slice(0, filterParamCount));
    return { page, total };
  });

  // One extra row was requested purely to find out whether another page exists.
  const hasMore = result.page.rows.length > limit;
  const rows = hasMore ? result.page.rows.slice(0, limit) : result.page.rows;

  let nextCursor: string | null = null;
  if (hasMore) {
    if (usedOffset) {
      nextCursor = encodeCursor({ values: [String(offset + limit)], direction, columns: [] });
    } else {
      const last = rows[rows.length - 1]!;
      nextCursor = encodeCursor({
        values: orderColumns.map((c) => last[c.name] ?? null),
        direction,
        columns: orderColumns.map((c) => c.name),
      });
    }
  }

  return {
    columns: detail.columns.map((c) => ({
      name: c.name,
      type: c.fullType,
      isPrimaryKey: c.isPrimaryKey,
      nullable: c.nullable,
    })),
    rows,
    nextCursor,
    usedOffset,
    offsetNote,
    total: result.total,
    editable: detail.editable,
    editableReason: detail.editableReason,
    primaryKey: detail.primaryKey,
  };
}

/**
 * Row count.
 *
 * An estimate by default. `SELECT count(*)` on a large table is a full scan,
 * and doing one on every page load is how a browser turns into a load problem.
 * The exact count is available on request, for when the answer matters more
 * than the wait.
 */
async function countRows(
  client: PoolClient,
  request: BrowseRequest,
  detail: RelationDetail,
  filterClauses: string[],
  filterParams: unknown[],
): Promise<BrowseResult["total"]> {
  if (request.countMode === "exact") {
    const clause = filterClauses.length > 0 ? `WHERE ${filterClauses.join(" AND ")}` : "";
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM ${quoteQualified(request.schema, request.table)} ${clause}`,
      filterParams as never[],
    );
    return { mode: "exact", value: Number(result.rows[0]?.count ?? 0) };
  }

  // A planner estimate describes the whole table, so it says nothing useful
  // about a filtered view. Better to show no number than a wrong one. Same for
  // a relation that has never been analysed, where there is no estimate at all.
  if (filterClauses.length > 0) return null;
  if (detail.relation.estimatedRows === null) return null;
  return { mode: "estimate", value: detail.relation.estimatedRows };
}
