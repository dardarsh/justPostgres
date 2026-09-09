import type { DataPoolManager } from "./pool.js";

export interface ColumnInfo {
  name: string;
  dataType: string;
  /** Formatted type as Postgres renders it, e.g. `character varying(255)`. */
  fullType: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isIdentity: boolean;
  position: number;
  comment: string | null;
}

export interface IndexInfo {
  name: string;
  definition: string;
  isUnique: boolean;
  isPrimary: boolean;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
}

export interface RelationInfo {
  schema: string;
  name: string;
  /** r = table, p = partitioned table, v = view, m = materialised view, f = foreign table */
  kind: "table" | "partitioned" | "view" | "materialized" | "foreign";
  /**
   * Planner estimate, not a count — counting every table on page load is not
   * free. Null when the relation has never been analysed, which is different
   * from an estimate of zero.
   */
  estimatedRows: number | null;
  sizeBytes: number;
  comment: string | null;
}

export interface SchemaTree {
  schemas: Array<{ name: string; relations: RelationInfo[] }>;
}

export interface RelationDetail {
  relation: RelationInfo;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  primaryKey: string[];
  /** Editing needs a primary key to address a row unambiguously. */
  editable: boolean;
  editableReason: string | null;
}

/**
 * Coerce a Postgres boolean that may arrive either parsed or as text.
 *
 * The data pool deliberately returns every value as the text Postgres would
 * render, so a boolean comes back as the string "f" — which is truthy in
 * JavaScript. Reading `if (row.is_primary_key)` against that quietly marks
 * every column a primary key, which then makes a table with no primary key
 * look editable. Every boolean out of these queries goes through here.
 */
function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "t" || value === "true";
  return false;
}

/**
 * `reltuples` is -1 on a relation that has never been analysed, and 0 is a
 * legitimate value, so the two have to stay distinguishable. Reporting "0 rows"
 * for a freshly loaded table is worse than reporting nothing.
 */
function toEstimate(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * A text-array column arrives as Postgres's own literal, `{a,b}`, rather than a
 * JS array — same cause as toBool. Column names cannot contain a comma or a
 * quote without being quoted in that literal, and these come from the catalog,
 * so a simple split is sufficient here.
 */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  const inner = value.replace(/^\{/, "").replace(/\}$/, "");
  if (inner.length === 0) return [];
  return inner.split(",").map((part) => part.replace(/^"|"$/g, "").replace(/\\"/g, '"'));
}

const KIND_BY_RELKIND: Record<string, RelationInfo["kind"]> = {
  r: "table",
  p: "partitioned",
  v: "view",
  m: "materialized",
  f: "foreign",
};

/**
 * The schema tree.
 *
 * One query rather than one per schema, because a database with a few hundred
 * tables would otherwise make the sidebar feel broken. Sizes and row counts are
 * planner estimates from `pg_class`; an exact count means scanning every table,
 * which is not something a page load should do.
 */
export async function fetchSchemaTree(
  pools: DataPoolManager,
  projectId: string,
): Promise<SchemaTree> {
  const { rows } = await pools.query<{
    schema: string;
    name: string;
    relkind: string;
    estimated_rows: string;
    size_bytes: string;
    comment: string | null;
  }>(
    projectId,
    `SELECT n.nspname                              AS schema,
            c.relname                              AS name,
            c.relkind::text                        AS relkind,
            c.reltuples::bigint                    AS estimated_rows,
            pg_total_relation_size(c.oid)          AS size_bytes,
            obj_description(c.oid, 'pg_class')     AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p','v','m','f')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp%'
      ORDER BY n.nspname, c.relname`,
  );

  const bySchema = new Map<string, RelationInfo[]>();
  for (const row of rows) {
    const list = bySchema.get(row.schema) ?? [];
    list.push({
      schema: row.schema,
      name: row.name,
      kind: KIND_BY_RELKIND[row.relkind] ?? "table",
      estimatedRows: toEstimate(row.estimated_rows),
      sizeBytes: Number(row.size_bytes),
      comment: row.comment,
    });
    bySchema.set(row.schema, list);
  }

  return {
    schemas: [...bySchema.entries()]
      .map(([name, relations]) => ({ name, relations }))
      .sort((a, b) => (a.name === "public" ? -1 : b.name === "public" ? 1 : a.name.localeCompare(b.name))),
  };
}

export async function fetchRelationDetail(
  pools: DataPoolManager,
  projectId: string,
  schema: string,
  name: string,
): Promise<RelationDetail | null> {
  return pools.withClient(projectId, async (client) => {
    await client.query(`SET statement_timeout = 15000`);

    const relation = await client.query<{
      schema: string;
      name: string;
      relkind: string;
      estimated_rows: string;
      size_bytes: string;
      comment: string | null;
    }>(
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
              c.reltuples::bigint AS estimated_rows,
              pg_total_relation_size(c.oid) AS size_bytes,
              obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p','v','m','f')`,
      [schema, name],
    );
    if (relation.rowCount === 0) return null;
    const rel = relation.rows[0]!;

    const columns = await client.query<{
      name: string;
      data_type: string;
      full_type: string;
      nullable: unknown;
      default_value: string | null;
      is_primary_key: unknown;
      is_identity: unknown;
      position: unknown;
      comment: string | null;
    }>(
      `SELECT a.attname                                            AS name,
              t.typname                                            AS data_type,
              format_type(a.atttypid, a.atttypmod)                 AS full_type,
              NOT a.attnotnull                                     AS nullable,
              pg_get_expr(d.adbin, d.adrelid)                      AS default_value,
              COALESCE(pk.is_pk, false)                            AS is_primary_key,
              a.attidentity <> ''                                  AS is_identity,
              a.attnum                                             AS position,
              col_description(a.attrelid, a.attnum)                AS comment
         FROM pg_attribute a
         JOIN pg_class c      ON c.oid = a.attrelid
         JOIN pg_namespace n  ON n.oid = c.relnamespace
         JOIN pg_type t       ON t.oid = a.atttypid
    LEFT JOIN pg_attrdef d    ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    LEFT JOIN LATERAL (
              SELECT true AS is_pk
                FROM pg_index i
               WHERE i.indrelid = a.attrelid AND i.indisprimary
                 AND a.attnum = ANY(i.indkey)
             ) pk ON true
        WHERE n.nspname = $1 AND c.relname = $2
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [schema, name],
    );

    const indexes = await client.query<{
      name: string;
      definition: string;
      is_unique: unknown;
      is_primary: unknown;
    }>(
      `SELECT ic.relname AS name, pg_get_indexdef(i.indexrelid) AS definition,
              i.indisunique AS is_unique, i.indisprimary AS is_primary
         FROM pg_index i
         JOIN pg_class ic     ON ic.oid = i.indexrelid
         JOIN pg_class c      ON c.oid = i.indrelid
         JOIN pg_namespace n  ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
        ORDER BY i.indisprimary DESC, ic.relname`,
      [schema, name],
    );

    const foreignKeys = await client.query<{
      name: string;
      columns: unknown;
      referenced_schema: string;
      referenced_table: string;
      referenced_columns: unknown;
    }>(
      `SELECT con.conname AS name,
              ARRAY(SELECT att.attname FROM unnest(con.conkey) k
                      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k) AS columns,
              fn.nspname AS referenced_schema,
              fc.relname AS referenced_table,
              ARRAY(SELECT att.attname FROM unnest(con.confkey) k
                      JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = k) AS referenced_columns
         FROM pg_constraint con
         JOIN pg_class c      ON c.oid = con.conrelid
         JOIN pg_namespace n  ON n.oid = c.relnamespace
         JOIN pg_class fc     ON fc.oid = con.confrelid
         JOIN pg_namespace fn ON fn.oid = fc.relnamespace
        WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2
        ORDER BY con.conname`,
      [schema, name],
    );

    const cols: ColumnInfo[] = columns.rows.map((r) => ({
      name: r.name,
      dataType: r.data_type,
      fullType: r.full_type,
      nullable: toBool(r.nullable),
      defaultValue: r.default_value,
      isPrimaryKey: toBool(r.is_primary_key),
      isIdentity: toBool(r.is_identity),
      position: Number(r.position),
      comment: r.comment,
    }));

    const primaryKey = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
    const kind = KIND_BY_RELKIND[rel.relkind] ?? "table";

    // Editing a row means addressing exactly one row. Without a primary key
    // there is no safe way to do that — some tools use ctid, which silently
    // targets the wrong row after a concurrent update. Refusing is the honest
    // option.
    let editableReason: string | null = null;
    if (kind === "view" || kind === "materialized") {
      editableReason = "Views cannot be edited directly.";
    } else if (kind === "foreign") {
      editableReason = "Foreign tables cannot be edited here.";
    } else if (primaryKey.length === 0) {
      editableReason = "This table has no primary key, so a row cannot be addressed unambiguously.";
    }

    return {
      relation: {
        schema: rel.schema,
        name: rel.name,
        kind,
        estimatedRows: toEstimate(rel.estimated_rows),
        sizeBytes: Number(rel.size_bytes),
        comment: rel.comment,
      },
      columns: cols,
      indexes: indexes.rows.map((r) => ({
        name: r.name,
        definition: r.definition,
        isUnique: toBool(r.is_unique),
        isPrimary: toBool(r.is_primary),
      })),
      foreignKeys: foreignKeys.rows.map((r) => ({
        name: r.name,
        columns: toStringArray(r.columns),
        referencedSchema: r.referenced_schema,
        referencedTable: r.referenced_table,
        referencedColumns: toStringArray(r.referenced_columns),
      })),
      primaryKey,
      editable: editableReason === null,
      editableReason,
    };
  });
}
