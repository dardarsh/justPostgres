import { NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import AccountMenu from "./AccountMenu.js";
import ThemeToggle from "./ThemeToggle.js";
import { Wordmark } from "./ui.js";
import { api, type AdminSummary } from "../lib/api.js";

const NAV = [
  { to: "/projects", label: "Projects" },
  { to: "/jobs", label: "Jobs" },
  { to: "/health", label: "Health" },
  { to: "/instance", label: "Instance" },
];

const STATUS_COLOR = {
  ok: "bg-ok",
  degraded: "bg-warn",
  down: "bg-danger",
  unknown: "bg-content-subtle",
} as const;

const STATUS_LABEL = {
  ok: "All systems normal",
  degraded: "Degraded — see Health",
  down: "Something is down — see Health",
  unknown: "Connecting to the control plane",
} as const;

/**
 * Health, as a dot rather than a word.
 *
 * It was a dot and the word "ok", which spends a third of the header saying
 * the least interesting thing on the page. The dot carries the state, the
 * tooltip carries the detail, and only a problem gets to use words.
 */
function HealthPill({ status }: { status: keyof typeof STATUS_COLOR }) {
  return (
    <NavLink
      to="/health"
      title={STATUS_LABEL[status]}
      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        {status !== "ok" ? (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${STATUS_COLOR[status]}`}
          />
        ) : null}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${STATUS_COLOR[status]}`} />
      </span>
      <span className="sr-only">{STATUS_LABEL[status]}</span>
      {status !== "ok" ? <span className="hidden sm:inline">{status}</span> : null}
    </NavLink>
  );
}

export default function Layout({ admin }: { admin: AdminSummary | null }) {
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 10_000,
  });

  return (
    <div className="min-h-screen">
      {/* Sticky, because the nav is how you get between a project's tabs and
          the rest of the instance, and long tables put it off screen. */}
      <header className="sticky top-0 z-40 border-b border-border bg-surface-overlay/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-6 py-2.5">
          <NavLink to="/projects" className="mr-1 flex items-center" aria-label="justpostgres">
            <Wordmark />
          </NavLink>

          <nav className="flex items-center gap-0.5">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    isActive
                      ? "bg-accent-soft font-medium text-accent"
                      : "text-content-muted hover:bg-surface-sunken hover:text-content"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <HealthPill status={health?.status ?? "unknown"} />
            <ThemeToggle />
            {admin ? <AccountMenu admin={admin} /> : null}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <Outlet />
      </main>

      <footer className="mx-auto max-w-7xl px-6 pb-8 pt-2">
        <p className="text-xs text-content-subtle">
          justpostgres {health?.version ?? ""}
          {health ? ` · up ${Math.floor(health.uptimeSeconds / 3600)}h` : ""}
        </p>
      </footer>
    </div>
  );
}
