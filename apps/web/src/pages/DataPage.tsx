import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import {
  FILTER_OPERATOR_LABELS,
  FILTER_OPERATORS,
  VALUELESS_OPERATORS,
  type CellValue,
  type Filter,
  type FilterOperator,
} from "@justpostgres/shared";
import DataGrid, { downloadCsv, toCsv } from "../components/DataGrid.js";
import SchemaSidebar from "../components/SchemaSidebar.js";
import { Button, Modal } from "../components/ui.js";
import { api, ApiError } from "../lib/api.js";

const PAGE_SIZE = 50;

interface Selection {
  schema: string;
  table: string;
}

function FilterBar({
  columns,
  filters,
  onChange,
}: {
  columns: string[];
  filters: Filter[];
  onChange: (filters: Filter[]) => void;
}) {
  const [column, setColumn] = useState(columns[0] ?? "");
  const [operator, setOperator] = useState<FilterOperator>("eq");
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!columns.includes(column)) setColumn(columns[0] ?? "");
  }, [columns, column]);

  const needsValue = !VALUELESS_OPERATORS.includes(operator);

  const add = () => {
    if (!column) return;
    if (needsValue && value === "") return;
    onChange([...filters, { column, operator, ...(needsValue ? { value } : {}) }]);
    setValue("");
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
      {filters.map((filter, index) => (
        <span
          key={`${filter.column}-${index}`}
          className="mono flex items-center gap-1.5 rounded-md bg-surface-sunken px-2 py-1 text-xs"
        >
          {filter.column} {FILTER_OPERATOR_LABELS[filter.operator]} {filter.value ?? ""}
          <button
            onClick={() => onChange(filters.filter((_, i) => i !== index))}
            className="text-content-subtle hover:text-danger"
          >
            ×
          </button>
        </span>
      ))}

      <select
        value={column}
        onChange={(e) => setColumn(e.target.value)}
        className="rounded-md border border-border-strong bg-surface px-2 py-1 text-xs outline-none"
      >
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      <select
        value={operator}
        onChange={(e) => setOperator(e.target.value as FilterOperator)}
        className="rounded-md border border-border-strong bg-surface px-2 py-1 text-xs outline-none"
      >
        {FILTER_OPERATORS.map((op) => (
          <option key={op} value={op}>
            {FILTER_OPERATOR_LABELS[op]}
          </option>
        ))}
      </select>

      {needsValue ? (
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="value"
          className="w-40 rounded-md border border-border-strong bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
        />
      ) : null}

      <button
        onClick={add}
        className="rounded-md px-2 py-1 text-xs text-content-muted hover:text-content"
      >
        + Filter
      </button>
    </div>
  );
}

function InsertRowModal({
  projectId,
  selection,
  columns,
  onClose,
}: {
  projectId: string;
  selection: Selection;
  columns: Array<{ name: string; type: string; nullable: boolean }>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [nulls, setNulls] = useState<Record<string, boolean>>({});

  const insert = useMutation({
    mutationFn: () => {
      const payload: Record<string, CellValue> = {};
      for (const column of columns) {
        if (nulls[column.name]) payload[column.name] = null;
        else if (values[column.name] !== undefined) payload[column.name] = values[column.name]!;
      }
      return api.insertRow(projectId, selection.schema, selection.table, payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["browse"] });
      onClose();
    },
  });

  return (
    <Modal
      title={`Insert into ${selection.table}`}
      description="Columns left untouched take their default."
      onClose={onClose}
    >
      <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
        {columns.map((column) => (
          <label key={column.name} className="block">
            <span className="mb-1 flex items-baseline justify-between gap-2">
              <span className="mono text-xs font-medium">{column.name}</span>
              <span className="mono text-[10px] text-content-subtle">{column.type}</span>
            </span>
            <div className="flex items-center gap-2">
              <input
                disabled={nulls[column.name]}
                value={values[column.name] ?? ""}
                onChange={(e) => setValues({ ...values, [column.name]: e.target.value })}
                className="mono w-full rounded-md border border-border-strong bg-surface px-2 py-1.5 text-xs outline-none focus:border-accent disabled:opacity-40"
              />
              {column.nullable ? (
                <label className="flex shrink-0 items-center gap-1 text-[10px] text-content-subtle">
                  <input
                    type="checkbox"
                    checked={nulls[column.name] ?? false}
                    onChange={(e) => setNulls({ ...nulls, [column.name]: e.target.checked })}
                  />
                  NULL
                </label>
              ) : null}
            </div>
          </label>
        ))}
      </div>

      {insert.error ? (
        <p className="mt-3 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
          {insert.error instanceof ApiError ? insert.error.message : "Insert failed."}
        </p>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={insert.isPending} onClick={() => insert.mutate()}>
          {insert.isPending ? "Inserting…" : "Insert row"}
        </Button>
      </div>
    </Modal>
  );
}

export default function DataPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();

  const [selection, setSelection] = useState<Selection | null>(null);
  const [sort, setSort] = useState<{ column: string; direction: "asc" | "desc" } | undefined>();
  const [filters, setFilters] = useState<Filter[]>([]);
  const [cursors, setCursors] = useState<string[]>([]);
  const [inserting, setInserting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const cursor = cursors[cursors.length - 1];
  const page = cursors.length;

  // Changing table, sort or filters invalidates the cursor stack: a cursor
  // encodes a position in one specific ordering.
  useEffect(() => {
    setCursors([]);
  }, [selection?.schema, selection?.table, sort?.column, sort?.direction, filters]);

  const browse = useQuery({
    queryKey: ["browse", id, selection, sort, filters, cursor],
    queryFn: () =>
      api.browse(id, {
        schema: selection!.schema,
        table: selection!.table,
        limit: PAGE_SIZE,
        ...(sort ? { sort } : {}),
        ...(filters.length > 0 ? { filters } : {}),
        ...(cursor ? { cursor } : {}),
        countMode: filters.length > 0 ? "exact" : "estimate",
      }),
    enabled: selection !== null,
    placeholderData: (previous) => previous,
  });

  const result = browse.data;
  const columnNames = useMemo(() => result?.columns.map((c) => c.name) ?? [], [result]);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["browse", id] });

  const editCell = useMutation({
    mutationFn: async ({ rowIndex, column, value }: { rowIndex: number; column: string; value: CellValue }) => {
      const row = result!.rows[rowIndex]!;
      const key: Record<string, CellValue> = {};
      for (const pk of result!.primaryKey) key[pk] = row[pk] ?? null;
      return api.updateRow(id, selection!.schema, selection!.table, key, { [column]: value });
    },
    onSuccess: () => {
      setActionError(null);
      refresh();
    },
    onError: (err) => setActionError(err instanceof ApiError ? err.message : "Update failed."),
  });

  const removeRow = useMutation({
    mutationFn: async (rowIndex: number) => {
      const row = result!.rows[rowIndex]!;
      const key: Record<string, CellValue> = {};
      for (const pk of result!.primaryKey) key[pk] = row[pk] ?? null;
      return api.deleteRow(id, selection!.schema, selection!.table, key);
    },
    onSuccess: () => {
      setActionError(null);
      refresh();
    },
    onError: (err) => setActionError(err instanceof ApiError ? err.message : "Delete failed."),
  });

  const toggleSort = (column: string) => {
    setSort((current) =>
      current?.column === column
        ? current.direction === "asc"
          ? { column, direction: "desc" }
          : undefined
        : { column, direction: "asc" },
    );
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] rounded-lg border border-border bg-surface-raised">
      <SchemaSidebar projectId={id} selected={selection} onSelect={setSelection} />

      <section className="flex min-w-0 flex-1 flex-col">
        {!selection ? (
          <div className="flex flex-1 items-center justify-center text-sm text-content-muted">
            Pick a table to browse.
          </div>
        ) : (
          <>
            <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
              <div className="min-w-0">
                <span className="mono text-sm font-medium">
                  {selection.schema}.{selection.table}
                </span>
                {result?.total ? (
                  <span className="ml-2 text-xs text-content-muted">
                    {result.total.mode === "estimate" ? "~" : ""}
                    {result.total.value.toLocaleString()} rows
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="secondary" onClick={refresh}>
                  Refresh
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    result &&
                    downloadCsv(
                      `${selection.table}.csv`,
                      toCsv(columnNames, result.rows),
                    )
                  }
                >
                  Export CSV
                </Button>
                <Button
                  disabled={!result?.editable}
                  onClick={() => setInserting(true)}
                >
                  Insert row
                </Button>
              </div>
            </header>

            <FilterBar columns={columnNames} filters={filters} onChange={setFilters} />

            {result && !result.editable && result.editableReason ? (
              <p className="border-b border-border bg-warn/5 px-4 py-1.5 text-xs text-warn">
                Read only — {result.editableReason}
              </p>
            ) : null}

            {result?.offsetNote ? (
              <p className="border-b border-border px-4 py-1.5 text-xs text-content-subtle">
                {result.offsetNote}
              </p>
            ) : null}

            {actionError ? (
              <p className="border-b border-border bg-danger/10 px-4 py-1.5 text-xs text-danger">
                {actionError}
              </p>
            ) : null}

            <div className="min-h-0 flex-1 overflow-auto">
              {browse.isLoading ? (
                <p className="p-6 text-sm text-content-muted">Loading…</p>
              ) : browse.error ? (
                <p className="p-6 text-sm text-danger">
                  {browse.error instanceof ApiError ? browse.error.message : "Could not read this table."}
                </p>
              ) : result ? (
                <DataGrid
                  result={result}
                  sort={sort}
                  onSort={toggleSort}
                  onEdit={(rowIndex, column, value) => editCell.mutate({ rowIndex, column, value })}
                  onDeleteRow={(rowIndex) => removeRow.mutate(rowIndex)}
                />
              ) : null}
            </div>

            <footer className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-content-muted">
              <span>
                Page {page + 1}
                {result?.rows.length ? ` · ${result.rows.length} rows shown` : ""}
              </span>
              <span className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={cursors.length === 0}
                  onClick={() => setCursors((c) => c.slice(0, -1))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={!result?.nextCursor}
                  onClick={() => result?.nextCursor && setCursors((c) => [...c, result.nextCursor!])}
                >
                  Next
                </Button>
              </span>
            </footer>
          </>
        )}
      </section>

      {inserting && selection && result ? (
        <InsertRowModal
          projectId={id}
          selection={selection}
          columns={result.columns}
          onClose={() => setInserting(false)}
        />
      ) : null}
    </div>
  );
}
