import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import type { PolicyTemplate, TableSecurity } from "@justpostgres/shared";
import { Badge, Button, Card, CopyButton, Input, Modal, PageHeader, Select } from "../components/ui.js";
import { api, ApiError } from "../lib/api.js";

const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

function ExposeModal({
  projectId,
  table,
  templates,
  onClose,
}: {
  projectId: string;
  table: TableSecurity;
  templates: PolicyTemplate[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "owner_only");
  const [column, setColumn] = useState("");
  const [claim, setClaim] = useState("tenant_id");
  const [privileges, setPrivileges] = useState<string[]>(["SELECT"]);

  const template = templates.find((t) => t.id === templateId);

  const expose = useMutation({
    mutationFn: () =>
      api.exposeTable(projectId, {
        schema: table.schema,
        table: table.table,
        privileges: privileges as never,
        template: templateId,
        ...(column ? { column } : {}),
        ...(templateId === "tenant" ? { claim } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["security", projectId] });
      onClose();
    },
  });

  return (
    <Modal
      title={`Expose ${table.table} through the API`}
      description="Granting access and enabling row-level security happen together, in one transaction. There is no step where the table is reachable but unprotected."
      onClose={onClose}
    >
      <div className="space-y-4">
        <div>
          <span className="mb-1.5 block text-xs font-medium text-content-muted">Who can see which rows</span>
          <div className="space-y-2">
            {templates.map((t) => (
              <label
                key={t.id}
                className={`block cursor-pointer rounded-md border px-3 py-2 ${
                  templateId === t.id ? "border-accent bg-surface-sunken" : "border-border"
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={templateId === t.id}
                    onChange={() => setTemplateId(t.id)}
                  />
                  <span className="text-sm font-medium">{t.title}</span>
                </span>
                <span className="mt-1 block pl-6 text-xs text-content-muted">{t.description}</span>
              </label>
            ))}
          </div>
        </div>

        {template?.needsColumn ? (
          <Input
            label={template.columnLabel ?? "Column"}
            value={column}
            onChange={(e) => setColumn(e.target.value)}
            placeholder="owner_id"
          />
        ) : null}

        {templateId === "tenant" ? (
          <Input
            label="Claim name in the token"
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
            hint="Whatever your identity provider puts in the JWT to identify the tenant."
          />
        ) : null}

        <div>
          <span className="mb-1.5 block text-xs font-medium text-content-muted">Allowed operations</span>
          <div className="flex flex-wrap gap-2">
            {PRIVILEGES.map((p) => (
              <label key={p} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={privileges.includes(p)}
                  onChange={(e) =>
                    setPrivileges((current) =>
                      e.target.checked ? [...current, p] : current.filter((v) => v !== p),
                    )
                  }
                />
                <span className="mono">{p}</span>
              </label>
            ))}
          </div>
        </div>

        {expose.error ? (
          <p className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
            {expose.error instanceof ApiError ? expose.error.message : "Could not expose the table."}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={expose.isPending || privileges.length === 0 || (template?.needsColumn && !column)}
            onClick={() => expose.mutate()}
          >
            {expose.isPending ? "Applying…" : "Expose"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function KeyRow({ label, value, hint }: { label: string; value: string; hint: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="border-b border-border px-4 py-3 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium">{label}</div>
          <p className="mt-0.5 text-xs text-content-muted">{hint}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" onClick={() => setShown((v) => !v)}>
            {shown ? "Hide" : "Show"}
          </Button>
          <CopyButton value={value} />
        </div>
      </div>
      <pre className="mono mt-2 overflow-x-auto rounded-md bg-surface-sunken px-3 py-2 text-xs">
        {shown ? value : `${value.slice(0, 24)}${"•".repeat(28)}`}
      </pre>
    </div>
  );
}

export default function ApiPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const [exposing, setExposing] = useState<TableSecurity | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: status } = useQuery({
    queryKey: ["api-status", id],
    queryFn: () => api.apiStatus(id, true),
    refetchInterval: 4000,
  });

  const { data: security } = useQuery({
    queryKey: ["security", id],
    queryFn: () => api.security(id),
    enabled: Boolean(status?.status?.enabled),
    refetchInterval: 8000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["api-status", id] });
    void queryClient.invalidateQueries({ queryKey: ["security", id] });
  };
  const report = (err: unknown) =>
    setError(err instanceof ApiError ? err.message : "Something went wrong.");

  const enable = useMutation({ mutationFn: () => api.enableApi(id), onSuccess: invalidate, onError: report });
  const disable = useMutation({ mutationFn: () => api.disableApi(id), onSuccess: invalidate, onError: report });
  const rotate = useMutation({ mutationFn: () => api.rotateApiKeys(id), onSuccess: invalidate, onError: report });
  const unexpose = useMutation({
    mutationFn: (t: TableSecurity) => api.unexposeTable(id, t.schema, t.table),
    onSuccess: invalidate,
    onError: report,
  });
  const setRls = useMutation({
    mutationFn: ({ t, enabled }: { t: TableSecurity; enabled: boolean }) =>
      api.setRls(id, t.schema, t.table, enabled),
    onSuccess: invalidate,
    onError: report,
  });

  const s = status?.status;
  const dangerous = (security?.tables ?? []).filter((t) => t.exposedWithoutRls);

  return (
    <>
      <PageHeader
        title="REST API"
        description="An HTTP API over your schema, generated by PostgREST. Off by default — turning it on makes a private database reachable, and what keeps it safe is row-level security."
        actions={
          s?.enabled ? (
            <>
              <Button variant="secondary" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
                Rotate keys
              </Button>
              <Button variant="danger" disabled={disable.isPending} onClick={() => disable.mutate()}>
                Disable
              </Button>
            </>
          ) : (
            <Button disabled={enable.isPending} onClick={() => enable.mutate()}>
              {enable.isPending ? "Enabling…" : "Enable the API"}
            </Button>
          )
        }
      />

      {error ? (
        <Card className="mb-4 border-danger/40 px-4 py-2.5 text-xs text-danger">{error}</Card>
      ) : null}
      {s?.lastError ? (
        <Card className="mb-4 border-danger/40 px-4 py-2.5 text-xs text-danger">{s.lastError}</Card>
      ) : null}

      {dangerous.length > 0 ? (
        <Card className="mb-4 border-danger p-4">
          <div className="mb-1 flex items-center gap-2">
            <Badge tone="danger">reachable with no row-level security</Badge>
          </div>
          <p className="text-xs text-content-muted">
            {dangerous.map((t) => t.table).join(", ")} — anyone holding the anon key can read every row
            of {dangerous.length === 1 ? "this table" : "these tables"}. Exposing a table through this
            page always enables RLS, so this came from a manual <span className="mono">GRANT</span> or
            from RLS being switched off afterwards.
          </p>
        </Card>
      ) : null}

      {!s?.enabled ? (
        <Card className="px-6 py-12 text-center">
          <p className="text-sm font-medium">The API is off</p>
          <p className="mx-auto mt-2 max-w-lg text-sm text-content-muted">
            When you turn it on, no table is reachable until you expose it. That is deliberately the
            opposite of the usual default, where every table is reachable and row-level security is
            the only thing in the way.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <div className="border-b border-border px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-content-subtle">
              Endpoint
            </div>
            <div className="px-4 py-3">
              <pre className="mono overflow-x-auto rounded-md bg-surface-sunken px-3 py-2 text-xs">
                {window.location.origin}
                {s.endpoints.path}
              </pre>
              {s.endpoints.host ? (
                <pre className="mono mt-2 overflow-x-auto rounded-md bg-surface-sunken px-3 py-2 text-xs">
                  https://{s.endpoints.host}/
                </pre>
              ) : null}
              <p className="mt-2 text-xs text-content-subtle">
                {s.running ? "Running" : "Starting…"} · at most {s.maxRows} rows per request · key
                version {s.keyVersion}
              </p>
            </div>
          </Card>

          {s.keys ? (
            <Card>
              <div className="border-b border-border px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-content-subtle">
                Keys
              </div>
              <KeyRow
                label="anon"
                value={s.keys.anon}
                hint="Safe to ship in a browser. It grants nothing on its own — only what your policies allow."
              />
              <KeyRow
                label="service_role"
                value={s.keys.service}
                hint="Bypasses row-level security entirely. Server-side only. Never send it to a browser."
              />
              <div className="px-4 py-3 text-xs text-content-muted">
                Your own identity provider — Clerk, Auth0, WorkOS, Better Auth — can sign tokens with
                this project's secret. Put the user id in <span className="mono">sub</span> and read it
                in a policy with <span className="mono">auth.uid()</span>. justpostgres does not manage
                users, and does not need to.
              </div>
            </Card>
          ) : null}

          <Card>
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="text-xs font-medium uppercase tracking-wide text-content-subtle">
                Tables
              </span>
              <span className="text-xs text-content-subtle">
                A table is reachable only when the anon role holds privileges on it
              </span>
            </div>
            {(security?.tables ?? []).length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-content-muted">No tables yet.</p>
            ) : (
              (security?.tables ?? []).map((t) => (
                <div
                  key={`${t.schema}.${t.table}`}
                  className="flex items-start justify-between gap-4 border-b border-border px-4 py-3 last:border-0"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mono text-sm font-medium">{t.table}</span>
                      {t.anonPrivileges.length > 0 ? (
                        <Badge tone={t.exposedWithoutRls ? "danger" : "ok"}>
                          {t.anonPrivileges.join(", ")}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">not exposed</Badge>
                      )}
                      {t.rlsEnabled ? <Badge tone="ok">RLS on</Badge> : <Badge tone="warn">RLS off</Badge>}
                    </div>
                    {t.policies.length > 0 ? (
                      <ul className="mt-1.5 space-y-1">
                        {t.policies.map((p) => (
                          <li key={p.name} className="mono text-xs text-content-muted">
                            {p.name} · {p.command} · {p.using ?? "—"}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-xs text-content-subtle">No policies.</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => setRls.mutate({ t, enabled: !t.rlsEnabled })}
                    >
                      {t.rlsEnabled ? "Disable RLS" : "Enable RLS"}
                    </Button>
                    {t.anonPrivileges.length > 0 ? (
                      <Button variant="danger" onClick={() => unexpose.mutate(t)}>
                        Unexpose
                      </Button>
                    ) : (
                      <Button onClick={() => setExposing(t)}>Expose</Button>
                    )}
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>
      )}

      {exposing && security ? (
        <ExposeModal
          projectId={id}
          table={exposing}
          templates={security.templates}
          onClose={() => setExposing(null)}
        />
      ) : null}
    </>
  );
}
