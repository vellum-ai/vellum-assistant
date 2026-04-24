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
 * One-shot RPC:
 * - Request:  { "id": string, "method": string, "params"?: Record<string, unknown> }
 * - Response: { "id": string, "result"?: unknown, "error"?: string }
 *
 * Streaming RPC (e.g. `host.events.subscribe`):
 * - Request:    { "id": string, "method": string, "params"?: Record<string, unknown> }
 * - Open ack:   { "id": string, "result": { "subscribed": true } }
 * - Deliveries: { "id": string, "event": "delivery", "payload": <data> } (0..N)
 * - Error:      { "id": string, "error": string } (terminal)
 * - Close req:  { "id": "<ctrl-id>", "method": "host.events.subscribe.close",
 *                 "params": { "subscribeId": "<original-id>" } }
 * - Close ack:  { "id": "<ctrl-id>", "result": { "closed": true } }
 *
 * The preferred socket path is `{workspaceDir}/assistant-skill.sock`. On
 * platforms with strict AF_UNIX path limits (notably macOS), the server falls
 * back to a shorter deterministic path via the shared socket-path resolver.
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import {
  type SkillRouteHandle,
  unregisterSkillRoute,
} from "../runtime/skill-route-registry.js";
import { unregisterSkillTools } from "../tools/registry.js";
import { getLogger } from "../util/logger.js";
import type {
  IpcMethodHandler,
  IpcRequest,
  IpcResponse,
} from "./cli-server.js";
import {
  skillIpcRoutes,
  skillIpcStreamingRoutes,
} from "./skill-routes/index.js";
import { resolveSkillIpcSocketPath } from "./skill-socket-path.js";

const log = getLogger("skill-ipc-server");

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Well-known control method the client sends to close an open stream. The
 * server also tears down on socket close / daemon shutdown, so this is only
 * needed when the client wants to keep the socket but end one subscription.
 */
export const SKILL_IPC_SUBSCRIBE_CLOSE_METHOD =
  "host.events.subscribe.close" as const;

/** Stream handle passed to streaming-handler implementations. */
export interface SkillIpcStream {
  /** The original request id that opened this stream (used as the stream id). */
  readonly id: string;
  /**
   * Send a delivery frame to the client. No-op after the stream has been
   * closed (client disconnect, explicit close, or server shutdown).
   */
  send(payload: unknown): void;
  /** True until the stream has been disposed. */
  readonly active: boolean;
}

/**
 * Handler signature for long-lived streaming methods (e.g.
 * `host.events.subscribe`). Runs synchronously with the opening request and
 * returns a dispose callback that the server invokes on client disconnect,
 * explicit close, or server shutdown.
 */
export type SkillIpcStreamingHandler = (
  stream: SkillIpcStream,
  params?: Record<string, unknown>,
) => () => void;

/** Long-lived streaming route — method name + handler function. */
export type SkillIpcStreamingRoute = {
  method: string;
  handler: SkillIpcStreamingHandler;
};

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
   * Mark a skill id as having registered tools on this connection. On
   * disconnect the server calls `unregisterSkillTools(skillId)` once per
   * tracked id so the ref-counted tool registry drops the contribution.
   */
  addSkillToolsOwner(skillId: string): void;
}

class SkillIpcConnectionState implements SkillIpcConnection {
  readonly connectionId: string;
  private routeHandlesBySkill = new Map<string, SkillRouteHandle[]>();
  private skillToolOwners = new Set<string>();

  constructor(connectionId: string) {
    this.connectionId = connectionId;
  }

  addRouteHandle(skillId: string, handle: SkillRouteHandle): void {
    const list = this.routeHandlesBySkill.get(skillId) ?? [];
    list.push(handle);
    this.routeHandlesBySkill.set(skillId, list);
  }

  addSkillToolsOwner(skillId: string): void {
    this.skillToolOwners.add(skillId);
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
    for (const skillId of this.skillToolOwners) {
      try {
        unregisterSkillTools(skillId);
      } catch (err) {
        log.warn(
          { err, connectionId: this.connectionId, skillId },
          "skill IPC disconnect: failed to unregister skill tools",
        );
      }
    }
    this.skillToolOwners.clear();
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface SkillIpcServerOptions {
  /** Override the socket path (tests). Defaults to the resolver output. */
  socketPath?: string;
}

export class SkillIpcServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private methods = new Map<string, IpcMethodHandler>();
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

  constructor(options: SkillIpcServerOptions = {}) {
    if (options.socketPath) {
      this.socketPath = options.socketPath;
    } else {
      const socketResolution = resolveSkillIpcSocketPath();
      this.socketPath = socketResolution.path;
      if (socketResolution.source !== "workspace") {
        log.warn(
          {
            source: socketResolution.source,
            workspacePath: socketResolution.workspacePath,
            resolvedPath: socketResolution.path,
            maxPathBytes: socketResolution.maxPathBytes,
          },
          "Skill IPC socket path exceeded platform limit; using fallback path",
        );
      }
    }
    for (const route of skillIpcRoutes) {
      this.methods.set(route.method, route.handler);
    }
    for (const route of skillIpcStreamingRoutes) {
      this.streamingMethods.set(route.method, route.handler);
    }
  }

  /** Register an additional method handler after construction. */
  registerMethod(method: string, handler: IpcMethodHandler): void {
    this.methods.set(method, handler);
  }

  /** Register an additional streaming handler after construction. */
  registerStreamingMethod(
    method: string,
    handler: SkillIpcStreamingHandler,
  ): void {
    this.streamingMethods.set(method, handler);
  }

  /** Start listening on the Unix domain socket. */
  async start(): Promise<void> {
    // Ensure the parent directory exists before listening.
    const socketDir = dirname(this.socketPath);
    if (!existsSync(socketDir)) {
      mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    }

    // Probe-connect before unlinking: Unix sockets can be unlinked while still
    // bound, so a blind `unlinkSync` on a live path would silently orphan
    // another daemon's listener. Only unlink when the connect fails with
    // ECONNREFUSED (stale file from a previous crash) / ENOENT (race with
    // removal) — fail fast on a successful connect.
    await ensureSocketPathFree(this.socketPath);

    this.server = createServer((socket) => {
      this.clients.add(socket);
      const connection = new SkillIpcConnectionState(
        `skill-ipc-${this.nextConnectionId++}`,
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

    this.server.on("error", (err) => {
      log.error({ err }, "Skill IPC server error");
    });

    this.server.listen(this.socketPath, () => {
      log.info({ path: this.socketPath }, "Skill IPC server listening");
    });
  }

  /** Stop the server and disconnect all clients. */
  stop(): void {
    for (const client of this.clients) {
      this.teardownSubscriptions(client);
      this.teardownConnection(client);
      if (!client.destroyed) client.destroy();
    }
    this.clients.clear();

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

  // ── Internal ──────────────────────────────────────────────────────────

  private handleMessage(socket: Socket, line: string): void {
    let req: IpcRequest;
    try {
      req = JSON.parse(line) as IpcRequest;
    } catch {
      this.sendResponse(socket, {
        id: "unknown",
        error: "Invalid JSON",
      });
      return;
    }

    if (
      !req ||
      typeof req !== "object" ||
      Array.isArray(req) ||
      !req.id ||
      !req.method
    ) {
      const id =
        req &&
        typeof req === "object" &&
        !Array.isArray(req) &&
        typeof req.id === "string"
          ? req.id
          : "unknown";
      this.sendResponse(socket, {
        id,
        error: "Missing 'id' or 'method' field",
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
    const stream: SkillIpcStream = {
      id: req.id,
      get active() {
        return active;
      },
      send: (payload) => {
        if (!active || socket.destroyed) return;
        socket.write(
          JSON.stringify({
            id: req.id,
            event: "delivery",
            payload,
          }) + "\n",
        );
      },
    };

    let dispose: () => void;
    try {
      dispose = handler(stream, req.params);
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
    map.set(req.id, () => {
      if (!active) return;
      active = false;
      try {
        dispose();
      } catch (err) {
        log.warn(
          { err, method: req.method },
          "Skill IPC streaming dispose error",
        );
      }
    });

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

/**
 * Probe-connect to `socketPath`. If a live listener answers, reject so the
 * caller can surface `EADDRINUSE`-style errors instead of silently hijacking
 * the path. If the connect fails with `ECONNREFUSED`/`ENOENT`, the file is a
 * stale leftover and we unlink it. Any other error propagates.
 */
async function ensureSocketPathFree(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  await new Promise<void>((resolve, reject) => {
    const client = connect(socketPath);
    client.once("connect", () => {
      client.end();
      reject(
        new Error(`EADDRINUSE: another daemon is listening at ${socketPath}`),
      );
    });
    client.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
        try {
          unlinkSync(socketPath);
        } catch {
          // Ignore — may already be gone
        }
        resolve();
      } else {
        reject(err);
      }
    });
  });
}
