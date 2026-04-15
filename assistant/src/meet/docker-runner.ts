/**
 * DockerRunner — thin typed wrapper over the Docker Engine HTTP API exposed
 * via the unix socket at `/var/run/docker.sock`.
 *
 * Used by `MeetSessionManager` to spawn per-meeting Meet-bot containers. The
 * CLI (`cli/src/lib/docker.ts`) drives Docker via the `docker` binary for
 * service orchestration; that pattern is not reused here because the runner
 * lives inside the assistant process where shelling out to `docker` adds a
 * dependency on the host PATH, forks an extra process per call, and blocks
 * on stdio. The HTTP-socket API keeps everything in-process, returns
 * structured JSON, and avoids the PATH/CLI surface entirely. See
 * `cli/src/lib/docker.ts` for the broader service container lifecycle.
 */

import { request as httpRequest } from "node:http";

import { getLogger } from "../util/logger.js";

const log = getLogger("meet-docker-runner");

/** Path to the Docker Engine unix socket. */
export const DEFAULT_DOCKER_SOCKET_PATH = "/var/run/docker.sock";

/** Docker Engine API version used in request paths. */
const DOCKER_API_VERSION = "v1.43";

/** Host for unix-socket HTTP requests (ignored by the socket transport). */
const UNIX_SOCKET_HOST = "localhost";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Describes an ephemeral host-port binding captured after container start. */
export interface BoundPort {
  /** Protocol — typically `"tcp"`. */
  protocol: "tcp" | "udp";
  /** Container-internal port (e.g. `3000`). */
  containerPort: number;
  /** Host interface the port was bound to (e.g. `"127.0.0.1"`). */
  hostIp: string;
  /** Host-side port chosen by the Docker daemon when the spec used port 0. */
  hostPort: number;
}

/** A single port mapping request passed to `run`. */
export interface PortMapping {
  /** Host interface to bind to (e.g. `"127.0.0.1"`). */
  hostIp: string;
  /** Host port — use `0` to let Docker assign an ephemeral port. */
  hostPort: number;
  /** Container-internal port. */
  containerPort: number;
  /** Protocol — defaults to `"tcp"` when omitted. */
  protocol?: "tcp" | "udp";
}

/** A single bind mount request passed to `run`. */
export interface BindMount {
  hostPath: string;
  containerPath: string;
  /** Whether the mount is read-only. Defaults to `false`. */
  readOnly?: boolean;
}

/** Options for creating + starting a container. */
export interface DockerRunOptions {
  image: string;
  env?: Record<string, string>;
  binds?: BindMount[];
  ports?: PortMapping[];
  name?: string;
  network?: string;
  /** Extra HostConfig overrides — applied after standard fields. Use sparingly. */
  hostConfigExtras?: Record<string, unknown>;
}

/** Minimal shape of the Docker `containers/<id>/json` response we rely on. */
export interface ContainerInspect {
  Id: string;
  State?: {
    Status?: string;
    Running?: boolean;
    ExitCode?: number;
  };
  NetworkSettings?: {
    Ports?: Record<
      string,
      Array<{ HostIp?: string; HostPort?: string }> | null
    >;
  };
  [key: string]: unknown;
}

/** Result of a successful `run`. */
export interface DockerRunResult {
  containerId: string;
  boundPorts: BoundPort[];
}

// ---------------------------------------------------------------------------
// DockerRunner
// ---------------------------------------------------------------------------

export interface DockerRunnerOptions {
  /** Override the unix socket path. Primarily used in tests. */
  socketPath?: string;
}

/**
 * Error thrown when the Docker Engine returns a non-2xx response. The
 * original status and body are preserved for diagnostics.
 */
export class DockerApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(method: string, path: string, status: number, body: string) {
    super(
      `Docker API ${method} ${path} failed (${status}): ${body.slice(0, 300)}`,
    );
    this.name = "DockerApiError";
    this.status = status;
    this.body = body;
  }
}

export class DockerRunner {
  readonly socketPath: string;

  constructor(options: DockerRunnerOptions = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_DOCKER_SOCKET_PATH;
  }

  /**
   * Create + start a container. Returns the containerId and any host-side
   * ports Docker bound after start.
   */
  async run(opts: DockerRunOptions): Promise<DockerRunResult> {
    const createBody = buildCreateBody(opts);
    const createPath = opts.name
      ? `/${DOCKER_API_VERSION}/containers/create?name=${encodeURIComponent(opts.name)}`
      : `/${DOCKER_API_VERSION}/containers/create`;

    const createResp = await this.request<{ Id: string; Warnings?: string[] }>(
      "POST",
      createPath,
      createBody,
    );
    const containerId = createResp.Id;
    log.info({ containerId, image: opts.image }, "Created container");

    try {
      await this.request<void>(
        "POST",
        `/${DOCKER_API_VERSION}/containers/${containerId}/start`,
        null,
      );
    } catch (err) {
      // Best-effort cleanup so we don't leak a created-but-never-started
      // container if start fails (e.g. image pull needed, bind failure).
      log.warn(
        { err, containerId },
        "Container start failed; attempting cleanup",
      );
      await this.remove(containerId).catch(() => {});
      throw err;
    }

    const inspection = await this.inspect(containerId);
    const boundPorts = extractBoundPorts(inspection);
    return { containerId, boundPorts };
  }

  /** Stop a running container. Wraps `POST /containers/<id>/stop`. */
  async stop(containerId: string, timeoutSec = 10): Promise<void> {
    const path = `/${DOCKER_API_VERSION}/containers/${containerId}/stop?t=${timeoutSec}`;
    try {
      await this.request<void>("POST", path, null);
    } catch (err) {
      // 304 means "already stopped" — not an error for our purposes.
      if (err instanceof DockerApiError && err.status === 304) return;
      throw err;
    }
  }

  /** Force-remove a container. Wraps `DELETE /containers/<id>?force=true`. */
  async remove(containerId: string): Promise<void> {
    const path = `/${DOCKER_API_VERSION}/containers/${containerId}?force=true&v=true`;
    try {
      await this.request<void>("DELETE", path, null);
    } catch (err) {
      // 404 means "already gone" — not an error for our purposes.
      if (err instanceof DockerApiError && err.status === 404) return;
      throw err;
    }
  }

  /** Inspect a container. Wraps `GET /containers/<id>/json`. */
  async inspect(containerId: string): Promise<ContainerInspect> {
    return this.request<ContainerInspect>(
      "GET",
      `/${DOCKER_API_VERSION}/containers/${containerId}/json`,
      null,
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Issue a unix-socket HTTP request and decode the JSON body, if any. */
  private request<T>(
    method: string,
    path: string,
    body: unknown,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const payload =
        body === null || body === undefined ? null : JSON.stringify(body);

      const headers: Record<string, string | number> = {
        Host: UNIX_SOCKET_HOST,
        Accept: "application/json",
      };
      if (payload !== null) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }

      const req = httpRequest(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new DockerApiError(method, path, status, raw));
              return;
            }
            if (!raw) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(raw) as T);
            } catch (err) {
              reject(
                new Error(
                  `Failed to parse Docker API JSON response for ${method} ${path}: ${String(err)}`,
                ),
              );
            }
          });
        },
      );

      req.on("error", (err) => reject(err));
      if (payload !== null) req.write(payload);
      req.end();
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Translate the high-level `DockerRunOptions` into the JSON body the Docker
 * Engine's `/containers/create` endpoint expects.
 */
export function buildCreateBody(
  opts: DockerRunOptions,
): Record<string, unknown> {
  const env = opts.env
    ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
    : [];
  const binds = (opts.binds ?? []).map((b) =>
    b.readOnly
      ? `${b.hostPath}:${b.containerPath}:ro`
      : `${b.hostPath}:${b.containerPath}`,
  );

  // ExposedPorts + PortBindings together tell Docker which ports to publish
  // and where to bind them. `HostPort: "0"` asks for an ephemeral port.
  // Docker's API expects `ExposedPorts` values to be empty object literals,
  // which is what `Record<string, Record<string, never>>` represents here.
  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<
    string,
    Array<{ HostIp: string; HostPort: string }>
  > = {};
  for (const p of opts.ports ?? []) {
    const proto = p.protocol ?? "tcp";
    const key = `${p.containerPort}/${proto}`;
    exposedPorts[key] = {};
    portBindings[key] = [
      {
        HostIp: p.hostIp,
        HostPort: String(p.hostPort),
      },
    ];
  }

  const hostConfig: Record<string, unknown> = {
    Binds: binds,
    PortBindings: portBindings,
    ...(opts.network ? { NetworkMode: opts.network } : {}),
    ...(opts.hostConfigExtras ?? {}),
  };

  return {
    Image: opts.image,
    Env: env,
    ExposedPorts: exposedPorts,
    HostConfig: hostConfig,
  };
}

/**
 * Walk a container-inspect payload and flatten the port bindings into a
 * simple list. Unbound entries (NetworkSettings.Ports value = null) are
 * skipped — they represent declared `ExposedPorts` that were never published.
 */
export function extractBoundPorts(inspection: ContainerInspect): BoundPort[] {
  const out: BoundPort[] = [];
  const ports = inspection.NetworkSettings?.Ports ?? {};
  for (const [key, bindings] of Object.entries(ports)) {
    if (!bindings) continue;
    const slash = key.indexOf("/");
    if (slash <= 0) continue;
    const containerPort = Number.parseInt(key.slice(0, slash), 10);
    const protoRaw = key.slice(slash + 1);
    if (!Number.isFinite(containerPort)) continue;
    const protocol: "tcp" | "udp" = protoRaw === "udp" ? "udp" : "tcp";
    for (const b of bindings) {
      const hostPort = Number.parseInt(b.HostPort ?? "", 10);
      if (!Number.isFinite(hostPort) || hostPort <= 0) continue;
      out.push({
        protocol,
        containerPort,
        hostIp: b.HostIp ?? "",
        hostPort,
      });
    }
  }
  return out;
}
