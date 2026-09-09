/**
 * The data-browser API surface, shared by the control plane and the UI.
 *
 * Every cell value is a string or null: the control plane asks Postgres for the
 * text it would render rather than letting a driver coerce into JS types, so a
 * numeric beyond `Number.MAX_SAFE_INTEGER` or a timestamp's exact precision
 * survives the trip. Edits go back the same way.
 */

export type CellValue = string | null;

export const RELATION_KINDS = ["table", "partitioned", "view", "materialized", "foreign"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export interface RelationInfo {
  schema: string;
  name: string;
  kind: RelationKind;
  /** Planner estimate. Null when the relation has never been analysed. */
  estimatedRows: number | null;
  sizeBytes: number;
  comment: string | null;
}

export interface SchemaTree {
  schemas: Array<{ name: string; relations: RelationInfo[] }>;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
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

export interface RelationDetail {
  relation: RelationInfo;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  primaryKey: string[];
  editable: boolean;
  editableReason: string | null;
}

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

export const FILTER_OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: "=",
  neq: "≠",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  like: "LIKE",
  ilike: "ILIKE",
  in: "IN",
  is_null: "IS NULL",
  is_not_null: "IS NOT NULL",
};

/** These two take no value; the UI hides the input for them. */
export const VALUELESS_OPERATORS: readonly FilterOperator[] = ["is_null", "is_not_null"];

export interface Filter {
  column: string;
  operator: FilterOperator;
  value?: string;
}

export interface BrowseRequest {
  schema: string;
  table: string;
  limit?: number;
  cursor?: string;
  sort?: { column: string; direction: "asc" | "desc" };
  filters?: Filter[];
  countMode?: "estimate" | "exact";
}

export interface BrowseResult {
  columns: Array<{ name: string; type: string; isPrimaryKey: boolean; nullable: boolean }>;
  rows: Array<Record<string, CellValue>>;
  nextCursor: string | null;
  /** True when the server had to page by offset instead of a keyset. */
  usedOffset: boolean;
  offsetNote: string | null;
  total: { mode: "estimate" | "exact"; value: number } | null;
  editable: boolean;
  editableReason: string | null;
  primaryKey: string[];
}

export interface QueryField {
  name: string;
  dataTypeId: number;
}

export interface StatementResult {
  statement: string;
  command: string | null;
  fields: QueryField[];
  rows: Array<Record<string, CellValue>>;
  rowCount: number | null;
  truncated: boolean;
  durationMs: number;
}

export interface DestructiveWarning {
  statement: string;
  reason: string;
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

export interface ExplainOutcome {
  plan: unknown;
  text: string;
  durationMs: number;
}
