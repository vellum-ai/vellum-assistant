/**
 * CLI IPC client for communicating with the assistant daemon.
 *
 * One-shot connect → call → disconnect over the CLI IPC socket.
 * Returns a typed result object so callers can distinguish success
 * from connection failures and method errors.
 *
 * The preferred socket path is `{workspaceDir}/assistant.sock`, with a
 * deterministic fallback for long AF_UNIX paths.
 */

import { connect, type Socket } from "node:net";

import { getLogger } from "../util/logger.js";
import { getAssistantSocketPath } from "./socket-path.js";

const log = getLogger("cli-ipc-client");

// ---------------------------------------------------------------------------
// Types (mirror cli-server.ts protocol)
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
  /** HTTP-style status code mirrored from `RouteError.statusCode`. */
  statusCode?: number;
  /** Machine-readable error code (e.g. "UNPROCESSABLE_ENTITY"). */
  errorCode?: string;
  /**
   * Structured error payload mirroring `RouteError.details` — present only
   * when the originating error carried a `details` field. Mirrors the HTTP
   * adapter's `error.details` envelope.
   */
  errorDetails?: unknown;
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const DEFAULT_CALL_TIMEOUT_MS = 60_000; // wake may take time (agent loop runs)
const CONNECT_TIMEOUT_MS = 3_000;

export interface CliIpcCallResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
  /** HTTP-style status code surfaced from a daemon-side `RouteError`. */
  statusCode?: number;
  /** Machine-readable error code (e.g. "UNPROCESSABLE_ENTITY"). */
  errorCode?: string;
  /**
   * Structured error payload mirroring `RouteError.details` — present only
   * when the originating daemon-side error carried a `details` field.
   */
  errorDetails?: unknown;
}

/**
 * One-shot IPC helper: connect to the daemon socket, call a method,
 * return the result, disconnect.
 *
 * Returns a typed result object so callers can distinguish success from
 * connection failures and method errors.
 */
export async function cliIpcCall<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number },
): Promise<CliIpcCallResult<T>> {
  const socketPath = getAssistantSocketPath();
  const callTimeoutMs = options?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  return new Promise<CliIpcCallResult<T>>((resolve) => {
    let settled = false;
    let callTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: CliIpcCallResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (callTimer) clearTimeout(callTimer);
      socket.destroy();
      resolve(result);
    };

    const connectTimer = setTimeout(() => {
      log.debug(
        { method, socketPath, timeoutMs: CONNECT_TIMEOUT_MS },
        "CLI IPC connect timed out",
      );
      finish({
        ok: false,
        error: "Could not connect to assistant daemon. Is it running?",
      });
    }, CONNECT_TIMEOUT_MS);

    const socket: Socket = connect(socketPath);
    socket.unref();

    let buffer = "";
    const reqId = crypto.randomUUID();

    socket.on("connect", () => {
      clearTimeout(connectTimer);
      const req: IpcRequest = { id: reqId, method, params };
      socket.write(JSON.stringify(req) + "\n");

      callTimer = setTimeout(() => {
        log.debug(
          { method, socketPath, timeoutMs: callTimeoutMs },
          "CLI IPC call timed out waiting for response",
        );
        finish({ ok: false, error: "Request timed out" });
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
                finish({
                  ok: false,
                  error: msg.error,
                  ...(msg.statusCode !== undefined && {
                    statusCode: msg.statusCode,
                  }),
                  ...(msg.errorCode !== undefined && {
                    errorCode: msg.errorCode,
                  }),
                  ...(msg.errorDetails !== undefined && {
                    errorDetails: msg.errorDetails,
                  }),
                });
              } else {
                finish({ ok: true, result: msg.result as T });
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
      const code = (err as NodeJS.ErrnoException).code;
      log.debug({ err, code, method, socketPath }, "CLI IPC socket error");
      finish({
        ok: false,
        error:
          code === "ENOENT" || code === "ECONNREFUSED"
            ? "Could not connect to assistant daemon. Is it running?"
            : `Connection error: ${code ?? err.message}`,
      });
    });

    socket.on("close", () => {
      if (!settled) {
        finish({
          ok: false,
          error: "Connection closed before response",
        });
      }
    });
  });
}
