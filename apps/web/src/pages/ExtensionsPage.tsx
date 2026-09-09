import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import type { ExtensionState } from "@justpostgres/shared";
import { Badge, Button, Card, Modal, PageHeader } from "../components/ui.js";
import { api, ApiError } from "../lib/api.js";

const CATEGORY_ORDER = [
  "search",
  "geospatial",
  "scheduling",
  "security",
  "observability",
  "utility",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  search: "Search and indexing",
  geospatial: "Geospatial",
  scheduling: "Scheduling",
  security: "Security",
  observability: "Observability",
  utility: "Utility",
  other: "Everything else in this image",
};

function RestartWarning({
  extension,
  onCancel,
  onConfirm,
  pending,
}: {
  extension: ExtensionState;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <Modal
      title={`Enabling ${extension.title} restarts your database`}
      description="Not a choice this tool is making — Postgres reads shared_preload_libraries once, when it starts. A library that was not loaded then cannot be loaded later by any means."
      onClose={onCancel}
    >
      <div className="rounded-md bg-warn/10 px-3 py-2.5 text-xs text-warn">
        Every open connection will be dropped and the database will be unavailable for a few seconds
        while it comes back. The extension is created once it is up.
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" disabled={pending} onClick={onConfirm}>
          {pending ? "Restarting…" : "Restart and enable"}
        </Button>
      </div>
    </Modal>
  );
}

function ExtensionRow({
  extension,
  onEnable,
  onDisable,
  onUpdate,
  busy,
}: {
  extension: ExtensionState;
  onEnable: (e: ExtensionState) => void;
  onDisable: (e: ExtensionState) => void;
  onUpdate: (e: ExtensionState) => void;
  busy: boolean;
}) {
  const installed = extension.installedVersion !== null;

  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3 last:border-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mono text-sm font-medium">{extension.title}</span>
          {installed ? <Badge tone="ok">v{extension.installedVersion}</Badge> : null}
          {extension.requiresRestart ? (
            <Badge tone="warn">needs a restart</Badge>
          ) : null}
          {!extension.availableInImage ? <Badge tone="neutral">not in this image</Badge> : null}
          {extension.updateAvailable ? (
            <Badge tone="accent">v{extension.defaultVersion} available</Badge>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-content-muted">
          {extension.description ?? extension.comment ?? "No description."}
        </p>
        {!extension.availableInImage ? (
          <p className="mt-1 text-xs text-content-subtle">
            This project's image does not ship it. Rebuilding the image with it, and recreating the
            project on that image, is the only way to add it.
          </p>
        ) : null}
        {extension.docsUrl ? (
          <a
            href={extension.docsUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1 inline-block text-xs text-accent hover:underline"
          >
            Documentation ↗
          </a>
        ) : null}
      </div>

      <div className="flex shrink-0 gap-2">
        {extension.updateAvailable ? (
          <Button variant="secondary" disabled={busy} onClick={() => onUpdate(extension)}>
            Update
          </Button>
        ) : null}
        {installed ? (
          <Button variant="danger" disabled={busy} onClick={() => onDisable(extension)}>
            Disable
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={busy || !extension.availableInImage}
            onClick={() => onEnable(extension)}
          >
            Enable
          </Button>
        )}
      </div>
    </div>
  );
}

export default function ExtensionsPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<ExtensionState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ["extensions", id],
    queryFn: () => api.extensions(id),
    // A restart-requiring enable runs as a job, so the list has to catch up on
    // its own rather than only after the mutation resolves.
    refetchInterval: 3000,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["extensions", id] });
  const report = (err: unknown) =>
    setError(err instanceof ApiError ? err.message : "Something went wrong.");

  const enable = useMutation({
    mutationFn: (name: string) => api.enableExtension(id, name),
    onSuccess: (result, name) => {
      setError(null);
      setNotice(
        result.mode === "restart"
          ? `Restarting to enable ${name}. It will appear here once Postgres is back.`
          : `${name} is enabled.`,
      );
      invalidate();
    },
    onError: report,
  });

  const disable = useMutation({
    mutationFn: (name: string) => api.disableExtension(id, name),
    onSuccess: (_r, name) => {
      setError(null);
      setNotice(`${name} was dropped.`);
      invalidate();
    },
    onError: report,
  });

  const update = useMutation({
    mutationFn: (name: string) => api.updateExtension(id, name),
    onSuccess: (result, name) => {
      setError(null);
      setNotice(`${name} updated to v${result.version}.`);
      invalidate();
    },
    onError: report,
  });

  const grouped = useMemo(() => {
    const groups = new Map<string, ExtensionState[]>();
    for (const extension of data?.extensions ?? []) {
      const key = extension.category ?? "other";
      groups.set(key, [...(groups.get(key) ?? []), extension]);
    }
    return [...CATEGORY_ORDER, "other"]
      .filter((key) => groups.has(key))
      .map((key) => ({ key, label: CATEGORY_LABELS[key] ?? key, items: groups.get(key)! }));
  }, [data]);

  const busy = enable.isPending || disable.isPending || update.isPending;

  const requestEnable = (extension: ExtensionState) => {
    // The warning is shown before the click has any effect, not after.
    if (extension.requiresRestart && !extension.preloaded) setConfirming(extension);
    else enable.mutate(extension.name);
  };

  return (
    <>
      <PageHeader
        title="Extensions"
        description="What this project's image can run. Most turn on instantly; the ones that hook into Postgres at startup need a restart, and say so before you click."
      />

      {notice ? (
        <Card className="mb-4 border-accent/40 px-4 py-2.5 text-xs text-accent">{notice}</Card>
      ) : null}
      {error ? (
        <Card className="mb-4 border-danger/40 px-4 py-2.5 text-xs text-danger">{error}</Card>
      ) : null}

      {isLoading ? (
        <Card className="px-6 py-14 text-center text-sm text-content-muted">Loading…</Card>
      ) : loadError ? (
        <Card className="px-6 py-14 text-center text-sm text-danger">
          {loadError instanceof ApiError ? loadError.message : "Could not read the extension list."}
        </Card>
      ) : (
        <div className="space-y-4">
          {grouped.map((group) => (
            <Card key={group.key}>
              <div className="border-b border-border px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-content-subtle">
                {group.label}
              </div>
              {group.items.map((extension) => (
                <ExtensionRow
                  key={extension.name}
                  extension={extension}
                  busy={busy}
                  onEnable={requestEnable}
                  onDisable={(e) => disable.mutate(e.name)}
                  onUpdate={(e) => update.mutate(e.name)}
                />
              ))}
            </Card>
          ))}
        </div>
      )}

      {confirming ? (
        <RestartWarning
          extension={confirming}
          pending={enable.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const name = confirming.name;
            setConfirming(null);
            enable.mutate(name);
          }}
        />
      ) : null}
    </>
  );
}
