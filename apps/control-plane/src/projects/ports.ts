import { createServer } from "node:net";
import { and, isNotNull, isNull } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { apiConfigs, projects } from "../db/schema.js";

/** Is this port actually bindable on the host right now? */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "0.0.0.0");
  });
}

export class NoPortsAvailableError extends Error {
  constructor(start: number, end: number) {
    super(
      `No free host port in ${start}-${end}. Widen JP_PORT_RANGE_START/END or delete unused projects.`,
    );
    this.name = "NoPortsAvailableError";
  }
}

/**
 * Reserve a host port for a project.
 *
 * Two checks, because either alone is wrong: the database knows which ports
 * other projects own even while their containers are stopped, and a bind test
 * catches ports taken by something else on the host entirely.
 *
 * This whole mechanism is routing mode 3 from ARCHITECTURE §5 — the fallback
 * that makes the product work before the router lands in M2. Once it does,
 * most projects will stop publishing a host port at all.
 */
export async function allocateHostPort(db: Db, config: Config): Promise<number> {
  // Both kinds of published port come from the same range, so both have to be
  // considered — otherwise a project and a REST container can be handed the
  // same number and the second one fails to start.
  const taken = new Set<number>([
    ...db
      .select({ port: projects.hostPort })
      .from(projects)
      .where(and(isNull(projects.deletedAt), isNotNull(projects.hostPort)))
      .all()
      .map((r) => r.port as number),
    ...db
      .select({ port: apiConfigs.hostPort })
      .from(apiConfigs)
      .where(isNotNull(apiConfigs.hostPort))
      .all()
      .map((r) => r.port as number),
  ]);

  const { start, end } = config.portRange;
  // Start at a random offset so consecutive create-then-delete cycles do not
  // keep handing out the same port to different projects.
  const span = end - start + 1;
  const offset = Math.floor(Math.random() * span);

  for (let i = 0; i < span; i++) {
    const port = start + ((offset + i) % span);
    if (taken.has(port)) continue;
    if (await isPortFree(port)) return port;
  }

  throw new NoPortsAvailableError(start, end);
}
