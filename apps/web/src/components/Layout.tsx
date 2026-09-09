import { NavLink, Outlet } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AdminSummary } from "../lib/api.js";

const NAV = [
  { to: "/projects", label: "Projects" },
  { to: "/jobs", label: "Jobs" },
  { to: "/health", label: "Health" },
  { to: "/instance", label: "Instance" },
];

function StatusDot({ status }: { status: "ok" | "degraded" | "down" | "unknown" }) {
  const color =
    status === "ok"
      ? "bg-ok"
      : status === "degraded"
        ? "bg-warn"
        : status === "down"
          ? "bg-danger"
          : "bg-content-subtle";
  return <span className={`inline-block size-2 rounded-full ${color}`} aria-hidden />;
}

export default function Layout({ admin }: { admin: AdminSummary | null }) {
  const queryClient = useQueryClient();

  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 10_000,
  });

  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth"] }),
  });

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface-raised">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <div className="flex items-baseline gap-2">
            <span className="mono text-sm font-semibold tracking-tight">justpostgres</span>
            <span className="text-xs text-content-subtle">{health?.version ?? ""}</span>
          </div>

          <nav className="flex gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm transition-colors ${
                    isActive
                      ? "bg-surface-sunken font-medium text-content"
                      : "text-content-muted hover:text-content"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-4 text-xs text-content-muted">
            <span className="flex items-center gap-2">
              <StatusDot status={health?.status ?? "unknown"} />
              {health ? health.status : "connecting…"}
            </span>
            {admin ? (
              <span className="flex items-center gap-2">
                <span className="text-content-subtle">{admin.email}</span>
                <button
                  onClick={() => logout.mutate()}
                  className="rounded-md px-2 py-1 hover:bg-surface-sunken hover:text-content"
                >
                  Sign out
                </button>
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
