/**
 * Just enough SQL lexing to split a script into statements and to spot a
 * destructive one.
 *
 * Not a parser, and not trying to be. It tracks the four things that make a
 * naive `split(";")` wrong — single quotes, double-quoted identifiers,
 * dollar-quoted bodies, and comments — because a function body containing a
 * semicolon is completely ordinary and splitting through it produces garbage.
 */

export interface Statement {
  text: string;
  /** Offset in the original script, for error reporting. */
  start: number;
}

export function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  let start = 0;
  let i = 0;

  const push = (end: number) => {
    const text = sql.slice(start, end).trim();
    if (text.length > 0) statements.push({ text, start });
    start = end + 1;
  };

  while (i < sql.length) {
    const ch = sql[i]!;

    if (ch === "'" || ch === '"') {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "$") {
      const dollar = matchDollarTag(sql, i);
      if (dollar) {
        i = skipDollarQuoted(sql, i, dollar);
        continue;
      }
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i);
      i = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i = skipBlockComment(sql, i);
      continue;
    }
    if (ch === ";") {
      push(i);
      i++;
      continue;
    }
    i++;
  }

  push(sql.length);
  return statements;
}

function skipQuoted(sql: string, from: number, quote: string): number {
  let i = from + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      // A doubled quote is an escaped one, not the end of the literal.
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    // Postgres honours backslash escapes only in E'' strings; in a standard
    // string a backslash is a literal character. Treating it as an escape here
    // would end the string in the wrong place.
    i++;
  }
  return i;
}

// Dollar-quote tags follow identifier rules. Restricted to ASCII on purpose:
// a non-ASCII tag is legal but vanishingly rare, and the cost of missing one
// is a mis-split script rather than anything unsafe.
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

function matchDollarTag(sql: string, from: number): string | null {
  const match = DOLLAR_TAG.exec(sql.slice(from, from + 130));
  return match ? match[0] : null;
}

function skipDollarQuoted(sql: string, from: number, tag: string): number {
  const end = sql.indexOf(tag, from + tag.length);
  return end === -1 ? sql.length : end + tag.length;
}

/** Postgres block comments nest, unlike C's. */
function skipBlockComment(sql: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < sql.length) {
    if (sql[i] === "/" && sql[i + 1] === "*") {
      depth++;
      i += 2;
      continue;
    }
    if (sql[i] === "*" && sql[i + 1] === "/") {
      depth--;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return i;
}

/** Blank out comments and literals so keyword matching sees only structure. */
export function stripNoise(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      out += " ";
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "$") {
      const tag = matchDollarTag(sql, i);
      if (tag) {
        out += " ";
        i = skipDollarQuoted(sql, i, tag);
        continue;
      }
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i);
      out += " ";
      i = newline === -1 ? sql.length : newline;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      out += " ";
      i = skipBlockComment(sql, i);
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export interface DestructiveWarning {
  statement: string;
  reason: string;
}

const DROP_TARGETS =
  /^drop\s+(table|schema|database|index|view|materialized|function|type|extension|sequence|trigger|role)\b/;

/**
 * Flag statements that will change or destroy more than the author probably
 * meant.
 *
 * A heuristic, and treated as one: it gates a confirmation, never a refusal.
 * Users hold superuser on their own database and are entitled to run
 * `DELETE FROM t` — the point is only that they should have to mean it.
 */
export function findDestructiveStatements(sql: string): DestructiveWarning[] {
  const warnings: DestructiveWarning[] = [];

  for (const statement of splitStatements(sql)) {
    const bare = stripNoise(statement.text).replace(/\s+/g, " ").trim();
    const lower = bare.toLowerCase();

    if (/^(update|delete)\b/.test(lower) && !/\bwhere\b/.test(lower)) {
      warnings.push({
        statement: statement.text,
        reason: `${lower.startsWith("update") ? "UPDATE" : "DELETE"} with no WHERE clause affects every row in the table.`,
      });
      continue;
    }
    if (/^truncate\b/.test(lower)) {
      warnings.push({
        statement: statement.text,
        reason: "TRUNCATE removes every row in the table.",
      });
      continue;
    }
    if (DROP_TARGETS.test(lower)) {
      warnings.push({
        statement: statement.text,
        reason: "DROP permanently removes a database object.",
      });
    }
  }

  return warnings;
}

/** Does this statement return rows worth rendering as a grid? */
export function isReadOnly(sql: string): boolean {
  const first = stripNoise(sql).trim().toLowerCase();
  return /^(select|with|show|explain|table|values)\b/.test(first);
}
