/**
 * Gateway → assistant reverse IPC client.
 *
 * Connects to the assistant's Unix domain socket (assistant.sock) to make
 * one-shot JSON-RPC calls from the gateway to the assistant daemon.
 *
 * Protocol: newline-delimited JSON over the Unix domain socket:
 * - Request:  `{ "id": string, "method": string, "params"?: object }`
 * - Response: `{ "id": string, "result"?: unknown, "error"?: string }`
 *
 * The gateway does not depend on @vellumai/gateway-client, so the one-shot
 * IPC client is implemented inline here following the same pattern as
 * packages/gateway-client/src/ipc-client.ts.
 */

import { connect, type Socket } from "node:net";

import { getLogger } from "../logger.js";
import type { ScopeOption, DirectoryScopeOption } from "../risk/risk-types.js";
import { resolveIpcSocketPath } from "./socket-path.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CALL_TIMEOUT_MS = 30_000; // 30s to accommodate LLM latency
const CONNECT_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface IpcRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface IpcResponse {
  id: string;
  result?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Socket path
// ---------------------------------------------------------------------------

function getAssistantSocketPath(): string {
  return resolveIpcSocketPath("assistant").path;
}

// ---------------------------------------------------------------------------
// One-shot IPC call to the assistant
// ---------------------------------------------------------------------------

const log = getLogger("assistant-client");

/**
 * One-shot IPC helper: connect to assistant.sock, call a method, disconnect.
 *
 * Returns `undefined` on any failure (socket not found, timeout, parse error)
 * so callers can fall back gracefully. Uses a 30-second call timeout to
 * accommodate LLM latency on the assistant side.
 */
export async function ipcCallAssistant(
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const socketPath = getAssistantSocketPath();

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
        "Assistant IPC connect timed out",
      );
      finish(undefined);
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
        log.warn(
          { method, socketPath, timeoutMs: CALL_TIMEOUT_MS },
          "Assistant IPC call timed out waiting for response",
        );
        finish(undefined);
      }, CALL_TIMEOUT_MS);

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
                  "Assistant IPC call returned error",
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
        "Assistant IPC socket error",
      );
      finish(undefined);
    });

    socket.on("close", () => {
      if (!settled) {
        log.warn(
          { method, socketPath },
          "Assistant IPC socket closed before response",
        );
      }
      finish(undefined);
    });
  });
}

// ---------------------------------------------------------------------------
// Typed helpers
// ---------------------------------------------------------------------------

export interface SuggestTrustRuleRequest {
  tool: string;
  command: string;
  riskAssessment: {
    risk: string;
    reasoning: string;
    reasonDescription: string;
  };
  scopeOptions: ScopeOption[];
  directoryScopeOptions?: DirectoryScopeOption[];
  currentThreshold: string; // "low" | "medium" | "high"
  intent: "auto_approve" | "escalate";
}

export interface SuggestTrustRuleResponse {
  pattern: string;
  risk: string; // "low" | "medium" | "high"
  scope?: string;
  description: string;
  scopeOptions: ScopeOption[];
  directoryScopeOptions?: DirectoryScopeOption[];
}

/**
 * Ask the assistant daemon to suggest a trust rule for a command invocation.
 *
 * Throws if the assistant returns an error or an unexpected response shape.
 */
export async function ipcSuggestTrustRule(
  params: SuggestTrustRuleRequest,
): Promise<SuggestTrustRuleResponse> {
  const result = await ipcCallAssistant(
    "suggest_trust_rule",
    params as unknown as Record<string, unknown>,
  );
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("ipcSuggestTrustRule: unexpected response shape");
  }
  return result as SuggestTrustRuleResponse;
}
