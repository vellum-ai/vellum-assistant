/**
 * Assistant-side IPC client for communicating with the gateway.
 *
 * Connects to the gateway's Unix domain socket and provides typed methods
 * for reading gateway-owned data. Protocol: newline-delimited JSON
 * (same as gateway/src/ipc/server.ts).
 *
 * The preferred socket path is `{workspaceDir}/gateway.sock`, with a
 * deterministic fallback for long AF_UNIX paths.
 */

import { connect, type Socket } from "node:net";

import { getLogger } from "../util/logger.js";
import { resolveIpcSocketPath } from "./socket-path.js";

const log = getLogger("gateway-ipc-client");

// ---------------------------------------------------------------------------
// Types (mirror gateway/src/ipc/server.ts protocol)
// ---------------------------------------------------------------------------

type IpcRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type IpcResponse = {
  id: string;
  result?: unknown;
  error?: string;
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const DEFAULT_CALL_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 3_000;

/**
 * One-shot IPC helper: connect, call a method, disconnect.
 *
 * Designed for CLI and daemon startup where we need a single RPC call
 * without leaving open handles. Returns `undefined` on any failure
 * (socket not found, timeout, parse error) so callers can fall back.
 */
export async function ipcCall(
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const socketPath = getGatewaySocketPath();

  return new Promise<unknown>((resolve) => {
    let settled = false;
    let callTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (callTimer) clearTimeout(callTimer);
      socket.destroy();
      resolve(value);
    };

    const connectTimer = setTimeout(() => {
      log.warn(
        { method, socketPath, timeoutMs: CONNECT_TIMEOUT_MS },
        "IPC connect timed out",
      );
      finish(undefined);
    }, CONNECT_TIMEOUT_MS);

    const socket: Socket = connect(socketPath);
    // Prevent the socket from keeping the process alive (important for
    // one-shot CLI commands that must exit after the call completes).
    socket.unref();

    let buffer = "";
    const reqId = "1";

    socket.on("connect", () => {
      clearTimeout(connectTimer);
      const req: IpcRequest = { id: reqId, method, params };
      socket.write(JSON.stringify(req) + "\n");

      // Call timeout — if the gateway doesn't respond in time, give up.
      // Keep this timer ref'd (not unref'd) so the process waits for the
      // response or timeout before exiting — the socket itself is unref'd.
      callTimer = setTimeout(() => {
        log.warn(
          { method, socketPath, timeoutMs: DEFAULT_CALL_TIMEOUT_MS },
          "IPC call timed out waiting for response",
        );
        finish(undefined);
      }, DEFAULT_CALL_TIMEOUT_MS);

      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;

          try {
            const msg = JSON.parse(line) as IpcResponse;
            if (msg.id === reqId) {
              if (msg.error) {
                log.warn(
                  { error: msg.error, method },
                  "IPC call returned error",
                );
                finish(undefined);
              } else {
                finish(msg.result);
              }
              return;
            }
          } catch {
            // Ignore malformed lines
          }
        }
      });
    });

    socket.on("error", (err) => {
      log.warn(
        {
          err,
          code: (err as NodeJS.ErrnoException).code,
          method,
          socketPath,
        },
        "Gateway IPC socket error",
      );
      finish(undefined);
    });

    socket.on("close", () => {
      if (!settled) {
        log.warn(
          { method, socketPath },
          "Gateway IPC socket closed before response",
        );
      }
      finish(undefined);
    });
  });
}

// ---------------------------------------------------------------------------
// Persistent IPC client
// ---------------------------------------------------------------------------

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Maintains a single Unix socket connection to the gateway, with automatic
 * reconnection on failure. Multiplexes requests by ID so many concurrent
 * callers can share one socket.
 *
 * Designed for hot-path calls (e.g. classify_risk) where connecting per call
 * adds unacceptable overhead.
 */
export class PersistentIpcClient {
  private socket: Socket | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private buffer = "";
  private connecting: Promise<void> | null = null;
  private readonly socketPath: string;
  private readonly callTimeoutMs: number;

  constructor(socketPath: string, callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    this.socketPath = socketPath;
    this.callTimeoutMs = callTimeoutMs;
  }

  /**
   * Send an IPC request over the persistent connection.
   *
   * Connects on first use. If the socket is closed or errored, the next call
   * re-establishes the connection automatically.
   */
  async call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    await this.ensureConnected();

    const id = String(this.nextId++);
    const req: IpcRequest = { id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          entry.reject(
            new Error(
              `IPC call "${method}" timed out after ${this.callTimeoutMs}ms`,
            ),
          );
        }
      }, this.callTimeoutMs);
      // Don't let the timeout timer keep the process alive.
      timer.unref();

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.socket!.write(JSON.stringify(req) + "\n");
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Explicitly close the connection and reject all pending requests. */
  destroy(): void {
    this.rejectAllPending(new Error("PersistentIpcClient destroyed"));
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connecting = null;
    this.buffer = "";
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async ensureConnected(): Promise<void> {
    if (this.socket) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const sock: Socket = connect(this.socketPath);
      sock.unref();

      const connectTimer = setTimeout(() => {
        sock.destroy();
        reject(
          new Error(
            `IPC persistent connect timed out after ${CONNECT_TIMEOUT_MS}ms`,
          ),
        );
      }, CONNECT_TIMEOUT_MS);
      connectTimer.unref();

      sock.on("connect", () => {
        clearTimeout(connectTimer);
        this.socket = sock;
        this.buffer = "";
        this.connecting = null;
        this.wireDataHandler(sock);
        resolve();
      });

      sock.on("error", (err) => {
        clearTimeout(connectTimer);
        log.warn(
          {
            err,
            code: (err as NodeJS.ErrnoException).code,
            socketPath: this.socketPath,
          },
          "Persistent IPC socket error",
        );
        this.handleDisconnect();
        reject(err);
      });

      // If close fires during connect (before "connect" event), reject.
      sock.on("close", () => {
        clearTimeout(connectTimer);
        if (!this.socket) {
          this.connecting = null;
          reject(new Error("Socket closed before connect"));
        }
      });
    });

    return this.connecting;
  }

  private wireDataHandler(sock: Socket): void {
    sock.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line) as IpcResponse;
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) {
              entry.reject(new Error(msg.error));
            } else {
              entry.resolve(msg.result);
            }
          }
        } catch {
          // Ignore malformed lines
        }
      }
    });

    sock.on("error", () => {
      this.handleDisconnect();
    });

    sock.on("close", () => {
      this.handleDisconnect();
    });
  }

  private handleDisconnect(): void {
    this.rejectAllPending(new Error("IPC socket disconnected"));
    this.socket = null;
    this.connecting = null;
    this.buffer = "";
  }

  private rejectAllPending(reason: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
      this.pending.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton persistent client
// ---------------------------------------------------------------------------

let persistentClient: PersistentIpcClient | null = null;

/**
 * Persistent IPC call — singleton wrapper around PersistentIpcClient.
 *
 * Creates the instance on first call using the gateway socket path.
 * Unlike `ipcCall()`, this maintains a single connection across calls,
 * making it suitable for hot-path operations like risk classification.
 *
 * Throws on failure (timeout, socket error) — callers must handle errors.
 */
export async function ipcCallPersistent(
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (!persistentClient) {
    persistentClient = new PersistentIpcClient(getGatewaySocketPath());
  }
  return persistentClient.call(method, params);
}

/**
 * Destroy and nullify the singleton persistent client.
 * Exported for testing — ensures no leaked handles between test runs.
 */
export function resetPersistentClient(): void {
  if (persistentClient) {
    persistentClient.destroy();
    persistentClient = null;
  }
}

// ---------------------------------------------------------------------------
// Typed helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all merged feature flags from the gateway via IPC.
 * Returns an empty record on any failure.
 */
export async function ipcGetFeatureFlags(): Promise<Record<string, boolean>> {
  const result = await ipcCall("get_feature_flags");
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const filtered: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      if (typeof v === "boolean") filtered[k] = v;
    }
    return filtered;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Socket path
// ---------------------------------------------------------------------------

function getGatewaySocketPath(): string {
  return resolveIpcSocketPath("gateway.sock").path;
}
