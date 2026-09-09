/**
 * Identifier quoting.
 *
 * Table and column names arrive from the client as strings and end up spliced
 * into SQL — values can be parameterised, identifiers cannot. Every identifier
 * that reaches a query goes through here, and every one is checked against what
 * the database actually reports rather than trusted because it looked fine.
 */

export class UnsafeIdentifierError extends Error {
  constructor(value: string) {
    super(`Refusing to use ${JSON.stringify(value)} as an identifier.`);
    this.name = "UnsafeIdentifierError";
  }
}

/**
 * Quote an identifier the way Postgres does: wrap in double quotes and double
 * any embedded ones. This is correct on its own, but it is the second line of
 * defence — callers validate names against introspection first.
 */
export function quoteIdent(value: string): string {
  if (value.length === 0 || value.length > 128 || value.includes("\0")) {
    throw new UnsafeIdentifierError(value);
  }
  return `"${value.replace(/"/g, '""')}"`;
}

export function quoteQualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/** Quote a string literal, for the rare place a parameter cannot be used. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
