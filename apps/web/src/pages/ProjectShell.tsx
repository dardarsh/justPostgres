import { Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import ProjectTabs from "../components/ProjectTabs.js";
import { Badge, Card, projectStateTone } from "../components/ui.js";
import { api, ApiError } from "../lib/api.js";
import { Link } from "react-router-dom";

/**
 * Shared chrome for a project: identity, state and the tab bar, so switching
 * between Overview, Data and SQL does not reload the header or lose the sense
 * of which project you are in.
 */
export default function ProjectShell() {
  const { id = "" } = useParams();

  const { data, isLoading, error } = useQuery({
    queryKey: ["project", id],
    queryFn: () => api.getProject(id),
    refetchInterval: 5000,
  });

  if (isLoading) {
    return <Card className="px-6 py-14 text-center text-sm text-content-muted">Loading…</Card>;
  }
  if (error || !data) {
    return (
      <Card className="px-6 py-14 text-center text-sm text-danger">
        {error instanceof ApiError ? error.message : "Could not load this project."}
      </Card>
    );
  }

  const { project } = data;

  return (
    <>
      <div className="mb-2">
        <Link to="/projects" className="text-xs text-content-muted hover:text-content">
          ← Projects
        </Link>
      </div>

      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
        <Badge tone={projectStateTone(project.state)}>{project.state}</Badge>
        <span className="mono text-xs text-content-subtle">
          {project.ref} · Postgres {project.pgMajor}
        </span>
      </div>

      <ProjectTabs />
      <Outlet context={{ project }} />
    </>
  );
}
