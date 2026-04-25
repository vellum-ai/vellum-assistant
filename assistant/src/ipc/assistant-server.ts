/**
 * Assistant IPC server — exposes daemon capabilities to CLI commands and external
 * processes over a Unix domain socket.
 *
 * This is the preferred method of inter-process communication between the
 * CLI and the daemon. File-based signals and the HTTP port are deprecated
 * in favor of this IPC socket.
 *
 * Protocol: newline-delimited JSON over a Unix domain socket.
 * - Request:  { "id": string, "method": string, "params"?: Record<string, unknown> }
 * - Response: { "id": string, "result"?: unknown, "error"?: string }
 *
 * The preferred socket path is `{workspaceDir}/assistant.sock`. On
 * platforms with strict AF_UNIX path limits (notably macOS), the server falls
 * back to a shorter deterministic path so CLI commands can still connect.
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { getLogger } from "../util/logger.js";
import { cliIpcRoutes } from "./routes/index.js";
import { ensureSocketPathFree } from "./socket-cleanup.js";
import { resolveIpcSocketPath } from "./socket-path.js";

const log = getLogger("assistant-ipc-server");

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

export type IpcMethodHandler = (
  params?: Record<string, unknown>,
  connection?: unknown,
) => unknown | Promise<unknown>;

/** A single IPC route definition — method name + handler function. */
export type IpcRoute = {
  method: string;
  handler: IpcMethodHandler;
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class AssistantIpcServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private methods = new Map<string, IpcMethodHandler>();
  private socketPath: string;

  constructor() {
    const resolution = resolveIpcSocketPath("assistant");
    this.socketPath = resolution.path;
    log.info(
      { source: resolution.source, path: resolution.path },
      "Assistant IPC socket path resolved",
    );
    for (const route of cliIpcRoutes) {
      this.methods.set(route.method, route.handler);
    }
  }

  /** Register an additional method handler after construction. */
  registerMethod(method: string, handler: IpcMethodHandler): void {
    this.methods.set(method, handler);
  }

  /** Start listening on the Unix domain socket. */
  async start(): Promise<void> {
    // Ensure the parent directory exists before listening.
    const socketDir = dirname(this.socketPath);
    if (!existsSync(socketDir)) {
      mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    }

    // Probe before unlink so a second daemon can't silently orphan an active
    // listener (Unix lets you unlink a still-bound socket file). See
    // `ensureSocketPathFree` for the behavior matrix.
    await ensureSocketPathFree(this.socketPath);

    this.server = createServer((socket) => {
      this.clients.add(socket);
      log.debug("IPC client connected");

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
        log.debug("IPC client disconnected");
      });

      socket.on("error", (err) => {
        log.warn({ err }, "IPC client socket error");
        this.clients.delete(socket);
      });
    });

    this.server.on("error", (err) => {
      log.error({ err }, "Assistant IPC server error");
    });

    this.server.listen(this.socketPath, () => {
      log.info({ path: this.socketPath }, "Assistant IPC server listening");
    });
  }

  /** Stop the server and disconnect all clients. */
  stop(): void {
    for (const client of this.clients) {
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

    const handler = this.methods.get(req.method);
    if (!handler) {
      this.sendResponse(socket, {
        id: req.id,
        error: `Unknown method: ${req.method}`,
      });
      return;
    }

    try {
      const result = handler(req.params);
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

export function getAssistantSocketPath(): string {
  return resolveIpcSocketPath("assistant").path;
}
