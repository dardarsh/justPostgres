import { useState, type ReactNode } from "react";
import type { ProjectState } from "@justpostgres/shared";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-content-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-border bg-surface-raised ${className}`}>{children}</div>
  );
}

export function EmptyState({
  title,
  description,
  hint,
}: {
  title: string;
  description: string;
  hint?: ReactNode;
}) {
  return (
    <Card className="px-6 py-14 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-content-muted">{description}</p>
      {hint ? <div className="mt-5 text-sm text-content-subtle">{hint}</div> : null}
    </Card>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const styles = {
    primary: "bg-accent text-accent-content hover:opacity-90",
    secondary: "border border-border-strong text-content hover:bg-surface-sunken",
    danger: "border border-border-strong text-danger hover:bg-surface-sunken",
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

const BADGE_TONES = {
  neutral: "bg-surface-sunken text-content-muted",
  ok: "bg-ok/12 text-ok",
  warn: "bg-warn/12 text-warn",
  danger: "bg-danger/12 text-danger",
  accent: "bg-accent/12 text-accent",
} as const;

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: keyof typeof BADGE_TONES;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-500"
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  );
}

export function relativeTime(epochMs: number | null): string {
  if (!epochMs) return "—";
  const delta = Date.now() - epochMs;
  const abs = Math.abs(delta);
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [1000, "second"],
    [60_000, "minute"],
    [3_600_000, "hour"],
    [86_400_000, "day"],
  ];
  let chosen: [number, Intl.RelativeTimeFormatUnit] = units[0]!;
  for (const unit of units) if (abs >= unit[0]) chosen = unit;
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  return formatter.format(-Math.round(delta / chosen[0]), chosen[1]);
}

export function Input({
  label,
  hint,
  ...props
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-content-muted">{label}</span>
      <input
        {...props}
        className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
      />
      {hint ? <span className="mt-1.5 block text-xs text-content-subtle">{hint}</span> : null}
    </label>
  );
}

export function Select({
  label,
  hint,
  children,
  ...props
}: { label: string; hint?: string } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-content-muted">{label}</span>
      <select
        {...props}
        className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
      >
        {children}
      </select>
      {hint ? <span className="mt-1.5 block text-xs text-content-subtle">{hint}</span> : null}
    </label>
  );
}

export function Modal({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-6 pt-24"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-surface-raised p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-content-muted">{description}</p>
        ) : null}
        <div className="mt-5">{children}</div>
      </div>
    </div>
  );
}

/**
 * Copy to clipboard with visible confirmation.
 *
 * navigator.clipboard is unavailable on insecure origins, which is exactly how
 * a self-hosted control plane is first reached — plain HTTP on a LAN address.
 * Falling back keeps the button honest there instead of silently doing nothing.
 */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const el = document.createElement("textarea");
        el.value = value;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Button variant="secondary" onClick={() => void copy()}>
      {copied ? "Copied" : label}
    </Button>
  );
}

/**
 * Typed against the shared list rather than its own literals, so a new project
 * state is a compile error here instead of a silently grey badge.
 */
const PROJECT_STATE_TONE: Record<ProjectState, "accent" | "ok" | "neutral" | "danger" | "warn"> = {
  creating: "accent",
  running: "ok",
  stopped: "neutral",
  failed: "danger",
  deleting: "warn",
  upgrading: "accent",
};

export function projectStateTone(state: ProjectState) {
  return PROJECT_STATE_TONE[state] ?? "neutral";
}

export function formatBytes(bytes: number): string {
  // Rounding everything to MB made every small table read "0 MB", which looks
  // like a bug rather than a small table.
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
