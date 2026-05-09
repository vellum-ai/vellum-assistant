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

import { Socket } from "node:net";

import { getLogger } from "../util/logger.js";
import { IpcFrameReader, writeMessage } from "./ipc-framing.js";
import { getAssistantSocketPath } from "./socket-path.js";

const log = getLogger("cli-ipc-client");

// ---------------------------------------------------------------------------
// Types (mirror cli-server.ts protocol)
// ---------------------------------------------------------------------------

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
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<CliIpcCallResult<T>> {
  const socketPath = getAssistantSocketPath();
  const callTimeoutMs = options?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const opts = options; // alias used in the Promise callback below

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
        error: `Could not connect to assistant daemon at ${socketPath}.\nRun \`assistant status\` to check, or \`assistant gateway start\` to start the daemon.`,
      });
    }, CONNECT_TIMEOUT_MS);

    // Create the socket without connecting first so error/close handlers are
    // registered before initiating the connection. In Bun, socket errors can
    // fire synchronously during connect(), before listeners added afterward.
    const socket = new Socket();
    socket.unref();

    socket.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      log.debug({ err, code, method, socketPath }, "CLI IPC socket error");
      finish({
        ok: false,
        error:
          code === "ENOENT" || code === "ECONNREFUSED"
            ? `Could not connect to assistant daemon at ${socketPath}.\nRun \`assistant status\` to check, or \`assistant gateway start\` to start the daemon.`
            : `Connection error: ${code ?? err.message}`,
      });
    });

    socket.on("close", (hadError) => {
      if (!settled) {
        finish({
          ok: false,
          // hadError is true when close follows a socket error (e.g. ENOENT).
          error: hadError
            ? `Could not connect to assistant daemon at ${socketPath}.\nRun \`assistant status\` to check, or \`assistant gateway start\` to start the daemon.`
            : "Connection closed before response",
        });
      }
    });

    const reqId = crypto.randomUUID();

    opts?.signal?.addEventListener("abort", () => {
      finish({ ok: false, error: "Request aborted" });
    }, { once: true });

    const reader = new IpcFrameReader(
      (envelope) => {
        if (envelope.id !== reqId) return;
        const msg = envelope as IpcResponse;
        if (msg.error) {
          finish({ ok: false, error: msg.error,
            ...(msg.statusCode != null && { statusCode: msg.statusCode }),
            ...(msg.errorCode != null && { errorCode: msg.errorCode }),
            ...(msg.errorDetails != null && { errorDetails: msg.errorDetails }) });
        } else {
          finish({ ok: true, result: msg.result as T });
        }
      },
      (err) => finish({ ok: false, error: err.message }),
    );

    socket.on("connect", () => {
      clearTimeout(connectTimer);
      writeMessage(socket, { id: reqId, method, params });

      callTimer = setTimeout(() => {
        log.debug(
          { method, socketPath, timeoutMs: callTimeoutMs },
          "CLI IPC call timed out waiting for response",
        );
        finish({ ok: false, error: "Request timed out" });
      }, callTimeoutMs);

      socket.on("data", (chunk) => {
        reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
    });

    socket.connect(socketPath);
  });
}
