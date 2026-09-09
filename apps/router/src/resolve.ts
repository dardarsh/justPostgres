import type { RouterConfig } from "./config.js";
import type { Route, RouteStore } from "./routes.js";

export type RoutingMode = "sni" | "username";

export interface Resolution {
  route: Route;
  mode: RoutingMode;
  /** The role to present to the backend, with any routing suffix stripped. */
  role: string;
}

export class RoutingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "RoutingError";
  }
}

/**
 * Work out which project a connection is for.
 *
 * Two mechanisms, in preference order, because self-hosted deployments differ
 * enormously in what DNS and TLS they have:
 *
 *  1. **SNI** — `<ref>.db.example.com`. Clean, standard, and every project gets
 *     its own hostname. libpq has sent SNI by default since PG 14. Needs a
 *     wildcard certificate and wildcard DNS.
 *  2. **Username prefix** — `<role>.<ref>`, the convention Supabase and
 *     Supavisor use. Works with no TLS, no wildcard DNS and old clients.
 *
 * There is a third mode in the design — per-project published ports — but it
 * needs no code here: it is what you get by connecting to the container's own
 * port and not involving the router at all. That is also the router's own path
 * to the backend today.
 *
 * Neither input is trusted. The ref extracted from a hostname or a username is
 * only ever a lookup key; the route store is what decides whether it names a
 * real project. That matters especially for the username: the client holds
 * superuser on its own database and can create a role called anything it likes.
 */
export function resolveRoute(
  store: RouteStore,
  config: RouterConfig,
  opts: { servername: string | null; parameters: Record<string, string> },
): Resolution {
  const user = opts.parameters["user"];
  if (!user) {
    throw new RoutingError("08P01", "Startup packet did not include a user parameter.");
  }

  // --- mode 1: SNI ---
  if (opts.servername && config.domainSuffix) {
    const suffix = `.${config.domainSuffix.replace(/^\./, "")}`;
    if (opts.servername.endsWith(suffix)) {
      const ref = opts.servername.slice(0, -suffix.length);
      const route = store.lookup(ref);
      if (!route) {
        throw new RoutingError(
          "3D000",
          `No project matches the hostname "${opts.servername}".`,
          "Check the project ref in the hostname, or that the project still exists.",
        );
      }
      assertRoutable(route);
      return { route, mode: "sni", role: user };
    }
  }

  // --- mode 2: username prefix ---
  // Split on the last dot so a role containing a dot still works.
  const lastDot = user.lastIndexOf(".");
  if (lastDot > 0 && lastDot < user.length - 1) {
    const ref = user.slice(lastDot + 1);
    const route = store.lookup(ref);
    if (route) {
      assertRoutable(route);
      return { route, mode: "username", role: user.slice(0, lastDot) };
    }
  }

  throw new RoutingError(
    "3D000",
    `Could not determine which project "${user}" refers to.`,
    config.domainSuffix
      ? `Connect to <project-ref>.${config.domainSuffix}, or use the username form <role>.<project-ref>.`
      : "Use the username form <role>.<project-ref>, for example postgres.abc123def456.",
  );
}

function assertRoutable(route: Route): void {
  if (route.state === "running") return;

  const explanation: Record<string, string> = {
    creating: "The project is still being provisioned.",
    stopped: "The project is stopped. Start it from the control plane.",
    failed: "The project failed to start. Check the control plane for the error.",
    deleting: "The project is being deleted.",
  };

  throw new RoutingError(
    "57P03", // cannot_connect_now
    `Project "${route.name}" is not accepting connections (${route.state}).`,
    explanation[route.state],
  );
}
