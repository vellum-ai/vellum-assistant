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
 * Resilience: the server runs a watchdog timer that re-binds the listening
 * socket when its on-disk path entry has been removed (e.g. by a tmpfs sweep
 * or rogue cleanup of `/run/*`). Existing connected sockets survive the
 * re-bind because the kernel keeps connection inodes alive independently of
 * the listener path; only new `connect()` calls require the path to exist.
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

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

export type IpcResponse = {
  id: string;
  result?: unknown;
  error?: string;
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
   * How often to check whether the listening socket path still exists on
   * disk. When the path has been removed (tmpfs sweep, manual `rm`, etc.)
   * the server re-binds atomically. Set to `0` to disable. Defaults to
   * 5000ms.
   */
  watchdogIntervalMs?: number;
}

const DEFAULT_WATCHDOG_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class GatewayIpcServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private methods = new Map<string, IpcMethodHandler>();
  private schemas = new Map<string, z.ZodType>();
  private socketPath: string;
  private watchdogIntervalMs: number;
  private watchdogHandle: ReturnType<typeof setInterval> | null = null;
  /**
   * Servers whose listener path has been replaced by a re-bind. Kept around
   * so that already-connected sockets continue to work; closed once their
   * accept loops shut down (which happens immediately because the path no
   * longer routes new connects to them).
   */
  private legacyServers = new Set<Server>();

  constructor(routes?: IpcRoute[], options?: GatewayIpcServerOptions) {
    const resolution = resolveIpcSocketPath("gateway");
    this.socketPath = resolution.path;
    this.watchdogIntervalMs =
      options?.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
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
  }

  /** Start listening on the Unix domain socket. */
  start(): void {
    // Ensure the parent directory exists — on a fresh hatch the workspace
    // dir may not have been created yet when the IPC server starts.
    this.ensureSocketDir();

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

    if (this.watchdogIntervalMs > 0 && this.watchdogHandle === null) {
      this.watchdogHandle = setInterval(() => {
        // Catch synchronous throws from the entry path of rebindIfMissing
        // (e.g. ensureSocketDir → mkdirSync EACCES) so the timer doesn't
        // spew unhandled-rejection noise every 5s on a read-only fs.
        this.rebindIfMissing().catch((err) => {
          log.error(
            { err, path: this.socketPath },
            "Watchdog rebind failed unexpectedly",
          );
        });
      }, this.watchdogIntervalMs);
      // Don't keep the event loop alive just for this watchdog.
      this.watchdogHandle.unref?.();
    }
  }

  /** Stop the server and disconnect all clients. */
  stop(): void {
    if (this.watchdogHandle !== null) {
      clearInterval(this.watchdogHandle);
      this.watchdogHandle = null;
    }

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
   * performed, `false` when the socket was already healthy or the server
   * is not running.
   */
  async rebindIfMissing(): Promise<boolean> {
    if (this.server === null) return false;
    if (existsSync(this.socketPath)) return false;

    // Snapshot the current listener so we can detect a generation change
    // (stop()/restart/concurrent rebind) after the async listen() resolves.
    const initialServer = this.server;

    log.warn(
      { path: this.socketPath },
      "IPC socket path missing on disk — re-binding listener",
    );

    this.ensureSocketDir();

    const newServer = this.createListeningServer();
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: unknown) => {
          newServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          newServer.off("error", onError);
          resolve();
        };
        newServer.once("error", onError);
        newServer.once("listening", onListening);
        newServer.listen(this.socketPath);
      });
    } catch (err) {
      log.error(
        { err, path: this.socketPath },
        "Failed to re-bind IPC socket — will retry on next watchdog tick",
      );
      // Best-effort cleanup of the half-initialized server.
      try {
        newServer.close();
      } catch {
        /* ignore */
      }
      return false;
    }

    // Race guard: while we were awaiting listen(), stop() may have
    // cleared this.server, or some other path may have replaced it.
    // Installing newServer now would resurrect the listener after
    // shutdown (keeping the process alive and accepting IPC again).
    // Discard the new server instead.
    if (this.server !== initialServer) {
      try {
        newServer.close();
      } catch {
        /* ignore */
      }
      // newServer.listen() recreated the path on disk; stop() may have
      // already unlinked it, but if our listen won the race the file
      // is sitting there — clean it up so it doesn't shadow a future
      // start().
      if (existsSync(this.socketPath)) {
        try {
          unlinkSync(this.socketPath);
        } catch {
          /* ignore */
        }
      }
      log.warn(
        { path: this.socketPath },
        "IPC server state changed during rebind — discarded new listener",
      );
      return false;
    }

    // Move the previous listener into the legacy set so already-connected
    // clients keep their accept loop alive. Close it gracefully — `close()`
    // stops accepting new connections (which the kernel already won't route
    // here anyway after the path moved) but lets in-flight sockets drain.
    this.server = newServer;
    this.legacyServers.add(initialServer);
    initialServer.close(() => {
      this.legacyServers.delete(initialServer);
    });

    log.info({ path: this.socketPath }, "IPC socket re-bound after path loss");
    return true;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private ensureSocketDir(): void {
    const socketDir = dirname(this.socketPath);
    if (!existsSync(socketDir)) {
      mkdirSync(socketDir, { recursive: true });
    }
  }

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

    const handler = this.methods.get(req.method);
    if (!handler) {
      this.sendResponse(socket, {
        id: req.id,
        error: `Unknown method: ${req.method}`,
      });
      return;
    }

    // Validate params against Zod schema if one was registered for this method.
    const schema = this.schemas.get(req.method);
    let parsedParams: Record<string, unknown> | undefined = req.params;
    if (schema) {
      const result = schema.safeParse(req.params);
      if (!result.success) {
        this.sendResponse(socket, {
          id: req.id,
          error: `Invalid params: ${result.error.message}`,
        });
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
            this.sendResponse(socket, {
              id: req.id,
              error: String(err),
            });
          });
      } else {
        this.sendResponse(socket, { id: req.id, result });
      }
    } catch (err) {
      log.warn({ err, method: req.method }, "IPC handler error");
      this.sendResponse(socket, {
        id: req.id,
        error: String(err),
      });
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
