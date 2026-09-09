import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PG_MAJOR_VERSIONS, type PgMajorVersion, type Project } from "@justpostgres/shared";
import { api, ApiError } from "../lib/api.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Select,
  formatBytes,
  projectStateTone,
  relativeTime,
} from "../components/ui.js";

function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [pgMajor, setPgMajor] = useState<PgMajorVersion>(17);
  const [memoryMb, setMemoryMb] = useState(512);
  const [cpus, setCpus] = useState(1);

  const create = useMutation({
    mutationFn: () => api.createProject({ name, pgMajor, memoryMb, cpus }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <Modal
      title="New project"
      description="A dedicated Postgres container with its own volume and superuser."
      onClose={onClose}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Input
          label="Name"
          required
          autoFocus
          maxLength={64}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-app"
        />

        <Select
          label="Postgres version"
          value={pgMajor}
          onChange={(e) => setPgMajor(Number(e.target.value) as PgMajorVersion)}
          hint="Pinned for the life of the project. Changing it later is an explicit upgrade."
        >
          {PG_MAJOR_VERSIONS.map((v) => (
            <option key={v} value={v}>
              Postgres {v}
            </option>
          ))}
        </Select>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Memory (MB)"
            type="number"
            min={128}
            max={65536}
            step={128}
            value={memoryMb}
            onChange={(e) => setMemoryMb(Number(e.target.value))}
          />
          <Input
            label="CPUs"
            type="number"
            min={0.1}
            max={32}
            step={0.1}
            value={cpus}
            onChange={(e) => setCpus(Number(e.target.value))}
          />
        </div>
        <p className="text-xs text-content-subtle">
          Hard limits. One project cannot starve the host or its neighbours.
        </p>

        {create.error ? (
          <p className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
            {create.error instanceof ApiError ? create.error.message : "Could not create project."}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || name.trim().length === 0}>
            {create.isPending ? "Creating…" : "Create project"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** States that are still moving, so the badge animates rather than sitting still. */
const TRANSIENT = new Set(["creating", "deleting", "upgrading"]);

function ProjectRow({ project }: { project: Project }) {
  return (
    /*
     * The whole row is the link target, via an overlay anchor rather than an
     * anchor per cell. Making only the name clickable is the kind of thing that
     * is fine the first time and irritating the hundredth.
     */
    <tr className="group relative border-b border-border transition-colors last:border-0 hover:bg-accent-soft/60">
      <td className="relative px-5 py-3.5">
        <Link
          to={`/projects/${project.id}`}
          className="font-medium transition-colors group-hover:text-accent after:absolute after:inset-0 after:content-['']"
        >
          {project.name}
        </Link>
        <div className="mono mt-0.5 text-xs text-content-subtle">{project.ref}</div>
      </td>
      <td className="px-5 py-3.5">
        <Badge tone={projectStateTone(project.state)} dot pulse={TRANSIENT.has(project.state)}>
          {project.state}
        </Badge>
        {project.lastError ? (
          <div className="mt-1 max-w-xs truncate text-xs text-danger" title={project.lastError}>
            {project.lastError}
          </div>
        ) : null}
      </td>
      <td className="px-5 py-3.5 text-content-muted">Postgres {project.pgMajor}</td>
      <td className="px-5 py-3.5 text-content-muted">
        {formatBytes(project.memoryBytes)} · {(project.nanoCpus / 1e9).toFixed(1)} CPU
      </td>
      <td className="mono px-5 py-3.5 text-content-muted">{project.hostPort ?? "—"}</td>
      <td className="px-5 py-3.5 text-content-muted">{relativeTime(project.createdAt)}</td>
      <td className="w-8 pr-4 text-right">
        <span
          aria-hidden
          className="inline-block text-content-subtle opacity-0 transition-opacity group-hover:opacity-100"
        >
          →
        </span>
      </td>
    </tr>
  );
}

export default function ProjectsPage() {
  const [creating, setCreating] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
    // Provisioning takes tens of seconds; poll so the state badge moves from
    // creating to running without the user reloading.
    refetchInterval: 3000,
  });

  const projects = data?.projects ?? [];

  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project is its own Postgres container, with its own volume, credentials and superuser."
        actions={<Button onClick={() => setCreating(true)}>New project</Button>}
      />

      {isLoading ? (
        <Card className="divide-y divide-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4">
              <div className="h-4 w-40 animate-pulse rounded bg-surface-sunken" />
              <div className="h-4 w-20 animate-pulse rounded-full bg-surface-sunken" />
              <div className="ml-auto h-4 w-24 animate-pulse rounded bg-surface-sunken" />
            </div>
          ))}
        </Card>
      ) : error ? (
        <Card className="px-6 py-14 text-center text-sm text-danger">
          {error instanceof ApiError ? error.message : "Could not load projects."}
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Create one and you get a Postgres connection string in about a minute — the first project on a version has to pull the image."
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="border-b border-border bg-surface-overlay text-left text-[11px] uppercase tracking-[0.06em] text-content-subtle">
                <tr>
                  <th className="px-5 py-3 font-semibold">Project</th>
                  <th className="px-5 py-3 font-semibold">State</th>
                  <th className="px-5 py-3 font-semibold">Version</th>
                  <th className="px-5 py-3 font-semibold">Resources</th>
                  <th className="px-5 py-3 font-semibold">Port</th>
                  <th className="px-5 py-3 font-semibold">Created</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <ProjectRow key={project.id} project={project} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {creating ? <CreateProjectModal onClose={() => setCreating(false)} /> : null}
    </>
  );
}
