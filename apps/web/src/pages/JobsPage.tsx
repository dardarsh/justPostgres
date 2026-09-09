import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Job, JobState } from "@justpostgres/shared";
import { api } from "../lib/api.js";
import { Badge, Button, Card, Loading, PageHeader, ProgressBar, relativeTime } from "../components/ui.js";

const STATE_TONE: Record<JobState, "neutral" | "ok" | "warn" | "danger" | "accent"> = {
  queued: "neutral",
  running: "accent",
  succeeded: "ok",
  failed: "danger",
  cancelled: "warn",
};

function JobRow({ job, onCancel }: { job: Job; onCancel: (id: string) => void }) {
  const active = job.state === "running" || job.state === "queued";

  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="px-4 py-3">
        <div className="font-medium">{job.type}</div>
        <div className="mono mt-0.5 text-xs text-content-subtle">{job.id.slice(0, 8)}</div>
      </td>

      <td className="px-4 py-3">
        <Badge tone={STATE_TONE[job.state]}>{job.state}</Badge>
        {job.attempts > 1 ? (
          <div className="mt-1 text-xs text-content-subtle">
            attempt {job.attempts} of {job.maxAttempts}
          </div>
        ) : null}
      </td>

      <td className="w-64 px-4 py-3">
        {job.progress ? (
          <>
            <ProgressBar percent={job.progress.percent} />
            <div className="mt-1.5 text-xs text-content-muted">
              {job.progress.message ?? `${job.progress.percent}%`}
            </div>
          </>
        ) : (
          <span className="text-xs text-content-subtle">—</span>
        )}
        {job.lastError ? (
          <div className="mt-1.5 text-xs text-danger">{job.lastError}</div>
        ) : null}
      </td>

      <td className="px-4 py-3 text-xs text-content-muted">
        <div>created {relativeTime(job.createdAt)}</div>
        {job.finishedAt ? <div>finished {relativeTime(job.finishedAt)}</div> : null}
      </td>

      <td className="px-4 py-3 text-right">
        {active ? (
          <Button variant="danger" onClick={() => onCancel(job.id)}>
            Cancel
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

export default function JobsPage() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api.listJobs(50),
    // Poll while the page is open. Cheap against a local SQLite queue, and it
    // makes checkpointing visible, which is the entire point of this page.
    refetchInterval: 1000,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["jobs"] });

  const enqueue = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.enqueueJob({ type: "noop", payload }),
    onSuccess: invalidate,
  });

  const cancel = useMutation({ mutationFn: api.cancelJob, onSuccess: invalidate });

  const jobs = data?.jobs ?? [];
  const stats = data?.stats;

  return (
    <>
      <PageHeader
        title="Jobs"
        description="Durable queue. Long-running work is checkpointed to the database, so a job survives a control-plane restart and resumes where it stopped."
        actions={
          <>
            <Button
              variant="secondary"
              loading={enqueue.isPending}
              onClick={() => enqueue.mutate({ steps: 20, stepDurationMs: 1500 })}
            >
              Run 30s job
            </Button>
            <Button
              variant="secondary"
              loading={enqueue.isPending}
              onClick={() => enqueue.mutate({ steps: 5, stepDurationMs: 500, failAtStep: 3 })}
            >
              Run failing job
            </Button>
          </>
        }
      />

      {stats ? (
        <div className="mb-4 flex flex-wrap gap-2 text-xs">
          {(Object.entries(stats) as Array<[JobState, number]>).map(([state, count]) => (
            <span
              key={state}
              className="rounded-md border border-border bg-surface-raised px-2.5 py-1 text-content-muted"
            >
              {state} <span className="font-semibold text-content">{count}</span>
            </span>
          ))}
        </div>
      ) : null}

      <Card>
        {isLoading ? (
          <Loading rows={4} />
        ) : jobs.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-sm font-medium">No jobs yet</p>
            <p className="mx-auto mt-2 max-w-lg text-sm text-content-muted">
              Start the 30-second job, then kill the control plane while it runs. On restart it
              picks the job back up from its last checkpoint instead of starting over — the
              property every backup and restore in M4 depends on.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-content-subtle">
              <tr>
                <th className="px-4 py-2.5 font-medium">Job</th>
                <th className="px-4 py-2.5 font-medium">State</th>
                <th className="px-4 py-2.5 font-medium">Progress</th>
                <th className="px-4 py-2.5 font-medium">Timing</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} onCancel={(id) => cancel.mutate(id)} />
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
