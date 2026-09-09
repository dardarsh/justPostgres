/**
 * Cancel-key registry.
 *
 * A CancelRequest arrives as a brand-new connection carrying the backend
 * process id and secret the client was given at startup — it is not sent on the
 * connection being cancelled. That works fine when the client is talking to
 * Postgres directly, and not at all through a proxy, because the router has no
 * idea which backend those numbers belong to.
 *
 * So the router watches BackendKeyData as it passes through and remembers where
 * it came from. Without this, Ctrl-C in psql silently does nothing, which is
 * the sort of small breakage that makes people distrust a pooler entirely.
 */
export interface CancelTarget {
  host: string;
  port: number;
  /** The key to present to the backend, which may differ from the client's. */
  processId: number;
  secretKey: number;
}

export class CancelRegistry {
  private readonly entries = new Map<string, CancelTarget>();

  private static key(processId: number, secretKey: number): string {
    return `${processId >>> 0}:${secretKey >>> 0}`;
  }

  register(clientProcessId: number, clientSecretKey: number, target: CancelTarget): void {
    this.entries.set(CancelRegistry.key(clientProcessId, clientSecretKey), target);
  }

  lookup(processId: number, secretKey: number): CancelTarget | null {
    return this.entries.get(CancelRegistry.key(processId, secretKey)) ?? null;
  }

  unregister(processId: number, secretKey: number): void {
    this.entries.delete(CancelRegistry.key(processId, secretKey));
  }

  get size(): number {
    return this.entries.size;
  }
}
