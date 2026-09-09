export interface ApiStatus {
  enabled: boolean;
  running: boolean;
  schemas: string;
  maxRows: number;
  keyVersion: number;
  lastError: string | null;
  /** Path form always works; the hostname form needs wildcard DNS. */
  endpoints: { path: string; host: string | null };
  /** Only present when explicitly revealed. */
  keys?: { anon: string; service: string };
}

export interface PolicyInfo {
  schema: string;
  table: string;
  name: string;
  permissive: boolean;
  roles: string[];
  command: string;
  using: string | null;
  withCheck: string | null;
}

export interface TableSecurity {
  schema: string;
  table: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  policies: PolicyInfo[];
  /** What the `anon` role holds. Non-empty means the table is reachable. */
  anonPrivileges: string[];
  /**
   * Reachable over HTTP with nothing deciding which rows a stranger may see.
   *
   * Exposing a table through the UI enables RLS in the same transaction, so
   * this state can only arise from a manual GRANT or from RLS being switched
   * off afterwards. It is a backstop, not the primary defence.
   */
  exposedWithoutRls: boolean;
}

export interface PolicyTemplate {
  id: string;
  title: string;
  description: string;
  needsColumn: boolean;
  columnLabel: string | null;
  extraField: { id: string; label: string; placeholder: string } | null;
}

export interface ExposeTableRequest {
  schema?: string;
  table: string;
  privileges: Array<"SELECT" | "INSERT" | "UPDATE" | "DELETE">;
  template: string;
  column?: string;
  claim?: string;
  policyName?: string;
}
