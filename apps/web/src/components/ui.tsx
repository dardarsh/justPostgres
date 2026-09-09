import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ProjectState } from "@justpostgres/shared";

/**
 * The mark, at a size the layout asks for.
 *
 * Two source files rather than one scaled down: the nav renders it at 28px and
 * a 256px PNG scaled that far is both wasteful and slightly mushy. The browser
 * picks by intrinsic size, so the small file is used where it fits.
 */
export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <img
      src={size > 96 ? "/logo.png" : "/logo-128.png"}
      alt=""
      width={size}
      height={size}
      className={`shrink-0 select-none ${className}`}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}

/** The mark and the name, as they appear together. */
export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <Logo size={size} />
      <span className="text-[15px] font-semibold tracking-tight">
        just<span className="text-accent">postgres</span>
      </span>
    </span>
  );
}

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
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
        {description ? (
          <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-content-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-border bg-surface-raised shadow-card ${className}`}
    >
      {children}
    </div>
  );
}

/** A titled section of a card, so pages stop hand-rolling the same header row. */
export function CardHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-content-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
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
    <Card className="px-6 py-16 text-center">
      <Logo size={40} className="mx-auto opacity-40" />
      <p className="mt-4 text-sm font-semibold">{title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-content-muted">
        {description}
      </p>
      {hint ? <div className="mt-6 text-sm text-content-subtle">{hint}</div> : null}
    </Card>
  );
}

/** A small inline spinner, so a pending button says so without changing width. */
export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-3.5 w-3.5 animate-spin ${className}`}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path
        d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Loading, as shape rather than a word.
 *
 * Every page said "Loading…", which tells you nothing about what is coming and
 * makes the content jump when it arrives. Skeleton rows hold the space and
 * imply the structure.
 */
export function Loading({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  return (
    <Card className={`divide-y divide-border ${className}`} >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <div className="h-4 w-40 animate-pulse rounded bg-surface-sunken" />
          <div className="h-4 w-24 animate-pulse rounded bg-surface-sunken" />
          <div className="ml-auto h-4 w-20 animate-pulse rounded bg-surface-sunken" />
        </div>
      ))}
      <span className="sr-only">Loading</span>
    </Card>
  );
}

/** A failed fetch, said once and consistently. */
export function ErrorState({ message }: { message: string }) {
  return (
    <Card className="border-danger/30 px-6 py-12 text-center">
      <p className="text-sm font-medium text-danger">Could not load this</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-content-muted">{message}</p>
    </Card>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  size = "md",
  disabled,
  loading,
  type = "button",
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  disabled?: boolean;
  /** Shows a spinner and blocks the click, without the caller disabling it. */
  loading?: boolean;
  type?: "button" | "submit";
  title?: string;
  className?: string;
}) {
  const styles = {
    primary: "bg-accent text-accent-content hover:bg-accent-hover shadow-card",
    secondary: "border border-border-strong bg-surface-raised text-content hover:bg-surface-sunken",
    danger: "border border-danger/35 bg-surface-raised text-danger hover:bg-danger/10",
    ghost: "text-content-muted hover:bg-surface-sunken hover:text-content",
  }[variant];

  const sizing = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm";

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 ${sizing} ${styles} ${className}`}
    >
      {loading ? <Spinner /> : null}
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

const BADGE_DOTS = {
  neutral: "bg-content-subtle",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  accent: "bg-accent",
} as const;

export function Badge({
  children,
  tone = "neutral",
  dot = false,
  pulse = false,
}: {
  children: ReactNode;
  tone?: keyof typeof BADGE_TONES;
  /** A coloured dot before the label, for states rather than counts. */
  dot?: boolean;
  /** Animates the dot, for states that are actively changing. */
  pulse?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_TONES[tone]}`}
    >
      {dot ? (
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${BADGE_DOTS[tone]} ${pulse ? "animate-pulse" : ""}`}
        />
      ) : null}
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
        className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm transition-colors placeholder:text-content-subtle hover:border-content-subtle focus:border-accent"
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
        className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm transition-colors hover:border-content-subtle focus:border-accent"
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
  wide = false,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  // Escape closes it, and the page behind stops scrolling while it is open.
  // Both are things people try without thinking, and their absence reads as
  // the dialog being broken rather than unimplemented.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  /*
   * Rendered into document.body rather than in place.
   *
   * `position: fixed` is relative to the nearest ancestor with a transform,
   * filter or backdrop-filter — not to the viewport. The header uses
   * backdrop-blur, so a modal opened from the account menu was being clipped
   * to the height of the header. A portal is the only reliable fix; moving the
   * blur would just relocate the trap.
   */
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 p-6 pt-20 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className={`w-full ${wide ? "max-w-2xl" : "max-w-md"} rounded-xl border border-border bg-surface-raised p-6 shadow-overlay`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="mt-1.5 text-sm leading-relaxed text-content-muted">{description}</p>
        ) : null}
        <div className="mt-5">{children}</div>
      </div>
    </div>,
    document.body,
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
