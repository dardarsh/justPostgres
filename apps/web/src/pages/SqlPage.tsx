import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import CodeMirror from "@uiw/react-codemirror";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import type { CellValue, DestructiveWarning, QueryOutcome, StatementResult } from "@justpostgres/shared";
import { downloadCsv, toCsv } from "../components/DataGrid.js";
import { Button, Card, Modal } from "../components/ui.js";
import { api, ApiError } from "../lib/api.js";

const STARTER_SQL = "select * from information_schema.tables\nwhere table_schema = 'public'\nlimit 20;";

function ResultTable({ result }: { result: StatementResult }) {
  const columns = result.fields.map((f) => f.name);

  if (columns.length === 0) {
    return (
      <p className="px-4 py-3 text-xs text-content-muted">
        {result.command ?? "Statement"} — {result.rowCount ?? 0} row
        {result.rowCount === 1 ? "" : "s"} affected.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead className="bg-surface-raised">
          <tr className="border-b border-border text-left">
            {columns.map((name) => (
              <th key={name} className="mono px-3 py-2 font-medium whitespace-nowrap">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, index) => (
            <tr key={index} className="border-b border-border last:border-0">
              {columns.map((name) => (
                <td key={name} className="mono max-w-md truncate px-3 py-1.5 align-top">
                  {row[name] === null ? (
                    <span className="italic text-content-subtle">NULL</span>
                  ) : (
                    row[name]
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConfirmDestructive({
  warnings,
  onCancel,
  onConfirm,
}: {
  warnings: DestructiveWarning[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title="This will change more than one row"
      description="Run it anyway if that is what you meant."
      onClose={onCancel}
    >
      <ul className="space-y-3">
        {warnings.map((warning, index) => (
          <li key={index}>
            <pre className="mono overflow-x-auto rounded-md bg-surface-sunken px-3 py-2 text-xs">
              {warning.statement}
            </pre>
            <p className="mt-1 text-xs text-warn">{warning.reason}</p>
          </li>
        ))}
      </ul>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          Run anyway
        </Button>
      </div>
    </Modal>
  );
}

export default function SqlPage() {
  const { id = "" } = useParams();
  const [text, setText] = useState(STARTER_SQL);
  const [outcome, setOutcome] = useState<QueryOutcome | null>(null);
  const [explainText, setExplainText] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<DestructiveWarning[] | null>(null);

  // Completion is schema-aware: without the real table and column names the
  // editor suggests SQL keywords and nothing else, which is the least useful
  // half of autocomplete.
  const { data: schema } = useQuery({
    queryKey: ["schema", id],
    queryFn: () => api.schema(id),
    staleTime: 60_000,
  });

  const run = useMutation({
    mutationFn: (confirmed: boolean) => api.runQuery(id, { sql: text, confirmed }),
    onSuccess: (data) => {
      setExplainText(null);
      if (data.requiresConfirmation) {
        setPendingConfirm(data.requiresConfirmation);
        return;
      }
      setPendingConfirm(null);
      setOutcome(data);
    },
  });

  const explain = useMutation({
    mutationFn: (analyze: boolean) => api.explain(id, text, analyze),
    onSuccess: (data) => {
      setOutcome(null);
      setExplainText(data.text);
    },
  });

  const runNow = useCallback(() => run.mutate(false), [run]);

  const extensions = useMemo(() => {
    const tables: Record<string, string[]> = {};
    for (const s of schema?.schemas ?? []) {
      for (const relation of s.relations) {
        // Qualify only outside `public`, matching how people actually write it.
        const key = s.name === "public" ? relation.name : `${s.name}.${relation.name}`;
        tables[key] = [];
      }
    }

    return [
      sql({ dialect: PostgreSQL, schema: tables, upperCaseKeywords: false }),
      EditorView.lineWrapping,
      // High precedence so Cmd/Ctrl-Enter beats CodeMirror's own bindings.
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              runNow();
              return true;
            },
          },
        ]),
      ),
    ];
  }, [schema, runNow]);

  const error = run.error ?? explain.error;

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs text-content-muted">
            Cmd/Ctrl + Enter to run · multiple statements run in order, outside a transaction
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" loading={explain.isPending} onClick={() => explain.mutate(false)}>
              Explain
            </Button>
            <Button variant="secondary" loading={explain.isPending} onClick={() => explain.mutate(true)}>
              Explain analyze
            </Button>
            <Button loading={run.isPending} onClick={() => run.mutate(false)}>
              {run.isPending ? "Running…" : "Run"}
            </Button>
          </div>
        </div>

        <CodeMirror
          value={text}
          onChange={setText}
          extensions={extensions}
          height="240px"
          theme="dark"
          basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true }}
        />
      </Card>

      {error ? (
        <Card className="border-danger/40 px-4 py-3 text-xs text-danger">
          {error instanceof ApiError ? error.message : "Request failed."}
        </Card>
      ) : null}

      {explainText ? (
        <Card className="p-4">
          <div className="mb-2 text-xs font-medium text-content-muted">Query plan</div>
          <pre className="mono overflow-x-auto rounded-md bg-surface-sunken px-3 py-2.5 text-xs leading-relaxed">
            {explainText}
          </pre>
        </Card>
      ) : null}

      {outcome?.error ? (
        <Card className="border-danger/40 p-4">
          <p className="text-xs font-medium text-danger">{outcome.error.message}</p>
          {outcome.error.detail ? (
            <p className="mt-1 text-xs text-content-muted">{outcome.error.detail}</p>
          ) : null}
          {outcome.error.hint ? (
            <p className="mt-1 text-xs text-content-muted">Hint: {outcome.error.hint}</p>
          ) : null}
          {outcome.error.statement ? (
            <pre className="mono mt-2 overflow-x-auto rounded-md bg-surface-sunken px-3 py-2 text-xs">
              {outcome.error.statement}
            </pre>
          ) : null}
        </Card>
      ) : null}

      {outcome?.results.map((result, index) => (
        <Card key={index} className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-content-muted">
            <span className="mono truncate">{result.statement}</span>
            <span className="flex shrink-0 items-center gap-3">
              <span>
                {result.rowCount ?? 0} row{result.rowCount === 1 ? "" : "s"} · {result.durationMs}ms
              </span>
              {result.fields.length > 0 ? (
                <button
                  onClick={() =>
                    downloadCsv(
                      `result-${index + 1}.csv`,
                      toCsv(result.fields.map((f) => f.name), result.rows as Array<Record<string, CellValue>>),
                    )
                  }
                  className="hover:text-content"
                >
                  CSV
                </button>
              ) : null}
            </span>
          </div>
          {result.truncated ? (
            <p className="border-b border-border bg-warn/5 px-4 py-1.5 text-xs text-warn">
              Showing the first {result.rows.length} rows of {result.rowCount}. Export to CSV or add a
              LIMIT to see the rest.
            </p>
          ) : null}
          <ResultTable result={result} />
        </Card>
      ))}

      {pendingConfirm ? (
        <ConfirmDestructive
          warnings={pendingConfirm}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            setPendingConfirm(null);
            run.mutate(true);
          }}
        />
      ) : null}
    </div>
  );
}
