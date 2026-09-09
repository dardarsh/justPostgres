import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Modal } from "./ui.js";
import { api, ApiError, type AdminSummary } from "../lib/api.js";

/**
 * Changing the password, from wherever you happen to be.
 *
 * In a modal rather than a page, because rotating a credential is something
 * you do in the middle of something else. Burying it on a settings page means
 * losing your place to get to it.
 */
function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setError(null);
      setDone(true);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    setError(null);
    change.mutate();
  };

  if (done) {
    return (
      <Modal title="Password changed" onClose={onClose}>
        <p className="text-sm leading-relaxed text-content-muted">
          Your new password is in effect. Other browsers signed in as this account stay signed in —
          if you are rotating because the old one leaked, sign out everywhere by resetting from the
          host instead.
        </p>
        <div className="mt-5 flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Change password"
      description="This account holds superuser credentials for every database on this host."
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4">
        <Input
          label="Current password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
        <Input
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />

        {error ? (
          <p role="alert" className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        ) : null}

        <p className="text-xs leading-relaxed text-content-subtle">
          Forgotten it instead? There is no reset link. Recover from the host with{" "}
          <span className="mono">reset-admin</span> — see the install guide. Your projects are not
          affected.
        </p>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={change.isPending} disabled={!current || !next}>
            Change password
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function AccountMenu({ admin }: { admin: AdminSummary }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth"] }),
  });

  // Click-away and Escape. A dropdown that only closes by picking something
  // from it is the kind of thing people describe as "the menu got stuck".
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initial = admin.email.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 text-xs text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
          {initial}
        </span>
        <span className="hidden max-w-[12rem] truncate md:inline">{admin.email}</span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1.5 w-60 overflow-hidden rounded-xl border border-border bg-surface-raised shadow-overlay"
        >
          <div className="border-b border-border px-3 py-2.5">
            <p className="truncate text-xs font-medium" title={admin.email}>
              {admin.email}
            </p>
            <p className="mt-0.5 text-xs text-content-subtle">Administrator</p>
          </div>

          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setChanging(true);
            }}
            className="block w-full px-3 py-2 text-left text-sm text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
          >
            Change password
          </button>

          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              logout.mutate();
            }}
            className="block w-full border-t border-border px-3 py-2 text-left text-sm text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
          >
            Sign out
          </button>
        </div>
      ) : null}

      {changing ? <ChangePasswordModal onClose={() => setChanging(false)} /> : null}
    </div>
  );
}
