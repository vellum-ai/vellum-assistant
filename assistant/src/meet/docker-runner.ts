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
 *
 * Mode-awareness (Phase 1.8):
 *   - In bare-metal mode the daemon writes workspace artifacts to host paths
 *     it can share with bot containers via standard Docker bind mounts.
 *   - In Docker mode the daemon itself lives in a container whose
 *     `/workspace` path is not visible to the host Docker engine. Workspace-
 *     rooted mounts have to be expressed as named-volume mounts against the
 *     same workspace volume the daemon is using (discovered via
 *     {@link getWorkspaceVolumeName}). We use Docker's volume `Mounts` API
 *     with `VolumeOptions.Subpath` so each bot only sees its own meeting
 *     directory — that requires Docker Engine 25+.
 *
 * Networking:
 *   - We always attach `host.docker.internal:host-gateway` via
 *     `HostConfig.ExtraHosts` so the bot can reach the daemon HTTP port on
 *     the host in either mode. On Docker Desktop it's already mapped; on
 *     Linux the explicit gateway alias is required.
 */

import { request as httpRequest } from "node:http";
import { posix as posixPath } from "node:path";

import type { DaemonRuntimeMode } from "../runtime/runtime-mode.js";
import { getDaemonRuntimeMode } from "../runtime/runtime-mode.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceVolumeName } from "./workspace-volume.js";

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

/**
 * Internal host-path bind spec produced by {@link DockerRunner.resolveMounts}
 * in bare-metal mode. Not exposed on the public run options — callers use
 * {@link WorkspaceMount} and let the runner resolve it.
 */
export interface BindMount {
  hostPath: string;
  containerPath: string;
  /** Whether the mount is read-only. Defaults to `false`. */
  readOnly?: boolean;
}

/**
 * A workspace-rooted mount request. The runner translates these to either a
 * host-path bind (bare-metal mode) or a named-volume `Mounts` entry with
 * `VolumeOptions.Subpath` (Docker mode). The same logical spec works in
 * both deployment modes.
 *
 * `subpath` is interpreted relative to the workspace root on disk — e.g.
 * `"meets/<id>/sockets"`. `target` is the absolute path inside the bot
 * container — e.g. `"/sockets"`.
 */
export interface WorkspaceMount {
  target: string;
  subpath: string;
  /** Whether the mount is read-only. Defaults to `false`. */
  readOnly?: boolean;
}

/** Options for creating + starting a container. */
export interface DockerRunOptions {
  image: string;
  env?: Record<string, string>;
  /**
   * Workspace-rooted mounts resolved according to the current runtime
   * mode. In bare-metal mode these become host-path binds; in Docker mode
   * they become named-volume `Mounts` against the workspace volume.
   */
  workspaceMounts?: WorkspaceMount[];
  ports?: PortMapping[];
  name?: string;
  network?: string;
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
  /**
   * Override the runtime-mode resolver. Defaults to
   * {@link getDaemonRuntimeMode}. Tests inject a fixed value to exercise
   * both bare-metal and Docker branches without touching env vars.
   */
  resolveMode?: () => DaemonRuntimeMode;
  /**
   * Override the workspace-volume-name resolver. Defaults to
   * {@link getWorkspaceVolumeName} with no options (production cache
   * path). Tests inject a fake so they can steer the Docker branch
   * between "volume found" and "volume null" outcomes without touching
   * `/proc/self/mountinfo`.
   */
  resolveWorkspaceVolumeName?: () => Promise<string | null>;
  /**
   * Workspace directory on disk. Required when running in bare-metal mode
   * with `workspaceMounts` — the runner resolves each `subpath` under this
   * directory to produce the host-path bind. Defaults to `process.cwd()`
   * if unset; callers should inject the real workspace dir
   * (`getWorkspaceDir()` from `util/platform.ts`).
   */
  workspaceDir?: string;
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

/**
 * Message surfaced when the Docker Engine socket is unreachable from the
 * daemon in Docker mode. Exported as a function so the session-manager
 * error path and unit tests share the exact string while still letting the
 * configured socket path flow through (useful when tests run against a
 * tempdir socket, or if an operator overrides the default socket path).
 */
export function dockerSocketUnreachableMessage(socketPath: string): string {
  return `The daemon cannot reach the Docker Engine at ${socketPath}. In Docker mode the daemon container must have the socket bind-mounted. Upgrade your vellum CLI to a version that supports Meet in Docker mode (see Phase 1.8 docs).`;
}

/**
 * Message surfaced when Docker mode is active but no named workspace
 * volume was discoverable. Exported so the session-manager error path and
 * unit tests can share the exact string.
 */
export const DOCKER_WORKSPACE_VOLUME_MISSING_MESSAGE =
  "Meet in Docker mode requires the workspace to be on a named Docker volume. Ensure the vellum CLI launched the daemon with a named volume at /workspace, or set VELLUM_WORKSPACE_VOLUME_NAME.";

/**
 * Module-level cache of in-flight or resolved `/_ping` reachability probes,
 * keyed by socket path. Promoted from an instance field because
 * `MeetSessionManager` constructs a fresh `DockerRunner` on every
 * `dockerRunnerFactory()` call (which runs per `join()`/`leave()`/`shutdown()`),
 * which would make instance-scoped memoization effectively never reuse a
 * result in production. Module scope gives the de-dupe the full process
 * lifetime and also covers concurrent first-spawn callers.
 *
 * Keyed by socket path so tests using distinct tempdir sockets don't share
 * cache entries with real runners or with each other.
 */
const socketReachabilityCache = new Map<string, Promise<true>>();

/**
 * One-time `GET /_ping` reachability probe for a given Docker Engine socket.
 * Memoizes the success so the second and later spawns skip the extra
 * round-trip; memoizes the in-flight promise so concurrent first spawns
 * share a single round-trip and all surface the same clear
 * prerequisite-missing error. On failure, the cache entry is cleared so
 * subsequent spawns can retry if the operator bind-mounts the socket and
 * restarts the daemon — the current call still rejects so fail-fast
 * semantics hold.
 */
export function ensureSocketReachable(socketPath: string): Promise<true> {
  let cached = socketReachabilityCache.get(socketPath);
  if (cached === undefined) {
    cached = probePing(socketPath).catch((err) => {
      socketReachabilityCache.delete(socketPath);
      throw err;
    });
    socketReachabilityCache.set(socketPath, cached);
  }
  return cached;
}

/**
 * Reset the memoized reachability cache. Only for tests that want to
 * re-exercise the probe path; production code should never call this.
 */
export function resetSocketReachabilityCacheForTests(): void {
  socketReachabilityCache.clear();
}

async function probePing(socketPath: string): Promise<true> {
  // `/_ping` returns the literal text `"OK"` (not JSON), so we go straight
  // to the raw-response helper rather than a JSON-decoding request helper
  // which would choke on the non-JSON body.
  try {
    await requestRaw(socketPath, "GET", `/${DOCKER_API_VERSION}/_ping`, null);
    return true;
  } catch (err) {
    log.warn(
      { err, socketPath },
      "Docker Engine socket reachability probe failed",
    );
    throw new Error(dockerSocketUnreachableMessage(socketPath));
  }
}

/**
 * Lower-level request helper used for endpoints that return non-JSON
 * bodies (e.g. `/_ping` → `"OK"`). Resolves with the raw body string on
 * 2xx; rejects with {@link DockerApiError} otherwise.
 */
function requestRaw(
  socketPath: string,
  method: string,
  path: string,
  body: unknown,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const payload =
      body === null || body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string | number> = {
      Host: UNIX_SOCKET_HOST,
      Accept: "*/*",
    };
    if (payload !== null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = httpRequest(
      { socketPath, method, path, headers },
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
          resolve(raw);
        });
      },
    );
    req.on("error", (err) => reject(err));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

export class DockerRunner {
  readonly socketPath: string;
  private readonly resolveMode: () => DaemonRuntimeMode;
  private readonly resolveWorkspaceVolumeName: () => Promise<string | null>;
  private readonly workspaceDir: string;

  constructor(options: DockerRunnerOptions = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_DOCKER_SOCKET_PATH;
    this.resolveMode = options.resolveMode ?? getDaemonRuntimeMode;
    this.resolveWorkspaceVolumeName =
      options.resolveWorkspaceVolumeName ?? (() => getWorkspaceVolumeName());
    this.workspaceDir = options.workspaceDir ?? process.cwd();
  }

  /**
   * Create + start a container. Returns the containerId and any host-side
   * ports Docker bound after start.
   *
   * In Docker mode we first confirm the engine socket is reachable (a
   * missing bind-mount of `/var/run/docker.sock` is the most common
   * prerequisite miss) and discover the workspace volume name before
   * translating `workspaceMounts` into named-volume `Mounts` with
   * subpaths. In bare-metal mode we skip those steps and bind host paths
   * directly.
   */
  async run(opts: DockerRunOptions): Promise<DockerRunResult> {
    const mode = this.resolveMode();

    // One-time socket reachability probe. In bare-metal mode the daemon
    // on a developer machine may not have Docker running; the existing
    // create-path failure already covers that case with a clear error,
    // so we only hard-gate in Docker mode where a missing bind-mount is
    // a deployment bug the caller cannot work around.
    if (mode === "docker") {
      await ensureSocketReachable(this.socketPath);
    }

    const resolvedMounts = await this.resolveMounts(mode, opts.workspaceMounts);

    const createBody = buildCreateBody(opts, resolvedMounts);
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

  /**
   * Translate `workspaceMounts` into either host-path binds or
   * named-volume `Mounts` entries according to the runtime mode.
   *
   * Bare-metal: each mount becomes a `BindMount` with
   * `<workspaceDir>/<subpath>` as the host path. Docker: each mount
   * becomes a volume mount against the discovered workspace volume with
   * `VolumeOptions.Subpath = <subpath>`. Subpath requires Docker Engine
   * 25+. If Engine <25 is observed in the field, the fallback is to
   * mount the whole workspace volume at `/workspace` inside the bot and
   * have the bot itself resolve paths under `/workspace/meets/<id>/…`;
   * that's left as a follow-up because Docker Desktop ships Engine 25+
   * and the CLI requires it as a prerequisite in `cli/src/lib/docker.ts`.
   */
  private async resolveMounts(
    mode: DaemonRuntimeMode,
    workspaceMounts: WorkspaceMount[] | undefined,
  ): Promise<ResolvedMounts> {
    if (!workspaceMounts || workspaceMounts.length === 0) {
      return { extraBinds: [], mounts: [] };
    }

    if (mode === "bare-metal") {
      const extraBinds = workspaceMounts.map<BindMount>((m) => ({
        hostPath: resolveWorkspaceSubpath(this.workspaceDir, m.subpath),
        containerPath: m.target,
        readOnly: m.readOnly,
      }));
      return { extraBinds, mounts: [] };
    }

    // Docker mode — named-volume subpath mounts.
    const volumeName = await this.resolveWorkspaceVolumeName();
    if (volumeName === null) {
      throw new Error(DOCKER_WORKSPACE_VOLUME_MISSING_MESSAGE);
    }
    const mounts = workspaceMounts.map((m) => ({
      Type: "volume" as const,
      Source: volumeName,
      Target: m.target,
      ReadOnly: m.readOnly === true,
      VolumeOptions: { Subpath: m.subpath },
    }));
    return { extraBinds: [], mounts };
  }

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
 * Resolved mount spec produced by {@link DockerRunner.resolveMounts} — either
 * extra bind mounts to append to `HostConfig.Binds` (bare-metal) or named
 * volume mounts to pass via `HostConfig.Mounts` (Docker mode).
 */
export interface ResolvedMounts {
  extraBinds: BindMount[];
  mounts: Array<{
    Type: "volume";
    Source: string;
    Target: string;
    ReadOnly: boolean;
    VolumeOptions: { Subpath: string };
  }>;
}

/** Always-on hostname alias that lets the bot reach the daemon HTTP port. */
export const HOST_GATEWAY_ALIAS = "host.docker.internal:host-gateway";

/**
 * Resolve a workspace-relative `subpath` against the absolute `workspaceDir`
 * using POSIX join semantics. Leading slashes in `subpath` are tolerated;
 * POSIX rules are used so the result is portable across test platforms.
 */
export function resolveWorkspaceSubpath(
  workspaceDir: string,
  subpath: string,
): string {
  const trimmed = subpath.replace(/^\/+/, "");
  return posixPath.join(workspaceDir, trimmed);
}

/**
 * Translate the high-level `DockerRunOptions` plus any pre-resolved workspace
 * mounts into the JSON body the Docker Engine's `/containers/create`
 * endpoint expects.
 *
 * `resolved` is optional so tests (and callers that don't use workspace
 * mounts) can keep passing just the options bag.
 */
export function buildCreateBody(
  opts: DockerRunOptions,
  resolved: ResolvedMounts = { extraBinds: [], mounts: [] },
): Record<string, unknown> {
  const env = opts.env
    ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
    : [];
  // In bare-metal mode the resolver produces host-path binds from
  // `workspaceMounts`; in Docker mode it produces named-volume `Mounts`
  // instead and `extraBinds` is empty. Either way, `Binds` is what the
  // engine expects for the host-path style so we serialize it here.
  const binds = resolved.extraBinds.map((b) =>
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
    // Always expose `host.docker.internal` so the bot can reach the
    // daemon's HTTP port on the host in both modes. Docker Desktop
    // already maps this alias; on Linux hosts the explicit
    // `host-gateway` value is required. Applied unconditionally because
    // the resolution is identical either way on modern engines.
    ExtraHosts: [HOST_GATEWAY_ALIAS],
    ...(resolved.mounts.length > 0 ? { Mounts: resolved.mounts } : {}),
    ...(opts.network ? { NetworkMode: opts.network } : {}),
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
