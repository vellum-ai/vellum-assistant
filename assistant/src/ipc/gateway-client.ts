/**
 * Assistant-side IPC client for communicating with the gateway.
 *
 * Connects to the gateway's Unix domain socket and provides typed methods
 * for reading gateway-owned data. Protocol: newline-delimited JSON
 * (same as gateway/src/ipc/server.ts).
 *
 * The socket lives at `{workspaceDir}/gateway.sock` on the shared volume.
 */

import { connect, type Socket } from "node:net";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

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
      // ENOENT / ECONNREFUSED are expected when gateway hasn't started
      if (
        (err as NodeJS.ErrnoException).code !== "ENOENT" &&
        (err as NodeJS.ErrnoException).code !== "ECONNREFUSED"
      ) {
        log.warn({ err }, "Gateway IPC socket error");
      }
      finish(undefined);
    });

    socket.on("close", () => {
      finish(undefined);
    });
  });
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
  return join(getWorkspaceDir(), "gateway.sock");
}
