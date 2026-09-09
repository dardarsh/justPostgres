import { quoteIdent, quoteQualified } from "./identifiers.js";
import { fetchRelationDetail, type RelationDetail } from "./introspect.js";
import type { DataPoolManager } from "./pool.js";

export class MutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationError";
  }
}

export interface RowKey {
  [column: string]: string | null;
}

/**
 * Every mutation addresses exactly one row by its full primary key.
 *
 * No `ctid`, and no partial keys. Some tools address rows by `ctid` so that
 * tables without a primary key stay editable, which works until a concurrent
 * update moves the row and the edit silently lands on a different one. Refusing
 * to edit is a worse feature and a better guarantee.
 */
async function requireEditable(
  pools: DataPoolManager,
  projectId: string,
  schema: string,
  table: string,
): Promise<RelationDetail> {
  const detail = await fetchRelationDetail(pools, projectId, schema, table);
  if (!detail) throw new MutationError(`No table ${schema}.${table}.`);
  if (!detail.editable) {
    throw new MutationError(detail.editableReason ?? "This relation cannot be edited.");
  }
  return detail;
}

function assertColumns(detail: RelationDetail, names: string[]): void {
  for (const name of names) {
    if (!detail.columns.some((c) => c.name === name)) {
      throw new MutationError(`No column "${name}" on ${detail.relation.name}.`);
    }
  }
}

function keyPredicate(
  detail: RelationDetail,
  key: RowKey,
  params: unknown[],
): string {
  const missing = detail.primaryKey.filter((c) => !(c in key));
  if (missing.length > 0) {
    throw new MutationError(`Row key is missing primary key column(s): ${missing.join(", ")}.`);
  }

  return detail.primaryKey
    .map((name) => {
      const column = detail.columns.find((c) => c.name === name)!;
      const value = key[name];
      if (value === null) {
        // A primary key column is NOT NULL by definition, so a null here means
        // the client sent something wrong rather than a row that exists.
        throw new MutationError(`Primary key column "${name}" cannot be null.`);
      }
      params.push(value);
      return `${quoteIdent(name)} = $${params.length}::text::${column.fullType}`;
    })
    .join(" AND ");
}

export async function insertRow(
  pools: DataPoolManager,
  projectId: string,
  schema: string,
  table: string,
  values: Record<string, string | null>,
): Promise<Record<string, string | null>> {
  const detail = await requireEditable(pools, projectId, schema, table);
  const names = Object.keys(values);
  assertColumns(detail, names);

  const params: unknown[] = [];
  const columns: string[] = [];
  const placeholders: string[] = [];

  for (const name of names) {
    const column = detail.columns.find((c) => c.name === name)!;
    columns.push(quoteIdent(name));
    if (values[name] === null) {
      placeholders.push("NULL");
    } else {
      params.push(values[name]);
      placeholders.push(`$${params.length}::text::${column.fullType}`);
    }
  }

  // An insert with no columns is legal and means "all defaults".
  const sql =
    columns.length === 0
      ? `INSERT INTO ${quoteQualified(schema, table)} DEFAULT VALUES RETURNING *`
      : `INSERT INTO ${quoteQualified(schema, table)} (${columns.join(", ")}) ` +
        `VALUES (${placeholders.join(", ")}) RETURNING *`;

  const result = await pools.query<Record<string, string | null>>(projectId, sql, params);
  return result.rows[0] ?? {};
}

export async function updateRow(
  pools: DataPoolManager,
  projectId: string,
  schema: string,
  table: string,
  key: RowKey,
  changes: Record<string, string | null>,
): Promise<Record<string, string | null>> {
  const detail = await requireEditable(pools, projectId, schema, table);
  const names = Object.keys(changes);
  if (names.length === 0) throw new MutationError("No changes supplied.");
  assertColumns(detail, names);

  const params: unknown[] = [];
  const assignments = names.map((name) => {
    const column = detail.columns.find((c) => c.name === name)!;
    if (changes[name] === null) return `${quoteIdent(name)} = NULL`;
    params.push(changes[name]);
    return `${quoteIdent(name)} = $${params.length}::text::${column.fullType}`;
  });

  const predicate = keyPredicate(detail, key, params);

  const result = await pools.query<Record<string, string | null>>(
    projectId,
    `UPDATE ${quoteQualified(schema, table)} SET ${assignments.join(", ")} WHERE ${predicate} RETURNING *`,
    params,
  );

  if (result.rowCount === 0) {
    throw new MutationError("No row matched that key. It may have been deleted or changed elsewhere.");
  }
  // The key is the full primary key, so more than one match means the schema
  // changed underneath us. Say so rather than pretending the edit was clean.
  if ((result.rowCount ?? 0) > 1) {
    throw new MutationError(`Expected to update one row, updated ${result.rowCount}.`);
  }
  return result.rows[0]!;
}

export async function deleteRow(
  pools: DataPoolManager,
  projectId: string,
  schema: string,
  table: string,
  key: RowKey,
): Promise<void> {
  const detail = await requireEditable(pools, projectId, schema, table);
  const params: unknown[] = [];
  const predicate = keyPredicate(detail, key, params);

  const result = await pools.query(
    projectId,
    `DELETE FROM ${quoteQualified(schema, table)} WHERE ${predicate}`,
    params,
  );

  if (result.rowCount === 0) {
    throw new MutationError("No row matched that key. It may already have been deleted.");
  }
}
