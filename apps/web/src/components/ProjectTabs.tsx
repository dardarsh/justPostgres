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
    // Scrollable rather than wrapping: eight tabs wrap to two ragged lines on a
    // narrow window, which moves the content down and looks broken.
    <nav className="scroll-thin -mx-1 mb-6 flex gap-0.5 overflow-x-auto border-b border-border px-1">
      {TABS.map((tab) => (
        <NavLink
          key={tab.label}
          to={`/projects/${id}${tab.to}`}
          end={tab.end ?? false}
          className={({ isActive }) =>
            `-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm transition-colors ${
              isActive
                ? "border-accent font-semibold text-accent"
                : "border-transparent text-content-muted hover:border-border-strong hover:text-content"
            }`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
