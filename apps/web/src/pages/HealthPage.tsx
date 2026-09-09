import { useQuery } from "@tanstack/react-query";
import type { ComponentHealth, ComponentStatus, FilesystemUsage } from "@justpostgres/shared";
import { api } from "../lib/api.js";
import { Badge, Card, PageHeader } from "../components/ui.js";

const TONE: Record<ComponentStatus, "ok" | "warn" | "danger"> = {
  ok: "ok",
  degraded: "warn",
  down: "danger",
};

function ComponentRow({
  name,
  detail,
  health,
}: {
  name: string;
  detail: string;
  health: ComponentHealth;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3.5 last:border-0">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          <Badge tone={TONE[health.status]}>{health.status}</Badge>
        </div>
        <p className="mt-1 text-xs text-content-muted">{detail}</p>
        <p className="mono mt-1 text-xs text-content-subtle">{health.detail}</p>
      </div>
      {health.latencyMs !== undefined ? (
        <span className="mono shrink-0 text-xs text-content-subtle">{health.latencyMs}ms</span>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  const gib = 1024 ** 3;
  return bytes >= gib ? `${(bytes / gib).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * A bar per filesystem, because "87% used" is a number an operator can act on
 * and "degraded" is not. The reserve is drawn as a marker rather than implied:
 * the point at which justpostgres stops accepting new work should be visible
 * before it is reached, not discovered by being refused.
 */
function DiskRow({ fs }: { fs: FilesystemUsage }) {
  const tone = fs.hasHeadroom ? (fs.usedPercent >= 75 ? "bg-warn" : "bg-ok") : "bg-danger";
  return (
    <div className="border-b border-border px-4 py-3.5 last:border-0">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm font-medium">{fs.label}</span>
        <span className="mono text-xs text-content-subtle">
          {formatBytes(fs.freeBytes)} free of {formatBytes(fs.totalBytes)}
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
        <div
          className={`h-full rounded-full ${tone}`}
          style={{ width: `${Math.min(100, Math.max(2, fs.usedPercent))}%` }}
        />
      </div>
      <p className="mono mt-1.5 text-xs text-content-subtle">
        {fs.path} · {fs.usedPercent}% used
        {fs.hasHeadroom ? "" : " · below the reserve, new projects and branches are refused"}
      </p>
    </div>
  );
}

export default function HealthPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 5000,
  });

  return (
    <>
      <PageHeader
        title="Health"
        description="Each dependency is reported independently. The control plane stays up when one of them is down — it has to, because explaining the outage is part of its job."
      />

      {isLoading ? (
        <Card className="px-6 py-14 text-center text-sm text-content-muted">Loading…</Card>
      ) : error || !data ? (
        <Card className="px-6 py-14 text-center text-sm text-danger">
          Could not reach the control plane.
        </Card>
      ) : (
        <>
          <Card className="mb-4 flex items-center justify-between px-4 py-3.5">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Overall</span>
                <Badge tone={TONE[data.status]}>{data.status}</Badge>
              </div>
              <p className="mono mt-1 text-xs text-content-subtle">
                {data.instanceId} · up {Math.floor(data.uptimeSeconds / 60)}m{" "}
                {data.uptimeSeconds % 60}s
              </p>
            </div>
            <span className="mono text-xs text-content-subtle">{data.version}</span>
          </Card>

          <Card>
            <ComponentRow
              name="Database"
              detail="SQLite control-plane metadata. Not the projects' Postgres."
              health={data.components.database}
            />
            <ComponentRow
              name="Docker"
              detail="Container runtime. Reported as degraded, not fatal: the UI works, provisioning does not."
              health={data.components.docker}
            />
            <ComponentRow
              name="Job worker"
              detail="Polls the queue and holds leases on running jobs."
              health={data.components.worker}
            />
            <ComponentRow
              name="Storage"
              detail="Where project data physically lives. Verified at startup, not assumed."
              health={data.components.storage}
            />
            <ComponentRow
              name="Disk"
              detail="A full disk does not slow Postgres down; it stops it. Work that allocates is refused before that happens."
              health={data.components.disk}
            />
          </Card>

          {data.filesystems.length > 0 ? (
            <Card className="mt-4">{data.filesystems.map((fs) => <DiskRow key={fs.path} fs={fs} />)}</Card>
          ) : null}
        </>
      )}
    </>
  );
}
