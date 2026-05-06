/**
 * Skill IPC server — exposes daemon (host) capabilities to first-party skill
 * processes over a Unix domain socket.
 *
 * Separate from the CLI IPC server so skill traffic (host.log, host.config.*,
 * host.events.*, host.registries.*, etc.) stays off the CLI socket and can
 * evolve its own long-lived subscribe streams.
 *
 * Protocol: newline-delimited JSON over a Unix domain socket.
 *
 * Bidirectional RPC: either side may initiate a request. Per-direction id
 * namespacing prevents collisions:
 * - Skill-initiated request ids start with `s:` (minted client-side).
 * - Daemon-initiated request ids start with `d:` (minted server-side).
 * Response frames echo the request id, so each side routes inbound responses
 * to its own pending-request map by prefix.
 *
 * Skill→daemon one-shot RPC:
 * - Request:  { "id": "s:<n>", "method": string, "params"?: Record<string, unknown> }
 * - Response: { "id": "s:<n>", "result"?: unknown, "error"?: string }
 *
 * Daemon→skill one-shot RPC:
 * - Request:  { "id": "d:<n>", "method": string, "params"?: unknown }
 * - Response: { "id": "d:<n>", "result"?: unknown, "error"?: string }
 *
 * Streaming RPC (e.g. `host.events.subscribe`, skill-initiated only):
 * - Request:    { "id": "s:<n>", "method": string, "params"?: Record<string, unknown> }
 * - Open ack:   { "id": "s:<n>", "result": { "subscribed": true } }
 * - Deliveries: { "id": "s:<n>", "event": "delivery", "payload": <data> } (0..N)
 * - Error:      { "id": "s:<n>", "error": string } (terminal)
 * - Close req:  { "id": "s:<n>", "method": "host.events.subscribe.close",
 *                 "params": { "subscribeId": "<original-id>" } }
 * - Close ack:  { "id": "s:<n>", "result": { "closed": true } }
 *
 * The preferred socket path is `{workspaceDir}/assistant-skill.sock`. On
 * platforms with strict AF_UNIX path limits (notably macOS), the server falls
 * back to a shorter deterministic path via the shared socket-path resolver.
 */

import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

import {
  ensureSocketDir,
  SocketWatchdog,
} from "@vellumai/ipc-server-utils";

import {
  type SkillRouteHandle,
  unregisterSkillRoute,
} from "../runtime/skill-route-registry.js";
import { unregisterSkillTools } from "../tools/registry.js";
import { getLogger } from "../util/logger.js";
import type { IpcRequest, IpcResponse } from "./assistant-server.js";

export type { SkillIpcRoute, SkillMethodHandler } from "./skill-ipc-types.js";
import type {
  SkillIpcStream,
  SkillIpcStreamingHandler,
  SkillMethodHandler,
} from "./skill-ipc-types.js";
import {
  skillIpcRoutes,
  skillIpcStreamingRoutes,
} from "./skill-routes/index.js";
import { resolveSkillIpcSocketPath } from "./skill-socket-path.js";
import { ensureSocketPathFree } from "./socket-cleanup.js";

const log = getLogger("skill-ipc-server");

// ---------------------------------------------------------------------------
// Id namespacing
// ---------------------------------------------------------------------------

/** Prefix for ids minted by the daemon (server) side. */
export const SKILL_IPC_DAEMON_ID_PREFIX = "d:" as const;

/** Default per-call timeout for daemon-initiated requests. */
const DEFAULT_SEND_REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Well-known control method the client sends to close an open stream. The
 * server also tears down on socket close / daemon shutdown, so this is only
 * needed when the client wants to keep the socket but end one subscription.
 */
const SKILL_IPC_SUBSCRIBE_CLOSE_METHOD = "host.events.subscribe.close" as const;

/** Stream handle passed to streaming-handler implementations. */
/**
 * Maximum bytes Node may have queued in the socket's outbound buffer before
 * the next streaming `send` will close the stream with a backpressure error.
 * `socket.write()` returns `false` once the kernel buffer is full and Node
 * starts queueing in user-space; without a cap, a slow or stalled subscriber
 * would let that queue grow without bound and OOM the daemon. 1 MiB is large
 * enough to absorb normal token-burst spikes but small enough to fail-fast
 * on a genuinely stuck consumer.
 */
const STREAM_BACKPRESSURE_BYTES = 1024 * 1024;



// ---------------------------------------------------------------------------
// Per-connection context
// ---------------------------------------------------------------------------

/**
 * Per-connection state threaded into skill-IPC method handlers as their
 * second argument. Lets `host.registries.*` handlers attach route handles
 * and skill-tool owner IDs to the live connection so the server can tear
 * them down when the connection closes — without this, a skill process
 * that disconnects (crash or reconnect) would leak its contributions into
 * the daemon's in-memory registries.
 *
 * Mirrors the plugin-bootstrap pattern (`external-plugins-bootstrap.ts`),
 * which retains the opaque {@link SkillRouteHandle} returned from
 * `registerSkillRoute` and unregisters by identity during teardown.
 */
export interface SkillIpcConnection {
  readonly connectionId: string;
  /**
   * Store a route handle under the given skill id so disconnect can
   * revoke exactly the routes this connection contributed. Pattern-text
   * is not a stable key — two owners may legitimately register the same
   * regex.
   */
  addRouteHandle(skillId: string, handle: SkillRouteHandle): void;
  /**
   * Record that this connection registered tools for `skillId`. The tool
   * registry's `registerSkillTools` increments its internal refcount on
   * every call, so each register_tools frame must be paired with exactly
   * one `unregisterSkillTools` on disconnect — a deduplicated Set would
   * leak the extra increments and pin stale proxies in the registry. On
   * teardown the server calls `unregisterSkillTools(skillId)` once per
   * recorded registration.
   */
  addSkillToolsOwner(skillId: string): void;
}

/** Internal record for a daemon-initiated request awaiting a response. */
interface PendingDaemonRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class SkillIpcConnectionState implements SkillIpcConnection {
  readonly connectionId: string;
  readonly socket: Socket;
  private routeHandlesBySkill = new Map<string, SkillRouteHandle[]>();
  /**
   * Per-skill registration counts. `registerSkillTools` increments the
   * tool-registry refcount on every call; storing a count (rather than a
   * deduplicated Set) lets `dispose()` issue the matching number of
   * `unregisterSkillTools` calls so a connection that registered tools in
   * multiple batches doesn't leak refcount on disconnect.
   */
  private skillToolOwnerCounts = new Map<string, number>();
  /**
   * Pending daemon-initiated requests keyed by `d:<n>` id. Cleared on
   * connection teardown so callers never see a hung promise.
   */
  readonly pendingDaemonRequests = new Map<string, PendingDaemonRequest>();
  private nextRequestSeq = 1;

  constructor(connectionId: string, socket: Socket) {
    this.connectionId = connectionId;
    this.socket = socket;
  }

  /** Allocate the next `d:<n>` id for a daemon-initiated request. */
  nextDaemonRequestId(): string {
    return `${SKILL_IPC_DAEMON_ID_PREFIX}${this.nextRequestSeq++}`;
  }

  addRouteHandle(skillId: string, handle: SkillRouteHandle): void {
    const list = this.routeHandlesBySkill.get(skillId) ?? [];
    list.push(handle);
    this.routeHandlesBySkill.set(skillId, list);
  }

  addSkillToolsOwner(skillId: string): void {
    this.skillToolOwnerCounts.set(
      skillId,
      (this.skillToolOwnerCounts.get(skillId) ?? 0) + 1,
    );
  }

  dispose(): void {
    for (const handles of this.routeHandlesBySkill.values()) {
      for (const handle of handles) {
        try {
          unregisterSkillRoute(handle);
        } catch (err) {
          log.warn(
            { err, connectionId: this.connectionId },
            "skill IPC disconnect: failed to unregister skill route",
          );
        }
      }
    }
    this.routeHandlesBySkill.clear();
    for (const [skillId, count] of this.skillToolOwnerCounts) {
      for (let i = 0; i < count; i++) {
        try {
          unregisterSkillTools(skillId);
        } catch (err) {
          log.warn(
            { err, connectionId: this.connectionId, skillId },
            "skill IPC disconnect: failed to unregister skill tools",
          );
        }
      }
    }
    this.skillToolOwnerCounts.clear();
    // Reject every in-flight daemon-initiated request so callers don't
    // hang on a dropped peer. The socket's "close" listener fires before
    // dispose() in the normal path, but defending here keeps behavior
    // identical when teardown is invoked from the explicit `stop()` path.
    if (this.pendingDaemonRequests.size > 0) {
      const closeErr = new Error(
        `SkillIpcServer: connection closed before response (connectionId=${this.connectionId})`,
      );
      for (const pending of this.pendingDaemonRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(closeErr);
      }
      this.pendingDaemonRequests.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** Optional configuration for {@link SkillIpcServer}. */
export interface SkillIpcServerOptions {
  /**
   * How often the socket-file watchdog stats the listening socket path.
   * Set to `0` to disable. Defaults to {@link SocketWatchdog}'s 5000ms.
   */
  watchdogIntervalMs?: number;
}

export class SkillIpcServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private methods = new Map<string, SkillMethodHandler>();
  private streamingMethods = new Map<string, SkillIpcStreamingHandler>();
  /**
   * Per-socket subscription registry. Keyed by the request id that opened
   * the stream so the close-control message and socket-close teardown can
   * locate the matching dispose callback.
   */
  private subscriptions = new WeakMap<Socket, Map<string, () => void>>();
  /**
   * Per-socket connection state threaded into `host.registries.*` handlers.
   * Holds route handles + skill-tool owner ids the connection contributed
   * so `teardownConnection` can revoke them on disconnect.
   */
  private connections = new WeakMap<Socket, SkillIpcConnectionState>();
  private nextConnectionId = 1;
  private socketPath: string;
  private watchdog: SocketWatchdog;
  /**
   * Servers whose listener path has been replaced by a re-bind. Kept around
   * so already-connected sockets continue to work; closed gracefully once
   * their accept loops drain.
   */
  private legacyServers = new Set<Server>();

  constructor(options?: SkillIpcServerOptions) {
    const resolution = resolveSkillIpcSocketPath();
    this.socketPath = resolution.path;
    log.info(
      { source: resolution.source, path: resolution.path },
      "Skill IPC socket path resolved",
    );
    for (const route of skillIpcRoutes) {
      this.methods.set(route.method, route.handler);
    }
    for (const route of skillIpcStreamingRoutes) {
      this.streamingMethods.set(route.method, route.handler);
    }

    this.watchdog = new SocketWatchdog({
      socketPath: this.socketPath,
      intervalMs: options?.watchdogIntervalMs,
      getServer: () => this.server,
      createServer: () => this.createListeningServer(),
      onRebind: (newServer, oldServer) => {
        this.server = newServer;
        this.legacyServers.add(oldServer);
        oldServer.close(() => {
          this.legacyServers.delete(oldServer);
        });
      },
      log,
    });
  }

  /** Register an additional method handler after construction. */
  registerMethod(method: string, handler: SkillMethodHandler): void {
    this.methods.set(method, handler);
  }

  /** Register an additional streaming handler after construction. */
  registerStreamingMethod(
    method: string,
    handler: SkillIpcStreamingHandler,
  ): void {
    this.streamingMethods.set(method, handler);
  }

  /**
   * Send a request to the skill on the other side of `connection` and resolve
   * with the matching response's `result` (or reject with its `error`).
   *
   * Daemon-initiated request ids are namespaced under the `d:` prefix so the
   * skill can disambiguate them from its own `s:`-prefixed responses on the
   * same socket. The pending entry is held on the per-connection state so a
   * disconnect rejects every in-flight request without leaking timers.
   *
   * Throws synchronously if `connection` is unknown or its socket is already
   * destroyed. Rejects asynchronously on:
   *   - skill-side error response (`{ id, error }`),
   *   - timeout (default 30s, override via `opts.timeoutMs`),
   *   - peer disconnect before a response arrives.
   */
  sendRequest(
    connection: SkillIpcConnection,
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<unknown> {
    const state = connection as SkillIpcConnectionState;
    if (!(state instanceof SkillIpcConnectionState)) {
      return Promise.reject(
        new Error(
          "SkillIpcServer.sendRequest: connection must be a SkillIpcConnection produced by this server",
        ),
      );
    }
    if (state.socket.destroyed) {
      return Promise.reject(
        new Error(
          `SkillIpcServer.sendRequest: connection ${state.connectionId} socket is destroyed`,
        ),
      );
    }

    const id = state.nextDaemonRequestId();
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_SEND_REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (state.pendingDaemonRequests.delete(id)) {
          reject(
            new Error(
              `SkillIpcServer.sendRequest: '${method}' on ${state.connectionId} timed out after ${timeoutMs}ms`,
            ),
          );
        }
      }, timeoutMs);
      state.pendingDaemonRequests.set(id, { resolve, reject, timer });
      try {
        const frame: { id: string; method: string; params?: unknown } = {
          id,
          method,
        };
        if (params !== undefined) frame.params = params;
        state.socket.write(JSON.stringify(frame) + "\n");
      } catch (err) {
        state.pendingDaemonRequests.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  /** Start listening on the Unix domain socket. */
  async start(): Promise<void> {
    // Ensure the parent directory exists before listening.
    ensureSocketDir(this.socketPath);

    // Probe before unlink so a second daemon can't silently orphan an active
    // listener (Unix lets you unlink a still-bound socket file). See
    // `ensureSocketPathFree` for the behavior matrix.
    await ensureSocketPathFree(this.socketPath);

    this.server = this.createListeningServer();
    this.server.listen(this.socketPath, () => {
      log.info({ path: this.socketPath }, "Skill IPC server listening");
    });

    this.watchdog.start();
  }

  /** Stop the server and disconnect all clients. */
  stop(): void {
    this.watchdog.stop();

    for (const client of this.clients) {
      this.teardownSubscriptions(client);
      this.teardownConnection(client);
      if (!client.destroyed) client.destroy();
    }
    this.clients.clear();

    for (const legacy of this.legacyServers) {
      legacy.close();
    }
    this.legacyServers.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore
      }
    }
  }

  /** Get the socket path (for diagnostics). */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Re-bind the listening socket if its path entry is missing on disk.
   *
   * Public for tests so the watchdog can be exercised deterministically
   * without waiting for the interval. Returns `true` when a re-bind was
   * performed, `false` otherwise.
   */
  async rebindIfMissing(): Promise<boolean> {
    return this.watchdog.rebindIfMissing();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private createListeningServer(): Server {
    const server = createServer((socket) => {
      this.clients.add(socket);
      const connection = new SkillIpcConnectionState(
        `skill-ipc-${this.nextConnectionId++}`,
        socket,
      );
      this.connections.set(socket, connection);
      log.debug(
        { connectionId: connection.connectionId },
        "Skill IPC client connected",
      );

      let buffer = "";

      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line) {
            this.handleMessage(socket, line);
          }
        }
      });

      socket.on("close", () => {
        this.clients.delete(socket);
        this.teardownSubscriptions(socket);
        this.teardownConnection(socket);
        log.debug(
          { connectionId: connection.connectionId },
          "Skill IPC client disconnected",
        );
      });

      socket.on("error", (err) => {
        log.warn(
          { err, connectionId: connection.connectionId },
          "Skill IPC client socket error",
        );
        this.clients.delete(socket);
        this.teardownSubscriptions(socket);
        this.teardownConnection(socket);
      });
    });

    server.on("error", (err) => {
      log.error({ err }, "Skill IPC server error");
    });

    return server;
  }

  private handleMessage(socket: Socket, line: string): void {
    let frame: IpcRequest & { result?: unknown; error?: string };
    try {
      frame = JSON.parse(line) as IpcRequest & {
        result?: unknown;
        error?: string;
      };
    } catch {
      this.sendResponse(socket, {
        id: "unknown",
        error: "Invalid JSON",
      });
      return;
    }

    if (
      !frame ||
      typeof frame !== "object" ||
      Array.isArray(frame) ||
      typeof frame.id !== "string" ||
      !frame.id
    ) {
      const id =
        frame &&
        typeof frame === "object" &&
        !Array.isArray(frame) &&
        typeof frame.id === "string"
          ? frame.id
          : "unknown";
      this.sendResponse(socket, {
        id,
        error: "Missing 'id' or 'method' field",
      });
      return;
    }

    // Response frame for a daemon-initiated request — route to the
    // pending-request map on the connection state instead of treating it
    // as an inbound RPC. Identified by the `d:` id prefix and the
    // absence of a `method` field.
    if (
      frame.method === undefined &&
      frame.id.startsWith(SKILL_IPC_DAEMON_ID_PREFIX)
    ) {
      this.handleDaemonResponse(socket, frame);
      return;
    }

    if (!frame.method) {
      this.sendResponse(socket, {
        id: frame.id,
        error: "Missing 'id' or 'method' field",
      });
      return;
    }

    const req = frame as IpcRequest;

    // Reserve the daemon prefix for server-minted ids. A skill that sends
    // a request whose id starts with `d:` would collide with daemon-side
    // pending entries; reject it loudly so the bug surfaces early.
    if (req.id.startsWith(SKILL_IPC_DAEMON_ID_PREFIX)) {
      this.sendResponse(socket, {
        id: req.id,
        error: `Reserved id prefix '${SKILL_IPC_DAEMON_ID_PREFIX}': skill-initiated request ids must not collide with daemon-initiated ids`,
      });
      return;
    }

    // Subscribe-close is a built-in control message handled by the server.
    if (req.method === SKILL_IPC_SUBSCRIBE_CLOSE_METHOD) {
      this.handleSubscribeClose(socket, req);
      return;
    }

    const streamingHandler = this.streamingMethods.get(req.method);
    if (streamingHandler) {
      this.handleStreamingRequest(socket, req, streamingHandler);
      return;
    }

    const handler = this.methods.get(req.method);
    if (!handler) {
      this.sendResponse(socket, {
        id: req.id,
        error: `Unknown method: ${req.method}`,
      });
      return;
    }

    try {
      const connection = this.connections.get(socket);
      const result = handler(req.params, connection);
      if (result instanceof Promise) {
        result
          .then((value) => {
            this.sendResponse(socket, { id: req.id, result: value });
          })
          .catch((err) => {
            log.warn({ err, method: req.method }, "Skill IPC handler error");
            this.sendResponse(socket, {
              id: req.id,
              error: String(err),
            });
          });
      } else {
        this.sendResponse(socket, { id: req.id, result });
      }
    } catch (err) {
      log.warn({ err, method: req.method }, "Skill IPC handler error");
      this.sendResponse(socket, {
        id: req.id,
        error: String(err),
      });
    }
  }

  private handleStreamingRequest(
    socket: Socket,
    req: IpcRequest,
    handler: SkillIpcStreamingHandler,
  ): void {
    // Reject duplicate stream ids on the same socket so late deliveries
    // on a zombie id never confuse the client's correlation table.
    const existing = this.subscriptions.get(socket);
    if (existing?.has(req.id)) {
      this.sendResponse(socket, {
        id: req.id,
        error: `Stream id already active: ${req.id}`,
      });
      return;
    }

    let active = true;
    let userDispose: (() => void) | null = null;

    const close = (errorMessage?: string): void => {
      if (!active) return;
      active = false;
      if (errorMessage && !socket.destroyed) {
        try {
          socket.write(
            JSON.stringify({ id: req.id, error: errorMessage }) + "\n",
          );
        } catch (err) {
          log.warn(
            { err, method: req.method },
            "Skill IPC streaming close write error",
          );
        }
      }
      if (userDispose) {
        try {
          userDispose();
        } catch (err) {
          log.warn(
            { err, method: req.method },
            "Skill IPC streaming dispose error",
          );
        }
      }
      this.subscriptions.get(socket)?.delete(req.id);
    };

    const stream: SkillIpcStream = {
      id: req.id,
      get active() {
        return active;
      },
      send: (payload) => {
        if (!active || socket.destroyed) return;
        // Fail-fast on slow/stalled consumers: when Node has more than
        // STREAM_BACKPRESSURE_BYTES queued in user-space, terminate the
        // stream rather than letting the buffer grow unbounded. The
        // client sees a terminal error frame and the hub subscription
        // is disposed in the same call.
        if (socket.writableLength > STREAM_BACKPRESSURE_BYTES) {
          close(
            `Stream ${req.id} closed: client not draining (socket buffer exceeded ${STREAM_BACKPRESSURE_BYTES} bytes)`,
          );
          return;
        }
        socket.write(
          JSON.stringify({
            id: req.id,
            event: "delivery",
            payload,
          }) + "\n",
        );
      },
      close,
    };

    try {
      userDispose = handler(stream, req.params);
    } catch (err) {
      log.warn(
        { err, method: req.method },
        "Skill IPC streaming handler error",
      );
      this.sendResponse(socket, { id: req.id, error: String(err) });
      return;
    }

    const map = existing ?? new Map<string, () => void>();
    if (!existing) this.subscriptions.set(socket, map);
    map.set(req.id, () => close());

    // Acknowledge the subscription open so the client can flip its
    // correlation entry from "pending" to "streaming" before deliveries
    // start arriving.
    this.sendResponse(socket, {
      id: req.id,
      result: { subscribed: true },
    });
  }

  private handleSubscribeClose(socket: Socket, req: IpcRequest): void {
    const subscribeId =
      req.params && typeof req.params.subscribeId === "string"
        ? req.params.subscribeId
        : null;
    if (!subscribeId) {
      this.sendResponse(socket, {
        id: req.id,
        error: "Missing 'subscribeId' param",
      });
      return;
    }

    const map = this.subscriptions.get(socket);
    const dispose = map?.get(subscribeId);
    if (dispose) {
      dispose();
      map!.delete(subscribeId);
    }
    this.sendResponse(socket, {
      id: req.id,
      result: { closed: true },
    });
  }

  private handleDaemonResponse(
    socket: Socket,
    frame: { id: string; result?: unknown; error?: string },
  ): void {
    const connection = this.connections.get(socket);
    if (!connection) return;
    const pending = connection.pendingDaemonRequests.get(frame.id);
    if (!pending) {
      // Either a duplicate/late response or a frame for a request the
      // server already timed out. Drop silently — it would have already
      // settled the caller's promise.
      return;
    }
    connection.pendingDaemonRequests.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error !== undefined) {
      pending.reject(new Error(String(frame.error)));
    } else {
      pending.resolve(frame.result);
    }
  }

  private teardownConnection(socket: Socket): void {
    const connection = this.connections.get(socket);
    if (!connection) return;
    connection.dispose();
    this.connections.delete(socket);
  }

  private teardownSubscriptions(socket: Socket): void {
    const map = this.subscriptions.get(socket);
    if (!map) return;
    for (const dispose of map.values()) {
      try {
        dispose();
      } catch (err) {
        log.warn({ err }, "Skill IPC teardown dispose error");
      }
    }
    map.clear();
    this.subscriptions.delete(socket);
  }

  private sendResponse(socket: Socket, response: IpcResponse): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(response) + "\n");
    }
  }
}
