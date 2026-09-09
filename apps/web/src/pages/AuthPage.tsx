import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";
import { Button } from "../components/ui.js";

const MIN_PASSWORD_LENGTH = 12;

/**
 * First-run setup and sign-in, in one component because they are the same form
 * with a different verb. Which one renders is decided by the server's auth
 * status, never by the client.
 */
export default function AuthPage({ setupRequired }: { setupRequired: boolean }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () =>
      setupRequired ? api.setup(email, password, setupToken) : api.login(email, password),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth"] }),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setLocalError(null);

    if (setupRequired) {
      if (!setupToken.trim()) {
        setLocalError("The setup token is required. It was printed to the control plane's log.");
        return;
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        setLocalError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (password !== confirm) {
        setLocalError("Passwords do not match.");
        return;
      }
    }
    submit.mutate();
  };

  const serverError =
    submit.error instanceof ApiError ? submit.error.message : submit.error ? "Something went wrong." : null;
  const error = localError ?? serverError;

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mono text-lg font-semibold tracking-tight">justpostgres</div>
          <p className="mt-2 text-sm text-content-muted">
            {setupRequired
              ? "Create the administrator account for this instance."
              : "Sign in to continue."}
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-lg border border-border bg-surface-raised p-6"
        >
          {setupRequired ? (
            <label className="mb-4 block">
              <span className="mb-1.5 block text-xs font-medium text-content-muted">
                Setup token
              </span>
              <input
                required
                autoFocus
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                placeholder="jp_setup_…"
                className="mono w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <span className="mt-1.5 block text-xs text-content-subtle">
                Printed to the control plane's log when it started. Find it with{" "}
                <span className="mono">docker compose logs control-plane | grep jp_setup</span>. It
                proves you are the operator rather than the first stranger to find this page.
              </span>
            </label>
          ) : null}

          <label className="mb-4 block">
            <span className="mb-1.5 block text-xs font-medium text-content-muted">Email</span>
            <input
              type="email"
              required
              autoFocus={!setupRequired}
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-content-muted">Password</span>
            <input
              type="password"
              required
              autoComplete={setupRequired ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </label>

          {setupRequired ? (
            <label className="mt-4 block">
              <span className="mb-1.5 block text-xs font-medium text-content-muted">
                Confirm password
              </span>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <span className="mt-1.5 block text-xs text-content-subtle">
                At least {MIN_PASSWORD_LENGTH} characters. There is no password reset — this
                account is the only way in.
              </span>
            </label>
          ) : null}

          {error ? (
            <p className="mt-4 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
          ) : null}

          <div className="mt-6">
            <Button type="submit" disabled={submit.isPending}>
              {submit.isPending
                ? "Working…"
                : setupRequired
                  ? "Create account"
                  : "Sign in"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
