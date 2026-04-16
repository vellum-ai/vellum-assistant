/**
 * CLI-side IPC client for communicating with the assistant daemon.
 *
 * Mirrors the gateway IPC client pattern (`assistant/src/ipc/gateway-client.ts`):
 * one-shot connect → call → disconnect. Returns `undefined` on any failure
 * so callers can fall back or report errors.
 *
 * The socket lives at `{workspaceDir}/assistant.sock`.
 */

import { connect, type Socket } from "node:net";

import { getLogger } from "../util/logger.js";

import { getDaemonSocketPath } from "./daemon-ipc-server.js";

const log = getLogger("daemon-ipc-client");

// ---------------------------------------------------------------------------
// Types (mirror daemon-ipc-server.ts protocol)
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

const DEFAULT_CALL_TIMEOUT_MS = 60_000; // wake may take time (agent loop runs)
const CONNECT_TIMEOUT_MS = 3_000;

export interface DaemonIpcCallResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

/**
 * One-shot IPC helper: connect to the daemon socket, call a method,
 * return the result, disconnect.
 *
 * Returns a typed result object so callers can distinguish success from
 * connection failures and method errors.
 */
export async function daemonIpcCall<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number },
): Promise<DaemonIpcCallResult<T>> {
  const socketPath = getDaemonSocketPath();
  const callTimeoutMs = options?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  return new Promise<DaemonIpcCallResult<T>>((resolve) => {
    let settled = false;
    let callTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: DaemonIpcCallResult<T>) => {
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
        "Daemon IPC connect timed out",
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
          "Daemon IPC call timed out waiting for response",
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
                finish({ ok: false, error: msg.error });
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
      log.debug({ err, code, method, socketPath }, "Daemon IPC socket error");
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
