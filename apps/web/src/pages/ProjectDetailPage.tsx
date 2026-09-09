import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { ConnectionEndpoint, ProjectAction } from "@justpostgres/shared";
import { api, ApiError } from "../lib/api.js";
import { Button, Card, CopyButton, Loading, Modal, ProgressBar, formatBytes, relativeTime } from "../components/ui.js";
import ProjectMetricsCard from "../components/ProjectMetricsCard.js";

function DeleteModal({
  projectName,
  onClose,
  onConfirm,
  pending,
}: {
  projectName: string;
  onClose: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  const [typed, setTyped] = useState("");
  const matches = typed === projectName;

  return (
    <Modal
      title="Delete project"
      description="The container, the volume and every byte in this database are removed. There is no backup to restore from — backups arrive in M4."
      onClose={onClose}
    >
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-content-muted">
          Type <span className="mono text-content">{projectName}</span> to confirm
        </span>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm focus:border-danger"
        />
      </label>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" disabled={!matches || pending} onClick={onConfirm}>
          {pending ? "Deleting…" : "Delete permanently"}
        </Button>
      </div>
    </Modal>
  );
}

function EndpointPanel({
  endpoint,
  revealed,
}: {
  endpoint: ConnectionEndpoint;
  revealed: boolean;
}) {
  const shown = revealed ? (endpoint.url ?? "") : endpoint.maskedUrl;

  return (
    <div>
      <p className="mb-3 text-sm text-content-muted">{endpoint.description}</p>

      <div className="flex gap-2">
        <pre className="mono flex-1 overflow-x-auto rounded-md bg-surface-sunken px-3 py-2.5 text-xs">
          {shown}
        </pre>
        {revealed && endpoint.url ? <CopyButton value={endpoint.url} label="Copy" /> : null}
      </div>

      {revealed && endpoint.psql ? (
        <div className="mt-3 flex gap-2">
          <pre className="mono flex-1 overflow-x-auto rounded-md bg-surface-sunken px-3 py-2.5 text-xs">
            {endpoint.psql}
          </pre>
          <CopyButton value={endpoint.psql} />
        </div>
      ) : null}

      {endpoint.caveat ? (
        <p className="mt-3 rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">{endpoint.caveat}</p>
      ) : null}

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
        {[
          ["Host", endpoint.host],
          ["Port", String(endpoint.port)],
          ["User", endpoint.user],
          ["Database", endpoint.database],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-content-subtle">{label}</dt>
            <dd className="mono mt-0.5 break-all">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ConnectionCard({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const [revealed, setRevealed] = useState(false);
  const [selected, setSelected] = useState(0);

  const { data, error } = useQuery({
    queryKey: ["connection", projectId, revealed],
    queryFn: () => api.connection(projectId, revealed),
    enabled: !disabled,
    // The revealed form holds a live superuser password; keep it out of the
    // cache once the component is gone.
    gcTime: revealed ? 0 : 5 * 60_000,
  });

  if (disabled) {
    return (
      <Card className="px-4 py-8 text-center text-sm text-content-muted">
        Connection strings appear once the project is running.
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="px-4 py-8 text-center text-sm text-danger">
        {error instanceof ApiError ? error.message : "Could not load connection details."}
      </Card>
    );
  }

  const endpoints = data?.connection.endpoints ?? [];
  const active = endpoints[Math.min(selected, endpoints.length - 1)];

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {/* A segmented control, not three loose buttons — these are one choice
            with three options, and the old styling made the unselected ones
            look like separate actions. */}
        <div className="inline-flex rounded-lg border border-border bg-surface-sunken p-0.5">
          {endpoints.map((endpoint, index) => (
            <button
              key={endpoint.kind}
              onClick={() => setSelected(index)}
              aria-pressed={index === selected}
              className={`rounded-[7px] px-3 py-1.5 text-sm transition-colors ${
                index === selected
                  ? "bg-surface-raised font-medium text-content shadow-card"
                  : "text-content-muted hover:text-content"
              }`}
            >
              {endpoint.label}
            </button>
          ))}
        </div>
        <Button variant="secondary" size="sm" onClick={() => setRevealed((v) => !v)}>
          {revealed ? "Hide password" : "Reveal password"}
        </Button>
      </div>

      {active ? <EndpointPanel endpoint={active} revealed={revealed} /> : (
        <p className="text-sm text-content-muted">Loading…</p>
      )}
    </Card>
  );
}

export default function ProjectDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["project", id],
    queryFn: () => api.getProject(id),
    refetchInterval: 3000,
  });

  const { data: jobs } = useQuery({
    queryKey: ["project-jobs", id],
    queryFn: () => api.jobsForProject(id),
    refetchInterval: 2000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["project", id] });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
  };

  const action = useMutation({
    mutationFn: (a: ProjectAction) => api.projectAction(id, a),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: () => api.deleteProject(id),
    onSuccess: () => {
      invalidate();
      navigate("/projects");
    },
  });

  if (isLoading) {
    return <Loading rows={3} />;
  }

  if (error || !data) {
    return (
      <Card className="px-6 py-14 text-center text-sm text-danger">
        {error instanceof ApiError ? error.message : "Could not load this project."}
      </Card>
    );
  }

  const { project, runtime } = data;
  const busy = project.state === "creating" || project.state === "deleting";
  const activeJob = jobs?.jobs.find((j) => j.state === "running" || j.state === "queued");

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-content-muted">
          <span>
            {formatBytes(project.memoryBytes)} · {(project.nanoCpus / 1e9).toFixed(1)} CPU
          </span>
          {runtime ? <span>container {runtime.containerExists ? runtime.status : "missing"}</span> : null}
          <span className="text-content-subtle">created {relativeTime(project.createdAt)}</span>
        </div>

        <div className="flex gap-2">
          {project.state === "running" ? (
            <Button variant="secondary" loading={action.isPending} onClick={() => action.mutate("stop")}>
              Stop
            </Button>
          ) : null}
          {project.state === "stopped" || project.state === "failed" ? (
            <Button variant="secondary" loading={action.isPending} onClick={() => action.mutate("start")}>
              Start
            </Button>
          ) : null}
          {project.state === "running" ? (
            <Button variant="secondary" loading={action.isPending} onClick={() => action.mutate("restart")}>
              Restart
            </Button>
          ) : null}
          <Button variant="danger" disabled={busy} onClick={() => setConfirmingDelete(true)}>
            Delete
          </Button>
        </div>
      </div>

      {project.lastError ? (
        <Card className="mb-4 border-danger/40 p-4">
          <div className="text-xs font-medium text-danger">Last error</div>
          <p className="mono mt-1 text-xs text-content-muted">{project.lastError}</p>
        </Card>
      ) : null}

      {activeJob ? (
        <Card className="mb-4 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">{activeJob.type}</span>
            <span className="text-xs text-content-muted">
              {activeJob.progress?.message ?? activeJob.state}
            </span>
          </div>
          <ProgressBar percent={activeJob.progress?.percent ?? 0} />
        </Card>
      ) : null}

      {action.error ? (
        <Card className="mb-4 border-danger/40 px-4 py-3 text-xs text-danger">
          {action.error instanceof ApiError ? action.error.message : "Action failed."}
        </Card>
      ) : null}

      <ProjectMetricsCard projectId={id} running={project.state === "running"} />

      <ConnectionCard projectId={id} disabled={project.state !== "running"} />

      {confirmingDelete ? (
        <DeleteModal
          projectName={project.name}
          pending={remove.isPending}
          onClose={() => setConfirmingDelete(false)}
          onConfirm={() => remove.mutate()}
        />
      ) : null}
    </>
  );
}
