import { eq } from "drizzle-orm";
import type {
  ObjectStorageInput,
  ObjectStorageSettings,
  StorageProvider,
  StorageTestResult,
} from "@justpostgres/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { settings } from "../db/schema.js";
import type { DockerDriver } from "../docker/driver.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import type { Logger } from "../logger.js";
import type { RepoSpec } from "./pgbackrest.js";

/**
 * Object storage for backups, configured from the UI rather than the
 * environment.
 *
 * Backups that live on the same disk as the database they protect are not
 * really backups: they survive a dropped table, and nothing else. The host
 * dying, the disk filling, the volume being deleted — all of those take the
 * database and its backups together. Getting them off the box is the single
 * biggest improvement available to a self-hosted install, and it was previously
 * gated behind restarting the control plane with the right environment
 * variables set, which meant almost nobody would do it.
 *
 * Three providers rather than one generic S3 form. The fields are the same
 * underneath; what differs is what a person has to know. R2 wants a region of
 * `auto`, path-style URIs, and an endpoint built from an account id that is not
 * the same as the bucket name — three chances to get it silently wrong, and
 * "silently" is the problem, because a misconfigured repository looks fine
 * until a backup runs.
 */

const STORAGE_KEY = "object_storage";

interface StoredSettings {
  provider: StorageProvider;
  bucket: string;
  prefix: string;
  region: string;
  endpoint: string | null;
  port: number | null;
  accountId: string | null;
  uriStyle: "host" | "path";
  verifyTls: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  updatedAt: number;
  lastTest: StorageTestResult | null;
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

export class ObjectStorageService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly docker: DockerDriver,
    private readonly logger: Logger,
    private readonly probeImage: string,
  ) {}

  /** The stored settings, secret included. Internal callers only. */
  private read(): StoredSettings | null {
    const row = this.db.select().from(settings).where(eq(settings.key, STORAGE_KEY)).get();
    if (!row) return null;
    try {
      return JSON.parse(decryptSecret(row.value, this.config.masterKey)) as StoredSettings;
    } catch (err) {
      // Almost always a changed JP_MASTER_KEY. Saying so beats "unexpected
      // token in JSON", which sends people looking in the wrong place.
      this.logger.error(
        { err },
        "stored object-storage settings could not be decrypted; JP_MASTER_KEY has probably changed",
      );
      return null;
    }
  }

  /** Configured and usable, so new projects should back up here. */
  isConfigured(): boolean {
    return this.read() !== null;
  }

  /** What the UI sees. Never includes the secret. */
  status(): ObjectStorageSettings | null {
    const stored = this.read();
    if (!stored) return null;
    const { secretAccessKey, ...rest } = stored;
    return { ...rest, secretAccessKeySet: Boolean(secretAccessKey) };
  }

  /**
   * Save, after normalising whatever the provider actually needs.
   *
   * The normalisation is the point. An operator setting up R2 supplies an
   * account id and a bucket; everything else — the endpoint hostname, the
   * `auto` region, path-style URIs — is knowledge they should not have to have,
   * and each piece of it is a way for backups to fail quietly.
   */
  save(input: ObjectStorageInput): ObjectStorageSettings {
    const existing = this.read();

    const secretAccessKey = input.secretAccessKey?.trim() || existing?.secretAccessKey;
    if (!secretAccessKey) {
      throw new StorageError("A secret access key is required.");
    }
    if (!input.bucket.trim()) throw new StorageError("A bucket name is required.");
    if (!input.accessKeyId.trim()) throw new StorageError("An access key id is required.");

    const normalised = normalise(input, secretAccessKey);
    const now = Date.now();

    const value = encryptSecret(
      JSON.stringify({ ...normalised, updatedAt: now, lastTest: null } satisfies StoredSettings),
      this.config.masterKey,
    );

    this.db
      .insert(settings)
      .values({ key: STORAGE_KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run();

    this.logger.info(
      { provider: normalised.provider, bucket: normalised.bucket, endpoint: normalised.endpoint },
      "object storage configured",
    );

    return this.status()!;
  }

  /** Forget the settings. New projects go back to a local repository. */
  clear(): void {
    this.db.delete(settings).where(eq(settings.key, STORAGE_KEY)).run();
    this.logger.warn("object storage settings removed; new projects will back up to local disk");
  }

  /**
   * The repository a project should use.
   *
   * A prefix per project, so one project's retention can never expire
   * another's — the same rule the local repositories follow by having a volume
   * each.
   */
  repoSpecFor(ref: string): RepoSpec | null {
    const stored = this.read();
    if (!stored) return null;

    return {
      type: "s3",
      path: `/${[stored.prefix.replace(/^\/+|\/+$/g, ""), ref].filter(Boolean).join("/")}`,
      s3: {
        bucket: stored.bucket,
        region: stored.region,
        key: stored.accessKeyId,
        secret: stored.secretAccessKey,
        uriStyle: stored.uriStyle,
        verifyTls: stored.verifyTls,
        ...(stored.endpoint ? { endpoint: stored.endpoint } : {}),
        ...(stored.port ? { port: stored.port } : {}),
      },
    };
  }

  /**
   * Prove the settings work, before anything depends on them.
   *
   * `repo-ls` against the bucket exercises the endpoint, the region (SigV4
   * signs with it, so a wrong region fails), the credentials and the bucket
   * name. It does not prove write access — pgBackRest has no command that
   * writes an arbitrary object — which is why the UI says so and why moving a
   * project to object storage takes an immediate full backup rather than
   * waiting for the schedule.
   *
   * Tested against `input` when given, so a person can check settings before
   * committing them, rather than saving something broken and finding out later.
   */
  async test(input?: ObjectStorageInput): Promise<StorageTestResult> {
    let spec: RepoSpec | null;

    if (input) {
      const existing = this.read();
      const secret = input.secretAccessKey?.trim() || existing?.secretAccessKey;
      if (!secret) {
        return { ok: false, detail: "No secret access key to test with.", at: Date.now() };
      }
      const normalised = normalise(input, secret);
      spec = {
        type: "s3",
        path: `/${normalised.prefix.replace(/^\/+|\/+$/g, "")}`,
        s3: {
          bucket: normalised.bucket,
          region: normalised.region,
          key: normalised.accessKeyId,
          secret: normalised.secretAccessKey,
          uriStyle: normalised.uriStyle,
          verifyTls: normalised.verifyTls,
          ...(normalised.endpoint ? { endpoint: normalised.endpoint } : {}),
          ...(normalised.port ? { port: normalised.port } : {}),
        },
      };
    } else {
      spec = this.repoSpecFor("connection-test");
    }

    if (!spec?.s3) {
      return { ok: false, detail: "Object storage is not configured.", at: Date.now() };
    }

    const s3 = spec.s3;
    const env: Record<string, string> = {
      PGBACKREST_REPO1_TYPE: "s3",
      PGBACKREST_REPO1_PATH: spec.path,
      PGBACKREST_REPO1_S3_BUCKET: s3.bucket,
      PGBACKREST_REPO1_S3_REGION: s3.region,
      PGBACKREST_REPO1_S3_KEY: s3.key,
      PGBACKREST_REPO1_S3_KEY_SECRET: s3.secret,
      PGBACKREST_REPO1_S3_URI_STYLE: s3.uriStyle,
      PGBACKREST_LOCK_PATH: "/tmp/pgbackrest",
      PGBACKREST_LOG_LEVEL_FILE: "off",
      PGBACKREST_LOG_LEVEL_CONSOLE: "info",
      ...(s3.endpoint ? { PGBACKREST_REPO1_S3_ENDPOINT: s3.endpoint } : {}),
      ...(s3.port ? { PGBACKREST_REPO1_STORAGE_PORT: String(s3.port) } : {}),
      ...(s3.verifyTls ? {} : { PGBACKREST_REPO1_STORAGE_VERIFY_TLS: "n" }),
    };

    const outcome = await this.docker
      .runToCompletion(
        {
          name: `jp-storage-test-${Date.now().toString(36)}`,
          image: this.probeImage,
          entrypoint: ["pgbackrest"],
          command: ["repo-ls", "--stanza=connection-test"],
          env,
          labels: { "io.justpostgres.managed": "true", "io.justpostgres.role": "storage-test" },
          volumes: {},
          user: "postgres",
          memoryBytes: 128 * 1024 * 1024,
          nanoCpus: 5e8,
          restartPolicy: "no",
        },
        { timeoutMs: 90_000 },
      )
      .catch((err) => ({ exitCode: -1, logs: err instanceof Error ? err.message : String(err) }));

    const result: StorageTestResult = {
      ok: outcome.exitCode === 0,
      detail:
        outcome.exitCode === 0
          ? `Reached ${s3.bucket}${s3.endpoint ? ` at ${s3.endpoint}` : ""} and listed it. ` +
            `Write access is confirmed by the first backup.`
          : explain(outcome.logs, s3),
      at: Date.now(),
    };

    // Recorded so the UI can show it later without re-running a container.
    const stored = this.read();
    if (stored) {
      const value = encryptSecret(
        JSON.stringify({ ...stored, lastTest: result } satisfies StoredSettings),
        this.config.masterKey,
      );
      this.db.update(settings).set({ value }).where(eq(settings.key, STORAGE_KEY)).run();
    }

    if (!result.ok) this.logger.warn({ detail: result.detail }, "object storage test failed");
    return result;
  }
}

/**
 * Fill in what each provider implies.
 *
 * Everything here is a thing that would otherwise be a support question.
 */
function normalise(
  input: ObjectStorageInput,
  secretAccessKey: string,
): Omit<StoredSettings, "updatedAt" | "lastTest"> {
  const base = {
    bucket: input.bucket.trim(),
    prefix: (input.prefix ?? "").trim().replace(/^\/+|\/+$/g, ""),
    accessKeyId: input.accessKeyId.trim(),
    secretAccessKey,
  };

  switch (input.provider) {
    case "r2": {
      const accountId = (input.accountId ?? "").trim();
      if (!accountId) {
        throw new StorageError(
          "R2 needs your Cloudflare account id. It is in the R2 sidebar, and it is not the bucket name.",
        );
      }
      return {
        ...base,
        provider: "r2",
        accountId,
        // R2 has one endpoint shape, ignores the region beyond SigV4 signing
        // (where it must be `auto`), and does not do virtual-host style for
        // arbitrary bucket names. None of these are choices.
        endpoint: `${accountId}.r2.cloudflarestorage.com`,
        port: null,
        region: "auto",
        uriStyle: "path",
        verifyTls: true,
      };
    }

    case "s3":
      return {
        ...base,
        provider: "s3",
        accountId: null,
        // Left unset so pgBackRest builds s3.<region>.amazonaws.com itself,
        // which is right more often than anything a person types.
        endpoint: (input.endpoint ?? "").trim() || null,
        port: null,
        region: (input.region ?? "").trim() || "us-east-1",
        uriStyle: "host",
        verifyTls: true,
      };

    default: {
      const endpoint = (input.endpoint ?? "").trim();
      if (!endpoint) {
        throw new StorageError("An S3-compatible endpoint is required, e.g. minio.example.com.");
      }
      return {
        ...base,
        provider: "s3_compatible",
        accountId: null,
        // Accepts a pasted URL and keeps the host, because everyone pastes the
        // URL. The port comes with it if there is one.
        endpoint: endpoint.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, ""),
        port: input.port ?? portFromUrl(endpoint),
        region: (input.region ?? "").trim() || "us-east-1",
        // Path style by default: it is what self-hosted gateways support, and
        // virtual-host style needs wildcard DNS for the bucket.
        uriStyle: input.uriStyle ?? "path",
        verifyTls: input.verifyTls ?? true,
      };
    }
  }
}

function portFromUrl(endpoint: string): number | null {
  const match = /:(\d+)(?:\/|$)/.exec(endpoint.replace(/^https?:\/\//, ""));
  return match ? Number(match[1]) : null;
}

/**
 * Turn pgBackRest's output into the thing that is actually wrong.
 *
 * The raw errors are accurate and useless: "unable to open" for a bad bucket
 * name reads identically to a network problem, and a wrong region produces a
 * signature error that mentions neither the region nor the signature.
 */
function explain(logs: string, s3: { bucket: string; region: string; endpoint?: string }): string {
  const text = logs.slice(-1500);
  const tail = text.split("\n").filter(Boolean).slice(-3).join(" / ");

  if (/SignatureDoesNotMatch|signature/i.test(text)) {
    return `The endpoint rejected the request signature. The secret key is wrong, or the region is — SigV4 signs with the region, so "${s3.region}" has to be what the provider expects (R2 wants "auto").`;
  }
  if (/InvalidAccessKeyId|access key/i.test(text)) {
    return "The endpoint does not recognise that access key id.";
  }
  if (/AccessDenied|403/i.test(text)) {
    return `The credentials were accepted but are not allowed to read ${s3.bucket}. The token needs object read and write on this bucket.`;
  }
  if (/NoSuchBucket|404/i.test(text)) {
    return `No bucket named ${s3.bucket} at that endpoint. Check the name, and that the token belongs to the same account.`;
  }
  if (/unable to resolve|Name or service not known|getaddrinfo/i.test(text)) {
    return `Could not resolve ${s3.endpoint ?? "the endpoint"}. Give a hostname without the https:// prefix.`;
  }
  if (/timeout|timed out|Connection refused/i.test(text)) {
    return `Could not reach ${s3.endpoint ?? "the endpoint"}. Check the host, the port, and that this machine is allowed out.`;
  }
  // Checked before the general TLS case: this specific error means the port
  // answered but did not speak TLS at all, which is a different mistake from a
  // certificate being rejected and has a different fix.
  if (/wrong version number|record layer|unknown protocol/i.test(text)) {
    return (
      `${s3.endpoint ?? "The endpoint"} answered, but not with TLS. pgBackRest always speaks HTTPS ` +
      `to object storage — there is no plaintext mode — so a self-hosted endpoint has to have a ` +
      `certificate, even a self-signed one with verification turned off. Check the port too: ` +
      `plaintext services are usually on a different one.`
    );
  }
  if (/certificate|SSL|TLS/i.test(text)) {
    return "The TLS certificate was rejected. For a self-hosted endpoint with a private certificate, turn off certificate verification.";
  }
  return `pgBackRest could not use this repository: ${tail}`;
}
