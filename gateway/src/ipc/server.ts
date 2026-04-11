/**
 * Gateway IPC server — exposes gateway data to the assistant daemon over a
 * Unix domain socket.
 *
 * Protocol: newline-delimited JSON over a Unix domain socket.
 * - Request:  { "id": string, "method": string, "params"?: Record<string, unknown> }
 * - Response: { "id": string, "result"?: unknown, "error"?: string }
 * - Event:    { "event": string, "data"?: unknown }  (server → client push, no id)
 *
 * The socket lives at `{workspaceDir}/gateway.sock` on the shared volume so
 * the assistant container can connect to it.
 */

import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { getWorkspaceDir } from "../credential-reader.js";
import { getLogger } from "../logger.js";

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

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class GatewayIpcServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private methods = new Map<string, IpcMethodHandler>();
  private socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath ?? getDefaultSocketPath();
  }

  /** Register an IPC method handler. */
  handle(method: string, handler: IpcMethodHandler): void {
    this.methods.set(method, handler);
  }

  /** Start listening on the Unix domain socket. */
  start(): void {
    // Clean up stale socket file from a previous run
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore — may already be gone
      }
    }

    this.server = createServer((socket) => {
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
    for (const client of this.clients) {
      client.destroy();
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

  /** Broadcast an event to all connected clients. */
  emit(event: string, data?: unknown): void {
    const msg: IpcEvent = { event, data };
    const line = JSON.stringify(msg) + "\n";
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(line);
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

    if (!req.id || !req.method) {
      this.sendResponse(socket, {
        id: req.id ?? "unknown",
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

export function getDefaultSocketPath(): string {
  return join(getWorkspaceDir(), "gateway.sock");
}
