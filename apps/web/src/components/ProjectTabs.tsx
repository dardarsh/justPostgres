import { NavLink, useParams } from "react-router-dom";

const TABS = [
  { to: "", label: "Overview", end: true },
  { to: "/data", label: "Data" },
  { to: "/sql", label: "SQL" },
  { to: "/backups", label: "Backups" },
  { to: "/branches", label: "Branches" },
  { to: "/extensions", label: "Extensions" },
  { to: "/api", label: "API" },
  { to: "/upgrade", label: "Version" },
];

export default function ProjectTabs() {
  const { id = "" } = useParams();

  return (
    <nav className="mb-4 flex gap-1 border-b border-border">
      {TABS.map((tab) => (
        <NavLink
          key={tab.label}
          to={`/projects/${id}${tab.to}`}
          end={tab.end ?? false}
          className={({ isActive }) =>
            `-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              isActive
                ? "border-accent font-medium text-content"
                : "border-transparent text-content-muted hover:text-content"
            }`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
