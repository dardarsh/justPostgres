import Docker from "dockerode";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type {
  ContainerInfo,
  ContainerSpec,
  DockerDriver,
  DockerVersion,
  ExecResult,
  VolumeInfo,
} from "./driver.js";

/**
 * Non-TTY container logs arrive multiplexed: each frame is an 8-byte header
 * followed by its payload. Printing the raw buffer produces stray control
 * characters through the middle of the text.
 */
function stripDockerLogHeaders(raw: Buffer | NodeJS.ReadableStream): string {
  if (!Buffer.isBuffer(raw)) return String(raw);

  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const length = raw.readUInt32BE(offset + 4);
    parts.push(raw.subarray(offset + 8, offset + 8 + length).toString("utf8"));
    offset += 8 + length;
  }
  // A stream that was never multiplexed (TTY mode) has no headers to strip.
  return parts.length > 0 ? parts.join("") : raw.toString("utf8");
}

function toLabelFilter(labels?: Record<string, string>): string | undefined {
  if (!labels) return undefined;
  return JSON.stringify({ label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) });
}

export class DockerodeDriver implements DockerDriver {
  private readonly docker: Docker;

  constructor(config: Config, private readonly logger: Logger) {
    if (config.docker.host) {
      // Preferred in deployment: a socket proxy that allowlists only the
      // endpoints below. The control plane having the raw socket is
      // root-equivalent on the host (ARCHITECTURE §3).
      const url = new URL(config.docker.host);
      this.docker = new Docker({
        host: url.hostname,
        port: Number(url.port || 2375),
        protocol: url.protocol === "https:" ? "https" : "http",
      });
    } else {
      this.docker = new Docker({ socketPath: config.docker.socketPath });
    }
  }

  async ping(): Promise<DockerVersion> {
    const version = await this.docker.version();
    return { serverVersion: version.Version, apiVersion: version.ApiVersion };
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return false;
      throw err;
    }
  }

  async pullImage(image: string, onProgress?: (line: string) => void): Promise<void> {
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (event: { status?: string; progress?: string }) => {
          if (onProgress && event.status) {
            onProgress(event.progress ? `${event.status} ${event.progress}` : event.status);
          }
        },
      );
    });
  }

  async createContainer(spec: ContainerSpec): Promise<string> {
    const portBindings: Record<string, Array<{ HostIp?: string; HostPort: string }>> = {};
    const exposedPorts: Record<string, Record<string, never>> = {};
    for (const [containerPort, hostPort] of Object.entries(spec.ports ?? {})) {
      const key = `${containerPort}/tcp`;
      exposedPorts[key] = {};
      portBindings[key] = [
        {
          ...(spec.portBindAddress ? { HostIp: spec.portBindAddress } : {}),
          HostPort: String(hostPort),
        },
      ];
    }

    const container = await this.docker.createContainer({
      name: spec.name,
      Image: spec.image,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: spec.labels,
      ExposedPorts: exposedPorts,
      ...(spec.command ? { Cmd: spec.command } : {}),
      ...(spec.entrypoint ? { Entrypoint: spec.entrypoint } : {}),
      ...(spec.user ? { User: spec.user } : {}),
      HostConfig: {
        Binds: [
          ...Object.entries(spec.volumes).map(([vol, path]) => `${vol}:${path}`),
          ...Object.entries(spec.readOnlyVolumes ?? {}).map(([vol, path]) => `${vol}:${path}:ro`),
          ...Object.entries(spec.hostBinds ?? {}).map(([host, path]) => `${host}:${path}`),
        ],
        PortBindings: portBindings,
        NetworkMode: spec.network,
        Memory: spec.memoryBytes,
        NanoCpus: spec.nanoCpus,
        // A fork bomb is the one resource exhaustion the memory and CPU limits
        // do not cover, and `COPY ... FROM PROGRAM` makes it reachable by
        // anyone holding superuser on their own project — which is everyone.
        // Docker leaves this unlimited unless asked. Postgres itself needs one
        // process per connection plus its background workers, so the ceiling is
        // generous; it exists to stop a runaway, not to constrain normal use.
        PidsLimit: spec.pidsLimit ?? 512,
        ShmSize: spec.shmBytes ?? 256 * 1024 * 1024,
        RestartPolicy: { Name: spec.restartPolicy ?? "unless-stopped" },
        // Container hardening per ARCHITECTURE §4. The user holds superuser
        // inside their Postgres, which means arbitrary code execution inside
        // the container is a given; the container boundary is what contains it.
        // A privileged helper cannot also drop capabilities; the two settings
        // contradict each other and Docker honours the narrower one.
        ...(spec.privileged
          ? {}
          : {
              SecurityOpt: ["no-new-privileges"],
              CapDrop: ["ALL"],
              CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
            }),
        Privileged: spec.privileged ?? false,
        ReadonlyRootfs: false,
      },
    });

    this.logger.debug({ name: spec.name, id: container.id }, "container created");
    return container.id;
  }

  async startContainer(id: string): Promise<void> {
    await this.docker.getContainer(id).start();
  }

  async stopContainer(id: string, timeoutSeconds = 30): Promise<void> {
    try {
      await this.docker.getContainer(id).stop({ t: timeoutSeconds });
    } catch (err) {
      // 304 means already stopped, which is the state we wanted.
      if ((err as { statusCode?: number }).statusCode !== 304) throw err;
    }
  }

  async removeContainer(id: string, opts: { force?: boolean } = {}): Promise<void> {
    try {
      await this.docker.getContainer(id).remove({ force: opts.force ?? false, v: false });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
  }

  async inspectContainer(id: string): Promise<ContainerInfo | null> {
    try {
      const info = await this.docker.getContainer(id).inspect();
      return {
        id: info.Id,
        name: info.Name.replace(/^\//, ""),
        image: info.Config.Image,
        state: info.State.Status,
        status: info.State.Status,
        running: info.State.Running,
        health: info.State.Health?.Status as ContainerInfo["health"],
        startedAt: info.State.StartedAt ?? null,
        labels: info.Config.Labels ?? {},
      };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw err;
    }
  }

  async listContainers(labelFilter?: Record<string, string>): Promise<ContainerInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: toLabelFilter(labelFilter),
    });
    return containers.map((c) => ({
      id: c.Id,
      name: (c.Names[0] ?? "").replace(/^\//, ""),
      image: c.Image,
      state: c.State,
      status: c.Status,
      running: c.State === "running",
      startedAt: null,
      labels: c.Labels ?? {},
    }));
  }

  async exec(id: string, command: string[], opts: { user?: string } = {}): Promise<ExecResult> {
    const exec = await this.docker.getContainer(id).exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      User: opts.user,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdout = { write: (c: Buffer) => stdoutChunks.push(c) };
    const stderr = { write: (c: Buffer) => stderrChunks.push(c) };

    await new Promise<void>((resolve, reject) => {
      // Docker multiplexes stdout and stderr on one stream; demuxStream splits them.
      this.docker.modem.demuxStream(stream, stdout as never, stderr as never);
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    const inspected = await exec.inspect();
    return {
      exitCode: inspected.ExitCode ?? -1,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    };
  }

  async runToCompletion(
    spec: ContainerSpec,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ exitCode: number; logs: string }> {
    const id = await this.createContainer(spec);
    try {
      await this.startContainer(id);

      const container = this.docker.getContainer(id);
      const timeoutMs = opts.timeoutMs ?? 6 * 3600_000;

      const waited = await Promise.race([
        container.wait(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Container ${spec.name} exceeded ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);

      // Logs are fetched after exit rather than streamed: these containers are
      // short-lived and their whole output is the diagnostic when they fail.
      const raw = await container.logs({ stdout: true, stderr: true, tail: 400 });
      return { exitCode: (waited as { StatusCode: number }).StatusCode, logs: stripDockerLogHeaders(raw) };
    } finally {
      await this.removeContainer(id, { force: true });
    }
  }

  async containerLogs(id: string, tail = 200): Promise<string> {
    try {
      const raw = await this.docker.getContainer(id).logs({ stdout: true, stderr: true, tail });
      return stripDockerLogHeaders(raw);
    } catch {
      return "";
    }
  }

  async createVolume(
    name: string,
    labels: Record<string, string> = {},
    driverOpts?: Record<string, string>,
  ): Promise<VolumeInfo> {
    const volume = await this.docker.createVolume({
      Name: name,
      Labels: labels,
      ...(driverOpts ? { DriverOpts: driverOpts } : {}),
    });
    return {
      name: volume.Name,
      mountpoint: volume.Mountpoint,
      labels: volume.Labels ?? {},
    };
  }

  async removeVolume(name: string, opts: { force?: boolean } = {}): Promise<void> {
    try {
      await this.docker.getVolume(name).remove({ force: opts.force ?? false });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
  }

  async listVolumes(labelFilter?: Record<string, string>): Promise<VolumeInfo[]> {
    const result = await this.docker.listVolumes({ filters: toLabelFilter(labelFilter) });
    return (result.Volumes ?? []).map((v) => ({
      name: v.Name,
      mountpoint: v.Mountpoint,
      labels: v.Labels ?? {},
    }));
  }

  async createNetwork(name: string, labels: Record<string, string> = {}): Promise<string> {
    try {
      const network = await this.docker.createNetwork({
        Name: name,
        Driver: "bridge",
        Labels: labels,
      });
      return network.id;
    } catch (err) {
      // 409 means it already exists, which is the state we wanted. Provisioning
      // jobs resume from a checkpoint and may re-run a step, so every create in
      // this driver has to be idempotent.
      if ((err as { statusCode?: number }).statusCode !== 409) throw err;
      const existing = await this.docker.getNetwork(name).inspect();
      return existing.Id;
    }
  }

  async removeNetwork(name: string): Promise<void> {
    try {
      await this.docker.getNetwork(name).remove();
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
  }
}
