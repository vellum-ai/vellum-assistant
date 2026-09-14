/**
 * Unix-socket NDJSON IPC client for assistant-to-gateway communication.
 *
 * Provides both one-shot and persistent connection modes for calls to the
 * gateway's Unix domain socket (e.g. feature flags, thresholds, contacts).
 *
 * Protocol: newline-delimited JSON — each message is a single JSON object
 * followed by a newline character.
 */

import { Socket } from "node:net";

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
    if (fields.statusCode !== undefined) {
      this.statusCode = fields.statusCode;
    }
    if (fields.errorCode !== undefined) {
      this.errorCode = fields.errorCode;
    }
    if (fields.errorDetails !== undefined) {
      this.errorDetails = fields.errorDetails;
    }
  }
}

/**
 * Transport-level failure to open the gateway Unix socket.
 *
 * Distinct from {@link IpcCallError}: the gateway was not reachable, so there
 * is no structured engine response. Callers should treat this as a transient
 * availability failure (retry, or surface 503), never as an uncaught
 * exception that exits the process.
 */
export class IpcConnectError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "IpcConnectError";
    if (code !== undefined) {
      this.code = code;
    }
  }
}

/** Socket-not-yet-bound codes that are safe to retry during sibling boot. */
const RETRYABLE_CONNECT_CODES = new Set(["ENOENT", "ECONNREFUSED"]);

export function isRetryableIpcConnectError(err: unknown): boolean {
  const code = errnoCode(err);
  return code !== undefined && RETRYABLE_CONNECT_CODES.has(code);
}

function errnoCode(err: unknown): string | undefined {
  if (err instanceof IpcConnectError) {
    return err.code;
  }
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function toIpcConnectError(err: unknown, socketPath: string): IpcConnectError {
  if (err instanceof IpcConnectError) {
    return err;
  }
  const code = errnoCode(err);
  const message = err instanceof Error ? err.message : String(err);
  return new IpcConnectError(
    `Gateway IPC connect failed (${code ?? "unknown"}): ${message} (${socketPath})`,
    code,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * Open a Unix-domain socket with error listeners registered before connect().
 *
 * Bun can emit socket errors synchronously inside `connect()`. Attaching
 * listeners first keeps a missing `gateway.sock` on the promise rejection
 * path instead of as an uncaught exception.
 *
 * `onConnected` runs synchronously in the connect handler, before this
 * promise resolves, so the caller can attach post-connect listeners without
 * a gap where a follow-on error would be uncaught.
 */
function connectUnixSocket(
  socketPath: string,
  timeoutMs: number,
  onConnected?: (sock: Socket) => void,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;
    const sock = new Socket();
    sock.unref();

    const finish = (err: Error | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      sock.off("connect", onConnect);
      sock.off("close", onClose);
      // Keep the error listener so sock.destroy() cannot become uncaught.
      if (err) {
        sock.destroy();
        reject(err);
        return;
      }
      onConnected?.(sock);
      resolve(sock);
    };

    const timer = setTimeout(() => {
      finish(
        new IpcConnectError(
          `IPC connect timed out after ${timeoutMs}ms (${socketPath})`,
          "ETIMEDOUT",
        ),
      );
    }, timeoutMs);
    timer.unref();

    const onConnect = () => {
      finish(null);
    };
    const onError = (err: Error) => {
      finish(toIpcConnectError(err, socketPath));
    };
    const onClose = () => {
      finish(
        new IpcConnectError(
          `Socket closed before connect (${socketPath})`,
          "ECONNRESET",
        ),
      );
    };

    sock.on("connect", onConnect);
    sock.on("error", onError);
    sock.on("close", onClose);
    sock.connect(socketPath);
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CALL_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 3_000;

/**
 * Additional wait before each reconnect attempt when the gateway socket is
 * missing (`ENOENT`) or refused (`ECONNREFUSED`). The assistant and gateway
 * start as siblings, so the assistant can race ahead of `gateway.sock`.
 * Sum of delays: 250 + 500 + 1000 + 2000 = 3.75s.
 */
const DEFAULT_CONNECT_RETRY_BACKOFFS_MS: readonly number[] = [
  250, 500, 1000, 2000,
];

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
    let socket: Socket | undefined;

    const finish = (value: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      if (callTimer) {
        clearTimeout(callTimer);
      }
      socket?.destroy();
      resolve(value);
    };

    void connectUnixSocket(socketPath, connectTimeoutMs, (sock) => {
      socket = sock;
      let buffer = "";
      const reqId = "1";

      sock.on("error", (err) => {
        log.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            code: errnoCode(err) ?? "unknown",
            method,
            socketPath,
          },
          "Gateway IPC socket error",
        );
        finish(undefined);
      });

      sock.on("close", () => {
        if (!settled) {
          log.warn(
            { method, socketPath },
            "Gateway IPC socket closed before response",
          );
        }
        finish(undefined);
      });

      sock.on("data", (chunk) => {
        buffer += chunk.toString();
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) {
            continue;
          }

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

      const req: IpcRequest = { id: reqId, method, params };
      sock.write(JSON.stringify(req) + "\n");

      callTimer = setTimeout(() => {
        log.warn(
          { method, socketPath, timeoutMs: callTimeoutMs },
          "IPC call timed out waiting for response",
        );
        finish(undefined);
      }, callTimeoutMs);
    }).then(
      () => {
        // Handlers are attached in onConnected.
      },
      (err: unknown) => {
        log.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            code: errnoCode(err) ?? "unknown",
            method,
            socketPath,
          },
          "Gateway IPC socket error",
        );
        finish(undefined);
      },
    );
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

export type PersistentIpcClientOptions = {
  /**
   * Additional delays (ms) before each reconnect attempt after a retryable
   * connect failure. Pass `[]` to fail on the first miss (tests and callers
   * that already own a retry budget, such as classify_risk).
   */
  connectRetryBackoffsMs?: readonly number[];
};

/**
 * Maintains a single Unix socket connection to the gateway, with automatic
 * reconnection on failure. Multiplexes requests by ID so many concurrent
 * callers can share one socket.
 *
 * Designed for multiplexed calls over one socket. Control-plane callers
 * typically keep the default connect retries for sibling boot races.
 * Callers that already own a retry budget pass `connectRetryBackoffsMs: []`.
 */
export class PersistentIpcClient {
  private socket: Socket | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private buffer = "";
  private connecting: Promise<void> | null = null;
  private destroyed = false;
  private readonly socketPath: string;
  private readonly callTimeoutMs: number;
  private readonly log: Logger;
  private readonly connectRetryBackoffsMs: readonly number[];

  constructor(
    socketPath: string,
    callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    log: Logger = noopLogger,
    options?: PersistentIpcClientOptions,
  ) {
    this.socketPath = socketPath;
    this.callTimeoutMs = callTimeoutMs;
    this.log = log;
    this.connectRetryBackoffsMs =
      options?.connectRetryBackoffsMs ?? DEFAULT_CONNECT_RETRY_BACKOFFS_MS;
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
    timeoutMs?: number,
  ): Promise<unknown> {
    await this.ensureConnected();

    const id = String(this.nextId++);
    const req: IpcRequest = { id, method, params };
    const callTimeoutMs = timeoutMs ?? this.callTimeoutMs;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          entry.reject(
            new Error(
              `IPC call "${method}" timed out after ${callTimeoutMs}ms`,
            ),
          );
        }
      }, callTimeoutMs);
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
    this.destroyed = true;
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
    if (this.socket) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.connectWithRetry().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connectWithRetry(): Promise<void> {
    const backoffs = this.connectRetryBackoffsMs;
    let lastError: IpcConnectError | undefined;

    for (let attempt = 0; attempt <= backoffs.length; attempt++) {
      if (this.destroyed) {
        throw new IpcConnectError("PersistentIpcClient destroyed", "DESTROYED");
      }
      if (attempt > 0) {
        await sleep(backoffs[attempt - 1]!);
        if (this.destroyed) {
          throw new IpcConnectError(
            "PersistentIpcClient destroyed",
            "DESTROYED",
          );
        }
      }

      try {
        await this.connectOnce();
        return;
      } catch (err) {
        lastError = toIpcConnectError(err, this.socketPath);
        const retryable =
          isRetryableIpcConnectError(lastError) && attempt < backoffs.length;
        if (!retryable) {
          throw lastError;
        }
        this.log.warn(
          {
            err: lastError.message,
            code: lastError.code ?? "unknown",
            attempt,
            socketPath: this.socketPath,
          },
          "Persistent IPC connect failed, retrying",
        );
      }
    }

    throw (
      lastError ??
      new IpcConnectError("IPC persistent connect failed", "UNKNOWN")
    );
  }

  private async connectOnce(): Promise<void> {
    const sock = await connectUnixSocket(
      this.socketPath,
      CONNECT_TIMEOUT_MS,
      (connected) => {
        this.socket = connected;
        this.buffer = "";
        this.wireDataHandler(connected);
      },
    );
    if (this.destroyed) {
      sock.destroy();
      this.socket = null;
      throw new IpcConnectError("PersistentIpcClient destroyed", "DESTROYED");
    }
  }

  private wireDataHandler(sock: Socket): void {
    sock.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (!line) {
          continue;
        }

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
      this.handleDisconnect(sock);
    });

    sock.on("close", () => {
      this.handleDisconnect(sock);
    });
  }

  private handleDisconnect(sock: Socket): void {
    if (this.socket !== sock) {
      return;
    }
    this.rejectAllPending(new Error("IPC socket disconnected"));
    this.socket = null;
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
