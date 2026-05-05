/**
 * Unix-socket NDJSON IPC client for assistant-to-gateway communication.
 *
 * Provides both one-shot and persistent connection modes for calls to the
 * gateway's Unix domain socket (e.g. feature flags, thresholds, contacts).
 *
 * Protocol: newline-delimited JSON — each message is a single JSON object
 * followed by a newline character.
 */

import { connect, type Socket } from "node:net";

import type { IpcRequest, IpcResponse, Logger } from "./types.js";
import { noopLogger } from "./types.js";

// ---------------------------------------------------------------------------
// Error surface
// ---------------------------------------------------------------------------

/**
 * Error class thrown by `PersistentIpcClient.call` when the daemon returns
 * a structured error envelope (i.e. `RouteError`-derived). Mirrors the HTTP
 * adapter's `error.details` shape so IPC callers can branch on `errorCode`
 * or recover machine-readable `errorDetails` (e.g. `version_incompatible`).
 */
export class IpcCallError extends Error {
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly errorDetails?: unknown;

  constructor(
    message: string,
    fields: {
      statusCode?: number;
      errorCode?: string;
      errorDetails?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "IpcCallError";
    if (fields.statusCode !== undefined) this.statusCode = fields.statusCode;
    if (fields.errorCode !== undefined) this.errorCode = fields.errorCode;
    if (fields.errorDetails !== undefined)
      this.errorDetails = fields.errorDetails;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CALL_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// One-shot IPC call
// ---------------------------------------------------------------------------

/**
 * One-shot IPC helper: connect, call a method, disconnect.
 *
 * Designed for CLI and daemon startup where we need a single RPC call
 * without leaving open handles. Returns `undefined` on any failure
 * (socket not found, timeout, parse error) so callers can fall back.
 *
 * @param timeoutMs - Optional override for both the connect and call
 *   timeouts. When omitted, defaults to the module constants
 *   (CONNECT_TIMEOUT_MS / DEFAULT_CALL_TIMEOUT_MS). Pass a small value
 *   (e.g. 200) for opportunistic CLI checks where a slow/absent gateway
 *   should fail fast rather than block startup.
 */
export async function ipcCall(
  socketPath: string,
  method: string,
  params?: Record<string, unknown>,
  log: Logger = noopLogger,
  timeoutMs?: number,
): Promise<unknown> {
  const connectTimeoutMs = timeoutMs ?? CONNECT_TIMEOUT_MS;
  const callTimeoutMs = timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
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
        { method, socketPath, timeoutMs: connectTimeoutMs },
        "IPC connect timed out",
      );
      finish(undefined);
    }, connectTimeoutMs);

    const socket: Socket = connect(socketPath);
    socket.unref();

    let buffer = "";
    const reqId = "1";

    socket.on("connect", () => {
      clearTimeout(connectTimer);
      const req: IpcRequest = { id: reqId, method, params };
      socket.write(JSON.stringify(req) + "\n");

      callTimer = setTimeout(() => {
        log.warn(
          { method, socketPath, timeoutMs: callTimeoutMs },
          "IPC call timed out waiting for response",
        );
        finish(undefined);
      }, callTimeoutMs);

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
          err: err instanceof Error ? err.message : String(err),
          code: (err as NodeJS.ErrnoException).code ?? "unknown",
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
  private readonly log: Logger;

  constructor(
    socketPath: string,
    callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    log: Logger = noopLogger,
  ) {
    this.socketPath = socketPath;
    this.callTimeoutMs = callTimeoutMs;
    this.log = log;
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
        this.log.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            code: (err as NodeJS.ErrnoException).code ?? "unknown",
            socketPath: this.socketPath,
          },
          "Persistent IPC socket error",
        );
        this.handleDisconnect();
        reject(err);
      });

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
              entry.reject(
                new IpcCallError(msg.error, {
                  statusCode: msg.statusCode,
                  errorCode: msg.errorCode,
                  errorDetails: msg.errorDetails,
                }),
              );
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
