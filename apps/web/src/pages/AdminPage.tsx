import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuditEntry } from "@justpostgres/shared";
import { Badge, Button, Card, CardHeader, Input, PageHeader, formatBytes } from "../components/ui.js";
import ObjectStorageCard from "../components/ObjectStorageCard.js";
import { api, ApiError } from "../lib/api.js";

/**
 * Actions are stored as dotted identifiers because they are meant to be
 * grepped in a log; a person reading a table wants a sentence.
 */
const ACTION_LABELS: Record<string, string> = {
  "admin.setup": "claimed this instance",
  "admin.setup_failed": "tried to claim this instance with a bad token",
  "admin.login": "signed in",
  "admin.login_failed": "failed to sign in",
  "admin.password_changed": "changed the administrator password",

  "project.create": "created a project",
  "project.delete": "deleted a project",
  "project.start": "started a project",
  "project.stop": "stopped a project",
  "project.restart": "restarted a project",
  "project.credentials_revealed": "revealed a project's database password",
  "project.promoted": "promoted a restored project",
  "project.upgrade": "started a major-version upgrade",
  "project.upgrade.discard_previous": "deleted a pre-upgrade data directory",

  "backup.run_requested": "asked for a backup",
  "backup.config_changed": "changed the backup schedule",
  "backup.verify_requested": "asked to verify a backup by restoring it",
  "restore.started": "started a restore",
  "branch.create": "created a branch",
  "branch.expiry_changed": "changed a branch's expiry",

  "extension.enable": "enabled an extension",
  "extension.disable": "disabled an extension",
  "extension.update": "updated an extension",

  "api.enable": "turned the REST API on",
  "api.disable": "turned the REST API off",
  "api.keys_rotated": "rotated the API keys",
  "api.keys_revealed": "revealed the API keys",
  "security.table_exposed": "exposed a table through the API",
  "security.table_unexposed": "removed a table from the API",
  "security.policy_created": "created a row-level security policy",
  "security.policy_dropped": "dropped a row-level security policy",

  "data.insert": "inserted a row",
  "data.update": "updated a row",
  "data.delete": "deleted a row",
  "data.query": "ran SQL",

  "control_plane.backup": "backed up the metadata store",
  "control_plane.backup_downloaded": "downloaded a metadata backup",
};

function AuditRow({ entry }: { entry: AuditEntry }) {
  let payload: Record<string, unknown> | null = null;
  try {
    payload = entry.payload ? JSON.parse(entry.payload) : null;
  } catch {
    payload = null;
  }

  // Deletions, failures and anything that put a secret on someone's screen.
  // These are the rows a person scanning this page is looking for.
  const notable = /delete|failed|discard|revealed|drop|promote/.test(entry.action);

  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3 last:border-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{entry.actor}</span>
          <span className={`text-sm ${notable ? "text-warn" : "text-content-muted"}`}>
            {ACTION_LABELS[entry.action] ?? entry.action}
          </span>
        </div>
        {payload ? (
          <p className="mono mt-1 truncate text-xs text-content-subtle">
            {Object.entries(payload)
              .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
              .join(" · ")}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 text-right">
        <p className="mono text-xs text-content-subtle">{new Date(entry.at).toLocaleString()}</p>
        {entry.ip ? <p className="mono text-xs text-content-subtle">{entry.ip}</p> : null}
      </div>
    </div>
  );
}

/**
 * Changing the administrator password.
 *
 * The endpoint existed and nothing called it, which meant the only way to
 * rotate the one credential that opens every database on the host was to lose
 * it and recover from the host. Rotation should not require an outage.
 */
function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      setError(null);
      setDone(true);
      setTimeout(() => setDone(false), 4000);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setDone(false);
    if (next !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    setError(null);
    change.mutate();
  };

  return (
    <Card className="mb-6">
      <CardHeader
        title="Administrator password"
        description="There is one account on this instance and it holds superuser credentials for every database on the host. Changing it here signs nothing else out."
      />
      <form onSubmit={submit} className="grid gap-4 px-5 py-4 sm:grid-cols-3">
        <Input
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
        <Input
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />

        <div className="sm:col-span-3">
          {error ? <p className="mb-3 text-xs text-danger">{error}</p> : null}
          {done ? <p className="mb-3 text-xs text-ok">Password changed.</p> : null}
          <Button type="submit" loading={change.isPending} disabled={!current || !next}>
            Change password
          </Button>
          <p className="mt-3 text-xs leading-relaxed text-content-subtle">
            Forgotten it instead? There is no reset link — recover from the host with{" "}
            <span className="mono">docker compose exec control-plane node dist/index.js reset-admin</span>,
            which removes the account so the instance can be claimed again. Projects and their data
            are untouched.
          </p>
        </div>
      </form>
    </Card>
  );
}

export default function AdminPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, string>>({});

  const audit = useQuery({ queryKey: ["audit"], queryFn: () => api.audit({ limit: 200 }) });
  const backups = useQuery({
    queryKey: ["cp-backups"],
    queryFn: api.controlPlaneBackups,
    refetchInterval: 30_000,
  });

  const run = useMutation({
    mutationFn: api.runControlPlaneBackup,
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["cp-backups"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const verify = useMutation({
    mutationFn: (name: string) => api.verifyControlPlaneBackup(name),
    onSuccess: (result, name) =>
      setVerified((prev) => ({ ...prev, [name]: result.ok ? `ok — ${result.detail}` : result.detail })),
  });

  return (
    <>
      <PageHeader
        title="Instance"
        description="What this control plane has been asked to do, and what would survive losing it."
      />

      {error ? (
        <Card className="mb-4 border-danger/40 px-4 py-3 text-sm text-danger">{error}</Card>
      ) : null}

      <ChangePassword />

      <ObjectStorageCard />

      <Card className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5">
          <div>
            <h2 className="text-sm font-medium">Metadata store backups</h2>
            <p className="mt-1 max-w-2xl text-xs text-content-muted">
              The projects themselves are backed up by pgBackRest. This is the control plane's own
              database — which projects exist, where their containers are, and their encrypted
              credentials. Lose it and the databases keep running with nothing able to reach them.
            </p>
            <p className="mt-2 max-w-2xl text-xs text-warn">
              These files do not contain <span className="mono">JP_MASTER_KEY</span>, and are
              useless without it. Keep the key somewhere else — a backup stored next to its key is
              one theft, not two.
            </p>
          </div>
          <Button variant="secondary" onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? "Backing up…" : "Back up now"}
          </Button>
        </div>

        {backups.data?.status.lastError ? (
          <p className="border-b border-border px-4 py-2.5 text-xs text-danger">
            Last attempt failed: {backups.data.status.lastError}
          </p>
        ) : null}

        {(backups.data?.backups ?? []).length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-content-muted">
            No backups yet.
          </p>
        ) : (
          (backups.data?.backups ?? []).map((b) => (
            <div
              key={b.name}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-0"
            >
              <div className="min-w-0">
                <p className="mono text-sm">{b.name}</p>
                <p className="mono mt-1 text-xs text-content-subtle">
                  {formatBytes(b.sizeBytes)} · sha256 {b.sha256.slice(0, 16)}…
                </p>
                {verified[b.name] ? (
                  <p className="mono mt-1 text-xs text-content-subtle">{verified[b.name]}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="secondary"
                  onClick={() => verify.mutate(b.name)}
                  disabled={verify.isPending}
                >
                  Verify
                </Button>
                <a
                  className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-raised"
                  href={`/api/admin/control-plane-backups/${b.name}/download`}
                >
                  Download
                </a>
              </div>
            </div>
          ))
        )}

        <p className="px-4 py-3 text-xs text-content-subtle">
          To restore: stop the control plane, put the file where{" "}
          <span className="mono">JP_DATA_DIR</span> is empty, and start it with{" "}
          <span className="mono">JP_RESTORE_CONTROL_PLANE_FROM</span> pointing at it. It refuses to
          overwrite an existing store, so leaving that variable set cannot roll you back later.
        </p>
      </Card>

      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium">Audit log</h2>
        <Badge tone="neutral">{audit.data?.entries.length ?? 0}</Badge>
      </div>
      <p className="mb-3 max-w-3xl text-xs text-content-muted">
        Every action that changed something, with who did it and from where. A tool holding superuser
        credentials for every database on the host has to be able to answer "who deleted that".
      </p>

      <Card>
        {audit.isLoading ? (
          <p className="px-4 py-8 text-center text-sm text-content-muted">Loading…</p>
        ) : (audit.data?.entries ?? []).length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-content-muted">Nothing recorded yet.</p>
        ) : (
          (audit.data?.entries ?? []).map((entry) => <AuditRow key={entry.id} entry={entry} />)
        )}
      </Card>
    </>
  );
}
