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
 * Mode-awareness (Phase 1.10 — Docker-in-Docker):
 *   - In bare-metal mode the daemon writes workspace artifacts to host paths
 *     it can share with sibling bot containers via standard Docker bind
 *     mounts on the host's Docker engine.
 *   - In Docker mode the daemon container ships its own `dockerd` (started
 *     by the init supervisor). The socket at `/var/run/docker.sock` now
 *     points at that inner `dockerd` rather than the host engine. Because
 *     the daemon's `/workspace` is a regular directory from inner
 *     `dockerd`'s point of view, workspace-rooted mounts collapse to simple
 *     host-path binds — same shape as bare-metal, just rooted at the
 *     daemon-internal workspace path (typically `/workspace`). No volume-
 *     name discovery, no subpath Mounts.
 *
 * Networking:
 *   - We always attach `host.docker.internal:host-gateway` via
 *     `HostConfig.ExtraHosts` so the bot can reach the daemon HTTP port in
 *     either mode. On Docker Desktop it's already mapped; on Linux (and in
 *     inner `dockerd` on the managed platform) the explicit gateway alias
 *     is required. In Docker mode the alias resolves to the inner bridge
 *     gateway, which routes back to the daemon process in the same
 *     container.
 */

import { request as httpRequest } from "node:http";
import { posix as posixPath } from "node:path";

import type { DaemonRuntimeMode } from "../../../assistant/src/runtime/runtime-mode.js";
import { getDaemonRuntimeMode } from "../../../assistant/src/runtime/runtime-mode.js";
import { getLogger } from "../../../assistant/src/util/logger.js";

const log = getLogger("meet-docker-runner");

/** Path to the Docker Engine unix socket. */
export const DEFAULT_DOCKER_SOCKET_PATH = "/var/run/docker.sock";

/**
 * Docker Engine API version used in request paths.
 *
 * Must be <= the daemon's `ApiVersion` and >= its `MinAPIVersion`. Docker 28+
 * raised `MinAPIVersion` to 1.44 and rejects older clients with a 400. We pin
 * to the lowest version that's still supported by current Docker releases —
 * v1.44 (Docker 25.0, January 2024) — to maximise backwards compatibility
 * while clearing the new floor.
 */
const DOCKER_API_VERSION = "v1.44";

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
 * A workspace-rooted mount request. The runner translates these to host-path
 * binds against the daemon's workspace directory — in bare-metal mode that
 * resolves to a host-visible path, in Docker mode (DinD) it resolves to the
 * daemon container's internal `/workspace` which is visible to inner
 * `dockerd`. Same logical spec works in both deployment modes.
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
   * Workspace-rooted mounts resolved against the daemon's workspace dir.
   * In both bare-metal and Docker (DinD) modes these become host-path
   * `Binds` — the difference is only the absolute prefix: a host-visible
   * path in bare-metal, the daemon container's internal `/workspace` in
   * Docker mode.
   */
  workspaceMounts?: WorkspaceMount[];
  ports?: PortMapping[];
  name?: string;
  network?: string;
  /**
   * Docker labels applied at container-create time. Meet-bot containers
   * are tagged with `vellum.meet.bot=true` and
   * `vellum.meet.meetingId=<id>` so the orphan reaper (see
   * {@link reapOrphanedMeetBots}) can discover and clean them up after a
   * crashed prior run without misidentifying unrelated containers.
   */
  labels?: Record<string, string>;
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

/**
 * Minimal shape of a single entry in Docker's `GET /containers/json`
 * response body. We only rely on the id + labels for the orphan-reaper
 * sweep; everything else is optional.
 */
export interface ContainerListEntry {
  Id: string;
  Names?: string[];
  Labels?: Record<string, string>;
  State?: string;
  Status?: string;
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
   * Workspace directory on disk. Used by the runner to resolve each
   * `workspaceMounts[i].subpath` under this directory to produce the
   * host-path bind. In bare-metal mode this is a host-visible path; in
   * Docker mode it's the daemon container's internal `/workspace`
   * (visible to inner `dockerd`). Defaults to `process.cwd()` if unset;
   * callers should inject the real workspace dir (`getWorkspaceDir()`
   * from `util/platform.ts`).
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
 * Message surfaced when the inner `dockerd` socket is unreachable from the
 * daemon in Docker mode. In Phase 1.10 the socket at
 * `/var/run/docker.sock` is the daemon container's OWN Docker Engine
 * (Docker-in-Docker), started by the init supervisor shipped in Phase 1.10
 * PR 2. If this probe fails, the init supervisor likely failed to bring
 * `dockerd` up — check the daemon container logs.
 *
 * Exported as a function so the session-manager error path and unit tests
 * share the exact string while still letting the configured socket path
 * flow through (useful when tests run against a tempdir socket, or if an
 * operator overrides the default socket path).
 */
export function dockerSocketUnreachableMessage(socketPath: string): string {
  return `Inner dockerd is not running (socket ${socketPath}). The assistant container's init supervisor failed to start dockerd. Check assistant container logs.`;
}

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
    const req = httpRequest({ socketPath, method, path, headers }, (res) => {
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
    });
    req.on("error", (err) => reject(err));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * Like {@link requestRaw} but returns the raw response bytes instead of a
 * UTF-8 string. Used by the container-logs fetcher, which has to look at
 * byte-level framing (Docker's multiplexed `{type, size, payload}` wrap).
 */
function requestRawBuffer(
  socketPath: string,
  method: string,
  path: string,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        method,
        path,
        headers: { Host: UNIX_SOCKET_HOST, Accept: "*/*" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(
              new DockerApiError(method, path, status, buf.toString("utf8")),
            );
            return;
          }
          resolve(buf);
        });
      },
    );
    req.on("error", (err) => reject(err));
    req.end();
  });
}

/**
 * Strip Docker's 8-byte multiplexed framing from a logs response body so
 * the result reads like the container's combined stdout/stderr would on
 * the terminal. Frame format:
 *
 * ```
 *   [0]      stream type (0=stdin, 1=stdout, 2=stderr)
 *   [1..3]   zero padding
 *   [4..7]   payload size (big-endian uint32)
 *   [8..]    payload bytes
 * ```
 *
 * Any malformed tail (truncated mid-frame) is silently dropped — this is
 * a diagnostic helper, not a reliable log pipeline.
 */
export function demultiplexDockerLogs(buf: Buffer): string {
  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buf.length) break;
    parts.push(buf.subarray(start, end).toString("utf8"));
    offset = end;
  }
  return parts.join("");
}

export class DockerRunner {
  readonly socketPath: string;
  private readonly resolveMode: () => DaemonRuntimeMode;
  private readonly workspaceDir: string;

  constructor(options: DockerRunnerOptions = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_DOCKER_SOCKET_PATH;
    this.resolveMode = options.resolveMode ?? getDaemonRuntimeMode;
    this.workspaceDir = options.workspaceDir ?? process.cwd();
  }

  /**
   * Create + start a container. Returns the containerId and any host-side
   * ports Docker bound after start.
   *
   * In Docker mode we first confirm the inner `dockerd` socket is
   * reachable — a `dockerd` that failed to start in the init supervisor
   * is the most common prerequisite miss on the managed platform. In
   * bare-metal mode we skip the probe (a missing local Docker surfaces
   * clearly enough on the create-path failure).
   *
   * Workspace mount resolution is the same in both modes: each
   * `workspaceMounts[i]` becomes a host-path `Bind` rooted at
   * {@link workspaceDir}. In bare-metal that's the host's workspace path;
   * in Docker mode that's the daemon container's internal `/workspace`,
   * which inner `dockerd` sees as a regular path.
   */
  async run(opts: DockerRunOptions): Promise<DockerRunResult> {
    const mode = this.resolveMode();

    // One-time socket reachability probe. In bare-metal mode the daemon
    // on a developer machine may not have Docker running; the existing
    // create-path failure already covers that case with a clear error.
    // In Docker mode the socket points at the daemon container's own
    // `dockerd` — if that's not responding, the init supervisor failed
    // to bring it up and no meeting can proceed.
    if (mode === "docker") {
      await ensureSocketReachable(this.socketPath);
    }

    const resolvedMounts = this.resolveMounts(opts.workspaceMounts);

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

  /**
   * Send a signal to a running container. Wraps
   * `POST /containers/<id>/kill?signal=<sig>`. Defaults to `SIGKILL`.
   * 404 / 409 ("container is not running") are swallowed — the caller's
   * intent ("make sure this container is dead") is already satisfied.
   */
  async kill(containerId: string, signal: string = "SIGKILL"): Promise<void> {
    const path = `/${DOCKER_API_VERSION}/containers/${containerId}/kill?signal=${encodeURIComponent(signal)}`;
    try {
      await this.request<void>("POST", path, null);
    } catch (err) {
      if (
        err instanceof DockerApiError &&
        (err.status === 404 || err.status === 409)
      ) {
        return;
      }
      throw err;
    }
  }

  /**
   * List containers, optionally filtered by labels. Wraps
   * `GET /containers/json?filters=...`. Docker's filter syntax is a JSON
   * map of filter-name → array of filter values; for labels the value is
   * either `"<key>"` (any value) or `"<key>=<value>"` (exact match).
   *
   * @param opts.labels Label filters. Array values are exact-match
   *   (`<key>=<value>`); pass just a key (via `{ "<key>": null }` –style
   *   contract) to filter on label presence. Here we only need equality
   *   matches so the input is `Record<string, string>`.
   * @param opts.all When true, includes non-running containers (matches
   *   Docker's `all=true` query param). Defaults to false (running only).
   */
  async listContainers(
    opts: {
      labels?: Record<string, string>;
      all?: boolean;
    } = {},
  ): Promise<ContainerListEntry[]> {
    const params: string[] = [];
    if (opts.all) params.push("all=true");
    if (opts.labels && Object.keys(opts.labels).length > 0) {
      const labelFilters = Object.entries(opts.labels).map(
        ([k, v]) => `${k}=${v}`,
      );
      const filters = { label: labelFilters };
      params.push(`filters=${encodeURIComponent(JSON.stringify(filters))}`);
    }
    const query = params.length > 0 ? `?${params.join("&")}` : "";
    const path = `/${DOCKER_API_VERSION}/containers/json${query}`;
    const entries = await this.request<ContainerListEntry[]>(
      "GET",
      path,
      null,
    );
    return entries ?? [];
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

  /**
   * Fetch the container's accumulated stdout/stderr as a single string.
   *
   * Wraps `GET /containers/<id>/logs?stdout=1&stderr=1`. The API emits a
   * multiplexed framing (8-byte header, then payload) when the container
   * was not started with a TTY — we always spawn without TTY, so the
   * stream needs demultiplexing before it's human-readable. This is a
   * best-effort diagnostic hook called from the rollback path; any
   * Docker-side error is wrapped as {@link DockerApiError} so callers can
   * swallow it without losing the original join failure.
   */
  async logs(
    containerId: string,
    opts: { tailLines?: number } = {},
  ): Promise<string> {
    const tail = opts.tailLines ?? "all";
    const path = `/${DOCKER_API_VERSION}/containers/${containerId}/logs?stdout=1&stderr=1&tail=${tail}`;
    const raw = await requestRawBuffer(this.socketPath, "GET", path);
    return demultiplexDockerLogs(raw);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Translate `workspaceMounts` into host-path `Binds` rooted at the
   * daemon's workspace dir. Works the same in both modes:
   *
   * - Bare-metal: `<hostWorkspaceDir>/<subpath>` → a host path the host's
   *   Docker engine mounts into the sibling bot container.
   * - Docker (DinD): `<daemonInternalWorkspaceDir>/<subpath>` (typically
   *   `/workspace/<subpath>`) → a path inside the daemon container that
   *   inner `dockerd` sees as regular filesystem and mounts into the
   *   nested bot container.
   *
   * No named-volume `Mounts` payload is emitted — the Phase 1.8 subpath
   * volume dance is gone now that the daemon's own dockerd has direct
   * visibility into `/workspace`.
   */
  private resolveMounts(
    workspaceMounts: WorkspaceMount[] | undefined,
  ): ResolvedMounts {
    if (!workspaceMounts || workspaceMounts.length === 0) {
      return { extraBinds: [] };
    }

    const extraBinds = workspaceMounts.map<BindMount>((m) => ({
      hostPath: resolveWorkspaceSubpath(this.workspaceDir, m.subpath),
      containerPath: m.target,
      readOnly: m.readOnly,
    }));
    return { extraBinds };
  }

  /** Issue a unix-socket HTTP request and decode the JSON body, if any. */
  private request<T>(method: string, path: string, body: unknown): Promise<T> {
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
 * Resolved mount spec produced by {@link DockerRunner.resolveMounts} — a flat
 * list of host-path bind mounts to serialize into `HostConfig.Binds`. Works
 * the same in bare-metal and Docker (DinD) modes; the only difference is the
 * absolute path prefix injected via {@link DockerRunnerOptions.workspaceDir}.
 */
export interface ResolvedMounts {
  extraBinds: BindMount[];
}

/** Always-on hostname alias that lets the bot reach the daemon HTTP port. */
export const HOST_GATEWAY_ALIAS = "host.docker.internal:host-gateway";

/**
 * Docker-label key applied to every meet-bot container at create time. Set
 * to the literal string `"true"`. Used together with
 * {@link MEET_BOT_MEETING_ID_LABEL} for orphan discovery in
 * {@link reapOrphanedMeetBots}.
 */
export const MEET_BOT_LABEL = "vellum.meet.bot";

/**
 * Docker-label key that carries the meeting ID for the running bot. Pairs
 * with {@link MEET_BOT_LABEL} so the reaper can compare each labeled
 * container's meeting ID against the currently-active session set and only
 * kill the ones that belong to no live session.
 */
export const MEET_BOT_MEETING_ID_LABEL = "vellum.meet.meetingId";

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
  resolved: ResolvedMounts = { extraBinds: [] },
): Record<string, unknown> {
  const env = opts.env
    ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
    : [];
  // In both bare-metal and Docker (DinD) modes the resolver produces
  // host-path binds from `workspaceMounts` — the Phase 1.8 named-volume
  // subpath `Mounts` payload is no longer emitted.
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
    // Docker's default `/dev/shm` is 64 MiB, which Chrome exhausts when
    // loading a JS-heavy page like Google Meet — the renderer then crashes
    // with a cryptic "Target page, context or browser has been closed". 2 GiB
    // is the commonly-cited safe default for Chrome automation in Docker.
    // (`--disable-dev-shm-usage` in the Chrome launch args routes shared
    // memory to `/tmp` as a separate belt-and-suspenders hedge.)
    ShmSize: 2 * 1024 * 1024 * 1024,
    ...(opts.network ? { NetworkMode: opts.network } : {}),
  };

  const body: Record<string, unknown> = {
    Image: opts.image,
    Env: env,
    ExposedPorts: exposedPorts,
    HostConfig: hostConfig,
  };
  if (opts.labels && Object.keys(opts.labels).length > 0) {
    body.Labels = { ...opts.labels };
  }
  return body;
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

// ---------------------------------------------------------------------------
// Orphan reaper
// ---------------------------------------------------------------------------

/**
 * Minimal subset of {@link DockerRunner} that {@link reapOrphanedMeetBots}
 * depends on. Isolated as a structural type so tests can pass a hand-rolled
 * fake without instantiating the full runner.
 */
export interface DockerClientForReaper {
  listContainers(opts: {
    labels?: Record<string, string>;
    all?: boolean;
  }): Promise<ContainerListEntry[]>;
  kill(containerId: string, signal?: string): Promise<void>;
}

/** Grace window (ms) between SIGTERM and SIGKILL during the reaper sweep. */
export const REAPER_TERM_KILL_GRACE_MS = 10_000;

/**
 * Sweep orphaned meet-bot containers left behind by a crashed prior run.
 *
 * **Label scheme.** Every meet-bot container created by this daemon is
 * tagged at `/containers/create` time with two Docker labels:
 *
 *   - `vellum.meet.bot=true` — identifies the container as a meet-bot
 *     managed by this codebase (distinguishes from any other containers
 *     the user might be running).
 *   - `vellum.meet.meetingId=<id>` — carries the originating meeting ID
 *     so the reaper can match each labeled container against the currently-
 *     active in-process session set and only kill the ones that belong to
 *     no live session.
 *
 * **Kill protocol.** Each orphan receives a `SIGTERM`, then after a
 * {@link REAPER_TERM_KILL_GRACE_MS}-ms grace window the reaper issues a
 * `SIGKILL` as the hard fallback. Both calls go through the docker client's
 * `/kill` endpoint so the container's exit is recorded in the engine's
 * state table; the subsequent `docker events` stream fires normally and
 * downstream consumers (monitoring, log retention) see a clean shutdown
 * rather than a disappearing container. Per-container errors are caught and
 * logged so one misbehaving container can't abort the sweep.
 *
 * @param opts.docker Docker client — typically a {@link DockerRunner}.
 * @param opts.activeMeetingIds Meeting IDs that currently map to a live
 *   in-process session. On boot this is an empty set (no sessions yet),
 *   but the signature accepts any set so the same helper can be called
 *   from a later "cleanup unexpected orphans" sweep during runtime.
 * @param opts.logger Structured logger — one INFO line per kill.
 * @returns Summary of which container ids were killed vs kept.
 */
/**
 * Structural subset of a pino-style structured logger — the reaper only
 * emits info/warn/debug lines and doesn't want a hard dep on pino's type
 * export from this module. The daemon's real logger (`pino.Logger`) is
 * assignable to this shape.
 */
export interface ReaperLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error?(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
}

export async function reapOrphanedMeetBots(opts: {
  docker: DockerClientForReaper;
  activeMeetingIds: ReadonlySet<string>;
  logger: ReaperLogger;
}): Promise<{ killed: string[]; kept: string[] }> {
  const { docker, activeMeetingIds, logger } = opts;
  const killed: string[] = [];
  const kept: string[] = [];

  let containers: ContainerListEntry[];
  try {
    containers = await docker.listContainers({
      labels: { [MEET_BOT_LABEL]: "true" },
      all: false,
    });
  } catch (err) {
    logger.warn({ err }, "reapOrphanedMeetBots: listContainers failed");
    return { killed, kept };
  }

  for (const container of containers) {
    const containerId = container.Id;
    const labels = container.Labels ?? {};
    const meetingId = labels[MEET_BOT_MEETING_ID_LABEL];

    if (meetingId && activeMeetingIds.has(meetingId)) {
      kept.push(containerId);
      continue;
    }

    try {
      await docker.kill(containerId, "SIGTERM");
      // Best-effort grace window: schedule a SIGKILL after the grace
      // period, in case the bot ignores SIGTERM. We don't await the
      // timeout — reaper callers want a bounded sweep duration, not an
      // extra 10s per orphan.
      setTimeout(() => {
        docker.kill(containerId, "SIGKILL").catch((err: unknown) => {
          logger.debug(
            { err, containerId, meetingId },
            "reapOrphanedMeetBots: delayed SIGKILL failed (container likely already dead)",
          );
        });
      }, REAPER_TERM_KILL_GRACE_MS).unref?.();
      logger.info(
        { containerId, meetingId, reason: "orphan" },
        "orphan meet-bot reaped",
      );
      killed.push(containerId);
    } catch (err) {
      logger.warn(
        { err, containerId, meetingId },
        "reapOrphanedMeetBots: kill failed — continuing sweep",
      );
    }
  }

  return { killed, kept };
}
