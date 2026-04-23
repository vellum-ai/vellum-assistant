/**
 * Skill IPC server — exposes daemon (host) capabilities to first-party skill
 * processes over a Unix domain socket.
 *
 * Separate from the CLI IPC server so skill traffic (host.log, host.config.*,
 * host.events.*, host.registries.*, etc.) stays off the CLI socket and can
 * evolve its own long-lived subscribe streams.
 *
 * Protocol: newline-delimited JSON over a Unix domain socket.
 * - Request:  { "id": string, "method": string, "params"?: Record<string, unknown> }
 * - Response: { "id": string, "result"?: unknown, "error"?: string }
 *
 * The preferred socket path is `{workspaceDir}/assistant-skill.sock`. On
 * platforms with strict AF_UNIX path limits (notably macOS), the server falls
 * back to a shorter deterministic path via the shared socket-path resolver.
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { getLogger } from "../util/logger.js";
import type {
  IpcMethodHandler,
  IpcRequest,
  IpcResponse,
} from "./cli-server.js";
import { skillIpcRoutes } from "./skill-routes/index.js";
import { resolveSkillIpcSocketPath } from "./skill-socket-path.js";

const log = getLogger("skill-ipc-server");

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
  }

  /** Register an additional method handler after construction. */
  registerMethod(method: string, handler: IpcMethodHandler): void {
    this.methods.set(method, handler);
  }

  /** Start listening on the Unix domain socket. */
  start(): void {
    // Ensure the parent directory exists before listening.
    const socketDir = dirname(this.socketPath);
    if (!existsSync(socketDir)) {
      mkdirSync(socketDir, { recursive: true, mode: 0o700 });
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
      this.clients.add(socket);
      log.debug("Skill IPC client connected");

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
        log.debug("Skill IPC client disconnected");
      });

      socket.on("error", (err) => {
        log.warn({ err }, "Skill IPC client socket error");
        this.clients.delete(socket);
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

  private sendResponse(socket: Socket, response: IpcResponse): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(response) + "\n");
    }
  }
}
