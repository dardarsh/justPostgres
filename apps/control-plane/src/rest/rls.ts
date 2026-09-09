import { quoteIdent, quoteQualified, quoteLiteral } from "../data/identifiers.js";
import type { DataPoolManager } from "../data/pool.js";
import { ProjectError } from "../projects/service.js";
import { ANON_ROLE } from "./jwt.js";

export const POLICY_COMMANDS = ["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"] as const;
export type PolicyCommand = (typeof POLICY_COMMANDS)[number];

export interface PolicyInfo {
  schema: string;
  table: string;
  name: string;
  permissive: boolean;
  roles: string[];
  command: string;
  /** The `USING` expression, which decides which existing rows are visible. */
  using: string | null;
  /** The `WITH CHECK` expression, which decides which new rows may be written. */
  withCheck: string | null;
}

export interface TableSecurity {
  schema: string;
  table: string;
  rlsEnabled: boolean;
  /** True when even the table owner is subject to the policies. */
  rlsForced: boolean;
  policies: PolicyInfo[];
  /** Privileges the `anon` role holds, which is what makes a table reachable. */
  anonPrivileges: string[];
  /**
   * The dangerous combination: reachable over HTTP with nothing deciding which
   * rows a stranger may see.
   */
  exposedWithoutRls: boolean;
}

export const POLICY_TEMPLATES = [
  {
    id: "owner_only",
    title: "Only the row's owner",
    description:
      "Each row belongs to one user, matched against the `sub` claim of their token. The most common shape by a wide margin.",
    needsColumn: true,
    columnLabel: "Owner column",
    build: (column: string) => ({
      using: `${quoteIdent(column)}::text = auth.uid()`,
      withCheck: `${quoteIdent(column)}::text = auth.uid()`,
    }),
  },
  {
    id: "tenant",
    title: "Same tenant only",
    description:
      "Rows are visible to anyone whose token carries a matching tenant claim. For B2B applications where the unit of isolation is an organisation.",
    needsColumn: true,
    columnLabel: "Tenant column",
    extraField: { id: "claim", label: "Claim name", placeholder: "tenant_id" },
    build: (column: string, claim = "tenant_id") => ({
      using: `${quoteIdent(column)}::text = auth.claim(${quoteLiteral(claim)})`,
      withCheck: `${quoteIdent(column)}::text = auth.claim(${quoteLiteral(claim)})`,
    }),
  },
  {
    id: "public_read",
    title: "Anyone can read",
    description:
      "Every row is readable by anyone with the anon key. Writes are not granted. For genuinely public data — a product catalogue, published posts.",
    needsColumn: false,
    build: () => ({ using: "true", withCheck: null }),
  },
  {
    id: "authenticated_read",
    title: "Any signed-in user can read",
    description: "Readable by anyone presenting a valid token that is not the anon key.",
    needsColumn: false,
    build: () => ({ using: `auth.role() <> ${quoteLiteral(ANON_ROLE)}`, withCheck: null }),
  },
] as const;

export type PolicyTemplateId = (typeof POLICY_TEMPLATES)[number]["id"];

export interface ExposeRequest {
  schema: string;
  table: string;
  /** Verbs to grant to `anon`. */
  privileges: Array<"SELECT" | "INSERT" | "UPDATE" | "DELETE">;
  template: PolicyTemplateId;
  column?: string;
  claim?: string;
  policyName?: string;
}

/**
 * Row-level security, and the operation that makes a table reachable.
 *
 * The important design decision lives in `expose`: granting privileges to
 * `anon` and enabling RLS happen in one transaction, so a table cannot end up
 * reachable-but-unprotected by anyone forgetting the second step. That state is
 * the single most common way people publish a database by accident, and the
 * cheapest fix is to make it unreachable by construction rather than to warn
 * about it afterwards.
 *
 * The warning still exists, because the state is reachable another way: someone
 * can grant privileges by hand in the SQL editor, or disable RLS on an already
 * exposed table. It is a backstop, not the primary defence.
 */
export class RlsService {
  constructor(private readonly pools: DataPoolManager) {}

  async securityFor(projectId: string, schema = "public"): Promise<TableSecurity[]> {
    const { rows } = await this.pools.query<{
      schema: string;
      table: string;
      rls_enabled: unknown;
      rls_forced: unknown;
      anon_privileges: string | null;
    }>(
      projectId,
      `SELECT n.nspname                     AS schema,
              c.relname                     AS table,
              c.relrowsecurity              AS rls_enabled,
              c.relforcerowsecurity         AS rls_forced,
              (
                SELECT string_agg(DISTINCT p.privilege_type, ',')
                  FROM information_schema.table_privileges p
                 WHERE p.table_schema = n.nspname
                   AND p.table_name = c.relname
                   AND p.grantee = $2
              )                             AS anon_privileges
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p') AND n.nspname = $1
        ORDER BY c.relname`,
      [schema, ANON_ROLE],
    );

    const policies = await this.listPolicies(projectId, schema);

    return rows.map((row) => {
      const rlsEnabled = row.rls_enabled === true || row.rls_enabled === "t";
      const anonPrivileges = (row.anon_privileges ?? "").split(",").filter(Boolean);
      return {
        schema: row.schema,
        table: row.table,
        rlsEnabled,
        rlsForced: row.rls_forced === true || row.rls_forced === "t",
        policies: policies.filter((p) => p.table === row.table),
        anonPrivileges,
        exposedWithoutRls: anonPrivileges.length > 0 && !rlsEnabled,
      };
    });
  }

  async listPolicies(projectId: string, schema = "public"): Promise<PolicyInfo[]> {
    const { rows } = await this.pools.query<{
      schemaname: string;
      tablename: string;
      policyname: string;
      permissive: string;
      roles: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      projectId,
      `SELECT schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check
         FROM pg_policies WHERE schemaname = $1 ORDER BY tablename, policyname`,
      [schema],
    );

    return rows.map((row) => ({
      schema: row.schemaname,
      table: row.tablename,
      name: row.policyname,
      permissive: row.permissive === "PERMISSIVE",
      roles: row.roles.replace(/^\{|\}$/g, "").split(",").filter(Boolean),
      command: row.cmd,
      using: row.qual,
      withCheck: row.with_check,
    }));
  }

  async setRlsEnabled(projectId: string, schema: string, table: string, enabled: boolean): Promise<void> {
    await this.pools.query(
      projectId,
      `ALTER TABLE ${quoteQualified(schema, table)} ${enabled ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY`,
    );
  }

  /**
   * Make a table reachable over the API, safely, in one step.
   *
   * Grant, enable RLS and create the policy in a single transaction. Either the
   * table becomes reachable *with* a rule deciding who sees what, or nothing
   * changes at all.
   */
  async expose(projectId: string, request: ExposeRequest): Promise<void> {
    const template = POLICY_TEMPLATES.find((t) => t.id === request.template);
    if (!template) throw new ProjectError("invalid_request", `Unknown policy template.`);
    if (template.needsColumn && !request.column) {
      throw new ProjectError("invalid_request", `This policy needs a column to match against.`);
    }
    if (request.privileges.length === 0) {
      throw new ProjectError("invalid_request", "Choose at least one privilege to grant.");
    }

    await this.assertTableExists(projectId, request.schema, request.table);
    if (request.column) {
      await this.assertColumnExists(projectId, request.schema, request.table, request.column);
    }

    const built = template.needsColumn
      ? (template.build as (c: string, claim?: string) => { using: string; withCheck: string | null })(
          request.column!,
          request.claim,
        )
      : (template.build as () => { using: string; withCheck: string | null })();

    const policyName = request.policyName?.trim() || `${request.table}_${template.id}`;
    const qualified = quoteQualified(request.schema, request.table);

    await this.pools.withClient(projectId, async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`);
        await client.query(
          `GRANT ${request.privileges.join(", ")} ON ${qualified} TO ${quoteIdent(ANON_ROLE)}`,
        );
        await client.query(`DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${qualified}`);

        const withCheck = built.withCheck ? ` WITH CHECK (${built.withCheck})` : "";
        await client.query(
          `CREATE POLICY ${quoteIdent(policyName)} ON ${qualified} ` +
            `FOR ALL TO ${quoteIdent(ANON_ROLE)} USING (${built.using})${withCheck}`,
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }

  /** Take a table back off the API. Data is untouched; only access changes. */
  async unexpose(projectId: string, schema: string, table: string): Promise<void> {
    await this.pools.query(
      projectId,
      `REVOKE ALL ON ${quoteQualified(schema, table)} FROM ${quoteIdent(ANON_ROLE)}`,
    );
  }

  async createRawPolicy(
    projectId: string,
    input: {
      schema: string;
      table: string;
      name: string;
      command: PolicyCommand;
      roles: string[];
      using?: string;
      withCheck?: string;
    },
  ): Promise<void> {
    await this.assertTableExists(projectId, input.schema, input.table);
    const qualified = quoteQualified(input.schema, input.table);
    const roles = input.roles.length > 0 ? input.roles.map(quoteIdent).join(", ") : "PUBLIC";

    // The expressions are raw SQL by design — this is the escape hatch for
    // policies the guided builders cannot express. The user already holds
    // superuser on this database through the SQL editor, so refusing here would
    // restrict nothing and only make the product less useful.
    const clauses = [
      `CREATE POLICY ${quoteIdent(input.name)} ON ${qualified}`,
      `FOR ${input.command} TO ${roles}`,
      input.using ? `USING (${input.using})` : "",
      input.withCheck ? `WITH CHECK (${input.withCheck})` : "",
    ].filter(Boolean);

    await this.pools.query(projectId, clauses.join(" "));
  }

  async dropPolicy(projectId: string, schema: string, table: string, name: string): Promise<void> {
    await this.pools.query(
      projectId,
      `DROP POLICY IF EXISTS ${quoteIdent(name)} ON ${quoteQualified(schema, table)}`,
    );
  }

  private async assertTableExists(projectId: string, schema: string, table: string): Promise<void> {
    const { rows } = await this.pools.query(
      projectId,
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p')`,
      [schema, table],
    );
    if (rows.length === 0) {
      throw new ProjectError("not_found", `No table ${schema}.${table}.`);
    }
  }

  private async assertColumnExists(
    projectId: string,
    schema: string,
    table: string,
    column: string,
  ): Promise<void> {
    const { rows } = await this.pools.query(
      projectId,
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      [schema, table, column],
    );
    if (rows.length === 0) {
      throw new ProjectError("invalid_request", `No column "${column}" on ${schema}.${table}.`);
    }
  }
}
