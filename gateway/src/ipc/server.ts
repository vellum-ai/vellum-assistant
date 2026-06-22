/**
 * Gateway IPC server — exposes gateway data to the assistant daemon over a
 * Unix domain socket.
 *
 * Protocol: newline-delimited JSON over a Unix domain socket.
 * - Request:  { "id": string, "method": string, "params"?: Record<string, unknown> }
 * - Response: { "id": string, "result"?: unknown, "error"?: string }
 * - Event:    { "event": string, "data"?: unknown }  (server → client push, no id)
 *
 * The preferred socket path is `{workspaceDir}/gateway.sock` on the shared
 * volume. On platforms with strict AF_UNIX path limits, the server falls back
 * to a shorter deterministic path.
 *
 * Resilience: a {@link SocketWatchdog} re-binds the listening socket when its
 * on-disk path entry is removed (e.g. by a tmpfs sweep or rogue cleanup of
 * `/run/*`). Existing connected sockets survive the re-bind because the
 * kernel keeps connection inodes alive independently of the listener path;
 * only new `connect()` calls require the path to exist.
 */

import {
  SocketWatchdog,
  ensureSocketDir,
} from "@vellumai/ipc-server-utils";
import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

import type { z } from "zod";

import { getLogger } from "../logger.js";
import { resolveIpcSocketPath } from "./socket-path.js";

const log = getLogger("ipc-server");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IpcRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

/**
 * NDJSON IPC response envelope.
 *
 * Error responses are ADDITIVE: a thrown error that carries a numeric
 * `statusCode` and/or a string error code is mirrored into `statusCode`/
 * `errorCode` (and `errorDetails` when present) ALONGSIDE the existing
 * `error` string. Errors without those fields serialize exactly as before
 * (just `{ id, error }`), so consumers reading only `error` keep working.
 * The daemon relay (`PersistentIpcClient.call`) reads `statusCode`/
 * `errorCode`/`errorDetails` to surface invite user-errors (4xx) instead of
 * statusless IPC failures.
 */
export type IpcResponse = {
  id: string;
  result?: unknown;
  error?: string;
  /** HTTP-style status code mirrored from a typed error's `statusCode`. */
  statusCode?: number;
  /** Machine-readable error code mirrored from a typed error's `code`. */
  errorCode?: string;
  /** Structured error payload mirrored from a typed error's `details`. */
  errorDetails?: unknown;
};

export type IpcEvent = {
  event: string;
  data?: unknown;
};

export type IpcMethodHandler = (
  params?: Record<string, unknown>,
) => unknown | Promise<unknown>;

/** A single IPC route definition — method name + handler function. */
export type IpcRoute = {
  method: string;
  schema?: z.ZodType;
  handler: IpcMethodHandler;
};

/** Optional configuration for {@link GatewayIpcServer}. */
export interface GatewayIpcServerOptions {
  /**
   * How often the socket-file watchdog stats the listening socket path.
   * Set to `0` to disable. Defaults to {@link SocketWatchdog}'s 5000ms.
   */
  watchdogIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class GatewayIpcServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private methods = new Map<string, IpcMethodHandler>();
  private schemas = new Map<string, z.ZodType>();
  private socketPath: string;
  private watchdog: SocketWatchdog;
  /**
   * Servers whose listener path has been replaced by a re-bind. Kept around
   * so that already-connected sockets continue to work; closed gracefully
   * once their accept loops drain.
   */
  private legacyServers = new Set<Server>();

  constructor(routes?: IpcRoute[], options?: GatewayIpcServerOptions) {
    const resolution = resolveIpcSocketPath("gateway");
    this.socketPath = resolution.path;
    log.info(
      { source: resolution.source, path: resolution.path },
      "Gateway IPC socket path resolved",
    );
    if (routes) {
      for (const route of routes) {
        this.methods.set(route.method, route.handler);
        if (route.schema) {
          this.schemas.set(route.method, route.schema);
        }
      }
    }

    this.watchdog = new SocketWatchdog({
      socketPath: this.socketPath,
      intervalMs: options?.watchdogIntervalMs,
      getServer: () => this.server,
      createServer: () => this.createListeningServer(),
      onRebind: (newServer, oldServer) => {
        this.server = newServer;
        // Move the previous listener into the legacy set so already-
        // connected clients keep their accept loop alive. close() stops
        // accepting new connections (which the kernel already won't route
        // here anyway after the path moved) but lets in-flight sockets
        // drain.
        this.legacyServers.add(oldServer);
        oldServer.close(() => {
          this.legacyServers.delete(oldServer);
        });
      },
      log,
    });
  }

  /** Start listening on the Unix domain socket. */
  start(): void {
    // Ensure the parent directory exists — on a fresh hatch the workspace
    // dir may not have been created yet when the IPC server starts.
    ensureSocketDir(this.socketPath);

    // Clean up stale socket file from a previous run
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore — may already be gone
      }
    }

    this.server = this.createListeningServer();
    this.server.listen(this.socketPath, () => {
      log.info({ path: this.socketPath }, "IPC server listening");
    });

    this.watchdog.start();
  }

  /** Stop the server and disconnect all clients. */
  stop(): void {
    this.watchdog.stop();

    for (const socket of this.clients) {
      if (!socket.destroyed) {
        socket.destroy();
      }
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

    // Clean up socket file
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore
      }
    }
  }

  /** Push an event to all connected clients. */
  emit(event: string, data?: unknown): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify({ event, data } satisfies IpcEvent) + "\n";
    for (const socket of this.clients) {
      if (!socket.destroyed) {
        socket.write(payload);
      }
    }
  }

  /** Get the socket path (for testing / diagnostics). */
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
    const server = createServer((socket) => this.handleConnection(socket));
    server.on("error", (err) => {
      log.error({ err }, "IPC server error");
    });
    return server;
  }

  private handleConnection(socket: Socket): void {
    // The assistant maintains a persistent connection for hot-path RPCs
    // (classify_risk) alongside short-lived one-shot connections for other
    // calls. Track all of them so a new one-shot connection does not tear
    // down the persistent socket and reject its in-flight requests.
    this.clients.add(socket);
    log.debug("IPC client connected");

    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      // Process complete newline-delimited messages
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
      log.debug("IPC client disconnected");
    });

    socket.on("error", (err) => {
      log.warn({ err }, "IPC client socket error");
      this.clients.delete(socket);
    });
  }

  private handleMessage(socket: Socket, line: string): void {
    let req: IpcRequest;
    try {
      req = JSON.parse(line) as IpcRequest;
    } catch {
      this.sendResponse(
        socket,
        buildProtocolErrorResponse("unknown", "Invalid JSON", 400, "BAD_REQUEST"),
      );
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
      this.sendResponse(
        socket,
        buildProtocolErrorResponse(
          id,
          "Missing 'id' or 'method' field",
          400,
          "BAD_REQUEST",
        ),
      );
      return;
    }

    const handler = this.methods.get(req.method);
    if (!handler) {
      this.sendResponse(
        socket,
        buildProtocolErrorResponse(
          req.id,
          `Unknown method: ${req.method}`,
          404,
          "UNKNOWN_METHOD",
        ),
      );
      return;
    }

    // Validate params against Zod schema if one was registered for this method.
    const schema = this.schemas.get(req.method);
    let parsedParams: Record<string, unknown> | undefined = req.params;
    if (schema) {
      const result = schema.safeParse(req.params);
      if (!result.success) {
        this.sendResponse(
          socket,
          buildProtocolErrorResponse(
            req.id,
            `Invalid params: ${result.error.message}`,
            400,
            "BAD_REQUEST",
          ),
        );
        return;
      }
      parsedParams = result.data as Record<string, unknown>;
    }

    try {
      const result = handler(parsedParams);
      if (result instanceof Promise) {
        result
          .then((value) => {
            this.sendResponse(socket, { id: req.id, result: value });
          })
          .catch((err) => {
            log.warn({ err, method: req.method }, "IPC handler error");
            this.sendResponse(socket, buildErrorResponse(req.id, err));
          });
      } else {
        this.sendResponse(socket, { id: req.id, result });
      }
    } catch (err) {
      log.warn({ err, method: req.method }, "IPC handler error");
      this.sendResponse(socket, buildErrorResponse(req.id, err));
    }
  }

  private sendResponse(socket: Socket, response: IpcResponse): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(response) + "\n");
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getDefaultSocketPath(): string {
  return resolveIpcSocketPath("gateway").path;
}

/**
 * Build the IPC error envelope for a thrown handler error.
 *
 * Always includes `error: String(err)`. When the error DUCK-TYPES as a
 * client-facing typed error — a numeric `statusCode` and/or a string `code`
 * — those are mirrored ADDITIVELY into `statusCode`/`errorCode` (and
 * `errorDetails` from `details` when present). This covers both
 * `InviteNativeError` and the assistant `IpcHandlerError` (and any future
 * typed error) without importing or requiring a specific class. Plain
 * `Error`s serialize as before: just `{ id, error }`.
 */
/**
 * Build the IPC error envelope for an early-return PROTOCOL/VALIDATION
 * failure — one detected before any handler runs (bad JSON, missing
 * `id`/`method`, unknown method, Zod schema rejection).
 *
 * Stamps a `statusCode` + `errorCode` so the daemon relay
 * (`PersistentIpcClient.call` → `IpcCallError` → `RouteError`) surfaces these
 * as proper client 4xx instead of defaulting to 500. ADDITIVE: the `error`
 * string is unchanged, so consumers reading only `error` keep working.
 */
export function buildProtocolErrorResponse(
  id: string,
  error: string,
  statusCode: number,
  errorCode: string,
): IpcResponse {
  return { id, error, statusCode, errorCode };
}

export function buildErrorResponse(id: string, err: unknown): IpcResponse {
  const response: IpcResponse = { id, error: String(err) };
  if (err && typeof err === "object") {
    const e = err as { statusCode?: unknown; code?: unknown; details?: unknown };
    if (typeof e.statusCode === "number") response.statusCode = e.statusCode;
    if (typeof e.code === "string") response.errorCode = e.code;
    if (e.details !== undefined) response.errorDetails = e.details;
  }
  return response;
}
