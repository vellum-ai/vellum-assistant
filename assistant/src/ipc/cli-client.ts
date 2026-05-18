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
  if (options?.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
  }

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
        error: `Could not connect to the assistant at ${socketPath}.\nRun \`assistant status\` to check, or \`assistant gateway start\` to start it.`,
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
            ? `Could not connect to the assistant at ${socketPath}.\nRun \`assistant status\` to check, or \`assistant gateway start\` to start it.`
            : `Connection error: ${code ?? err.message}`,
      });
    });

    socket.on("close", (hadError) => {
      if (!settled) {
        finish({
          ok: false,
          // hadError is true when close follows a socket error (e.g. ENOENT).
          error: hadError
            ? `Could not connect to the assistant at ${socketPath}.\nRun \`assistant status\` to check, or \`assistant gateway start\` to start it.`
            : "Connection closed before response",
        });
      }
    });

    const reqId = crypto.randomUUID();

    opts?.signal?.addEventListener(
      "abort",
      () => {
        finish({ ok: false, error: "Request aborted" });
      },
      { once: true },
    );

    const reader = new IpcFrameReader(
      (envelope) => {
        if (envelope.id !== reqId) return;
        const msg = envelope as IpcResponse;
        if (msg.error) {
          finish({
            ok: false,
            error: msg.error,
            ...(msg.statusCode != null && { statusCode: msg.statusCode }),
            ...(msg.errorCode != null && { errorCode: msg.errorCode }),
            ...(msg.errorDetails != null && { errorDetails: msg.errorDetails }),
          });
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

// ---------------------------------------------------------------------------
// Binary one-shot client
// ---------------------------------------------------------------------------

const DEFAULT_BINARY_TIMEOUT_MS = 60_000;

/**
 * One-shot IPC call that expects a single binary frame response.
 *
 * Use when the route returns an IpcBinaryResponse (content-length header
 * + one binary data frame). Returns the headers and raw bytes.
 *
 * @example
 * const r = await cliIpcCallBinary("export_file", { id: "abc" });
 * if (!r.ok) return exitFromIpcResult(r, cmd);
 * fs.writeFileSync("out.bin", Buffer.from(r.bytes));
 */
export async function cliIpcCallBinary(
  method: string,
  params?: Record<string, unknown>,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<
  | { ok: true; headers: Record<string, string>; bytes: Uint8Array }
  | {
      ok: false;
      error: string;
      statusCode?: number;
      errorCode?: string;
      errorDetails?: unknown;
    }
> {
  if (opts?.signal?.aborted) {
    throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  const socketPath = getAssistantSocketPath();
  const callTimeoutMs = opts?.timeoutMs ?? DEFAULT_BINARY_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let callTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (
      result:
        | { ok: true; headers: Record<string, string>; bytes: Uint8Array }
        | {
            ok: false;
            error: string;
            statusCode?: number;
            errorCode?: string;
            errorDetails?: unknown;
          },
    ) => {
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
        "CLI IPC binary connect timed out",
      );
      finish({
        ok: false,
        error: `Could not connect to the assistant at ${socketPath}.\nRun \`assistant status\` to check, or \`assistant gateway start\` to start it.`,
      });
    }, CONNECT_TIMEOUT_MS);

    const socket = new Socket();
    socket.unref();

    socket.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      log.debug(
        { err, code, method, socketPath },
        "CLI IPC binary socket error",
      );
      finish({
        ok: false,
        error:
          code === "ENOENT" || code === "ECONNREFUSED"
            ? `Could not connect to the assistant at ${socketPath}.\nRun \`assistant status\` to check, or \`assistant gateway start\` to start it.`
            : `Connection error: ${code ?? err.message}`,
      });
    });

    socket.on("close", (hadError) => {
      if (!settled) {
        finish({
          ok: false,
          error: hadError
            ? `Could not connect to the assistant at ${socketPath}.\nRun \`assistant status\` to check, or \`assistant gateway start\` to start it.`
            : "Connection closed before response",
        });
      }
    });

    const reqId = crypto.randomUUID();

    opts?.signal?.addEventListener(
      "abort",
      () => {
        finish({ ok: false, error: "Request aborted" });
      },
      { once: true },
    );

    const reader = new IpcFrameReader(
      (envelope, binary) => {
        if (envelope.id !== reqId) return;
        const msg = envelope as IpcResponse;
        if (msg.error) {
          finish({
            ok: false,
            error: msg.error,
            ...(msg.statusCode != null && { statusCode: msg.statusCode }),
            ...(msg.errorCode != null && { errorCode: msg.errorCode }),
            ...(msg.errorDetails != null && { errorDetails: msg.errorDetails }),
          });
        } else if (binary === undefined) {
          finish({
            ok: false,
            error: "Expected binary frame but received JSON-only response",
          });
        } else {
          finish({
            ok: true,
            headers: (envelope.headers ?? {}) as Record<string, string>,
            bytes: binary,
          });
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
          "CLI IPC binary call timed out",
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

// ---------------------------------------------------------------------------
// Streaming client
// ---------------------------------------------------------------------------

const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 30_000;

/**
 * Streaming IPC call. Returns a ReadableStream of binary chunks.
 *
 * The promise resolves once the opening envelope arrives (or fails). The
 * stream body is delivered asynchronously afterward. Call abort() to
 * cancel mid-stream — this sends a $cancel envelope to the server.
 *
 * No total timeout. Only a first-byte timeout (default 30s).
 *
 * @example
 * const r = await cliIpcCallStream("export_stream", { id: "abc" });
 * if (!r.ok) return exitFromIpcResult(r, cmd);
 * for await (const chunk of r.body) process.stdout.write(chunk);
 */
export async function cliIpcCallStream(
  method: string,
  params?: Record<string, unknown>,
  opts?: { firstByteTimeoutMs?: number; signal?: AbortSignal },
): Promise<
  | {
      ok: true;
      headers: Record<string, string>;
      body: ReadableStream<Uint8Array>;
      abort: () => void;
    }
  | {
      ok: false;
      error: string;
      statusCode?: number;
      errorCode?: string;
      errorDetails?: unknown;
    }
> {
  if (opts?.signal?.aborted) {
    throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  const socketPath = getAssistantSocketPath();
  const firstByteTimeoutMs =
    opts?.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;

    const finishError = (result: {
      ok: false;
      error: string;
      statusCode?: number;
      errorCode?: string;
      errorDetails?: unknown;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(firstByteTimer);
      socket.destroy();
      resolve(result);
    };

    const abort = () => {
      if (settled && streamController) {
        streamController.error(new DOMException("Aborted", "AbortError"));
        streamController = undefined;
      }
      if (!socket.destroyed) {
        writeMessage(socket, {
          id: crypto.randomUUID(),
          method: "$cancel",
          params: { targetId: reqId },
        });
        // Use end() not destroy() so the $cancel frame flushes before the FIN.
        socket.end();
      }
    };

    const connectTimer = setTimeout(() => {
      log.debug(
        { method, socketPath, timeoutMs: CONNECT_TIMEOUT_MS },
        "CLI IPC stream connect timed out",
      );
      finishError({
        ok: false,
        error: `Could not connect to the assistant at ${socketPath}.\nRun \`assistant status\` to check, or \`assistant gateway start\` to start it.`,
      });
    }, CONNECT_TIMEOUT_MS);

    const socket = new Socket();
    socket.unref();

    socket.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      log.debug(
        { err, code, method, socketPath },
        "CLI IPC stream socket error",
      );
      if (!settled) {
        finishError({
          ok: false,
          error:
            code === "ENOENT" || code === "ECONNREFUSED"
              ? `Could not connect to the assistant at ${socketPath}.\nRun \`assistant status\` to check, or \`assistant gateway start\` to start it.`
              : `Connection error: ${code ?? err.message}`,
        });
      } else {
        streamController?.error(err);
        streamController = undefined;
      }
    });

    socket.on("close", (hadError) => {
      if (!settled) {
        finishError({
          ok: false,
          error: hadError
            ? `Could not connect to the assistant at ${socketPath}.\nRun \`assistant status\` to check, or \`assistant gateway start\` to start it.`
            : "Connection closed before response",
        });
      } else if (streamController) {
        streamController.error(
          new Error("Connection closed before stream ended"),
        );
        streamController = undefined;
      }
    });

    const reqId = crypto.randomUUID();

    opts?.signal?.addEventListener(
      "abort",
      () => {
        abort();
      },
      { once: true },
    );

    const reader = new IpcFrameReader(
      (envelope) => {
        // Non-streaming envelope with error (e.g. method not found, auth failure)
        if (envelope.id !== reqId) return;
        const msg = envelope as IpcResponse;
        finishError({
          ok: false,
          error: msg.error ?? "Unexpected non-streaming response",
          ...(msg.statusCode != null && { statusCode: msg.statusCode }),
          ...(msg.errorCode != null && { errorCode: msg.errorCode }),
          ...(msg.errorDetails != null && { errorDetails: msg.errorDetails }),
        });
      },
      (err) => finishError({ ok: false, error: err.message }),
      {
        onStreamStart: (envelope) => {
          if (envelope.id !== reqId) return;
          clearTimeout(firstByteTimer);
          const body = new ReadableStream<Uint8Array>({
            start(ctrl) {
              streamController = ctrl;
            },
            cancel() {
              // Consumer cancelled (reader.cancel(), for-await break, pipe abort).
              // Clear the controller reference first so abort() skips the
              // already-closing stream's error() call, then send $cancel.
              streamController = undefined;
              abort();
            },
          });
          settled = true;
          clearTimeout(connectTimer);
          resolve({
            ok: true,
            headers: (envelope.headers ?? {}) as Record<string, string>,
            body,
            abort,
          });
        },
        onStreamChunk: (chunk) => {
          streamController?.enqueue(chunk);
        },
        onStreamEnd: () => {
          streamController?.close();
          streamController = undefined;
          socket.destroy();
        },
      },
    );

    socket.on("connect", () => {
      clearTimeout(connectTimer);
      writeMessage(socket, { id: reqId, method, params });

      firstByteTimer = setTimeout(() => {
        log.debug(
          { method, socketPath, timeoutMs: firstByteTimeoutMs },
          "CLI IPC stream first-byte timeout",
        );
        finishError({
          ok: false,
          error: "Stream timed out waiting for first byte",
        });
      }, firstByteTimeoutMs);

      socket.on("data", (chunk) => {
        reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
    });

    socket.connect(socketPath);
  });
}

// ---------------------------------------------------------------------------
// Exit helper
// ---------------------------------------------------------------------------

/**
 * Map an IPC error result to a process exit code and terminate.
 *
 * Exit code matrix (DESIGN.md §3.6):
 *   0  — success (not reached via this helper; call process.exit(0) directly)
 *   1  — generic CLI error (fallback for unexpected status codes)
 *   2  — daemon returned 4xx (bad params, not found, unauthorized)
 *   3  — daemon returned 5xx (server-side error)
 *   10 — IPC transport error (can't connect, timeout, closed before response)
 *
 * @example
 * const r = await cliIpcCall<FooResponse>("foo", params);
 * if (!r.ok) return exitFromIpcResult(r, cmd);
 */
export function exitFromIpcResult(
  r: { ok: boolean; error?: string; statusCode?: number },
  _cmd?: unknown,
): never {
  process.stderr.write((r.error ?? "Unknown error") + "\n");
  process.exit(exitCodeFromIpcResult(r));
}

/**
 * Map an IPC error result to its CLI process exit code without exiting.
 *
 * Use this when callers want to emit a structured response (e.g. a JSON
 * error envelope in `--json` mode) before terminating with the same status
 * code that {@link exitFromIpcResult} would produce.
 *
 * Exit code matrix matches {@link exitFromIpcResult}.
 */
export function exitCodeFromIpcResult(r: { statusCode?: number }): number {
  if (r.statusCode === undefined) return 10;
  if (r.statusCode >= 500) return 3;
  if (r.statusCode >= 400) return 2;
  return 1;
}
