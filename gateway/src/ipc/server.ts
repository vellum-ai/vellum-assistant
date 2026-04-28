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

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class GatewayIpcServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private methods = new Map<string, IpcMethodHandler>();
  private schemas = new Map<string, z.ZodType>();
  private socketPath: string;

  constructor(routes?: IpcRoute[]) {
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
  }

  /** Start listening on the Unix domain socket. */
  start(): void {
    // Ensure the parent directory exists — on a fresh hatch the workspace
    // dir may not have been created yet when the IPC server starts.
    const socketDir = dirname(this.socketPath);
    if (!existsSync(socketDir)) {
      mkdirSync(socketDir, { recursive: true });
    }

    // Clean up stale socket file from a previous run
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore — may already be gone
      }
    }

    this.server = createServer((socket) => {
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
    });

    this.server.on("error", (err) => {
      log.error({ err }, "IPC server error");
    });

    this.server.listen(this.socketPath, () => {
      log.info({ path: this.socketPath }, "IPC server listening");
    });
  }

  /** Stop the server and disconnect all clients. */
  stop(): void {
    for (const socket of this.clients) {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
    this.clients.clear();

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
