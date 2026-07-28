/**
 * Assistant-side IPC client for communicating with the gateway.
 *
 * Thin wrapper over `@vellumai/gateway-client/ipc-client` that resolves
 * the gateway socket path and injects the assistant logger. All transport
 * logic lives in the shared package; this module provides the same public
 * API the rest of the assistant codebase expects.
 *
 * The preferred socket path is `{workspaceDir}/gateway.sock`, with a
 * deterministic fallback for long AF_UNIX paths.
 */

import {
  ipcCall as packageIpcCall,
  IpcCallError,
  PersistentIpcClient as PackagePersistentIpcClient,
} from "@vellumai/gateway-client/ipc-client";

import type {
  ClassificationResult,
  ClassifyRiskParams,
} from "../permissions/ipc-risk-types.js";
import { getLogger } from "../util/logger.js";
import { abortableSleep, computeRetryDelay } from "../util/retry.js";
import { resolveIpcSocketPath } from "./socket-path.js";

const log = getLogger("gateway-ipc-client");

// ---------------------------------------------------------------------------
// One-shot IPC call
// ---------------------------------------------------------------------------

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
  timeoutMs?: number,
): Promise<unknown> {
  const socketPath = getGatewaySocketPath();
  return packageIpcCall(socketPath, method, params, log, timeoutMs);
}

// ---------------------------------------------------------------------------
// Singleton persistent client
// ---------------------------------------------------------------------------

let persistentClient: PackagePersistentIpcClient | null = null;

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
  timeoutMs?: number,
): Promise<unknown> {
  if (!persistentClient) {
    persistentClient = new PackagePersistentIpcClient(
      getGatewaySocketPath(),
      undefined,
      log,
    );
  }
  return persistentClient.call(method, params, timeoutMs);
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
 *
 * @param timeoutMs - Optional timeout override forwarded to the IPC
 *   transport. Pass a small value (e.g. 200) for CLI startup paths where
 *   a slow/absent gateway should fail fast.
 */
export async function ipcGetFeatureFlags(
  timeoutMs?: number,
): Promise<Record<string, boolean | string>> {
  const result = await ipcCall("get_feature_flags", undefined, timeoutMs);
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const filtered: Record<string, boolean | string> = {};
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      if (typeof v === "boolean" || typeof v === "string") filtered[k] = v;
    }
    return filtered;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Velay tunnel status
// ---------------------------------------------------------------------------

export interface VelayTunnelStatus {
  connected: boolean;
  publicUrl: string | null;
}

/**
 * Fetch the current Velay tunnel status from the gateway via IPC.
 * Returns `null` when the gateway is unreachable or returns an unexpected
 * response — callers should treat `null` as "gateway not running".
 */
export async function ipcGetVelayStatus(): Promise<VelayTunnelStatus | null> {
  const result = await ipcCall("get_velay_status");
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const obj = result as Record<string, unknown>;
  if (typeof obj.connected !== "boolean") return null;
  return {
    connected: obj.connected,
    publicUrl: typeof obj.publicUrl === "string" ? obj.publicUrl : null,
  };
}

// classify_risk is an idempotent, side-effect-free read, so a transient gateway
// blip (socket dropped between calls, momentary unreachability) is safe to
// retry — the persistent client re-establishes its socket on the next call. The
// budget is deliberately sized for SUB-SECOND blips, not restart-class outages:
// each attempt uses a tighter timeout than the transport default so a wedged-
// but-reachable gateway cannot multiply the worst-case wait, and total latency
// against a hard-down gateway stays close to the single-attempt ceiling.
// Deterministic failures — a structured IpcCallError, or a returned-but-
// malformed payload — are NOT retried; they fail closed immediately.
const CLASSIFY_RISK_MAX_RETRIES = 2; // 3 attempts total
const CLASSIFY_RISK_RETRY_BASE_MS = 100; // ~[50,100] then ~[100,200] ms backoff
const CLASSIFY_RISK_ATTEMPT_TIMEOUT_MS = 1_500; // per-attempt cap (< 5s default)

/**
 * Classify risk for a tool invocation via the gateway's persistent IPC
 * connection.
 *
 * Uses `ipcCallPersistent` (not the one-shot `ipcCall`) because risk
 * classification is on the hot path for every tool invocation and the
 * persistent connection avoids per-call connect overhead.
 *
 * A transient transport failure is retried with bounded backoff (see the
 * constants above) before giving up; a structured `IpcCallError` or a
 * malformed payload fails fast without retrying. Returns `undefined` when the
 * gateway is unreachable or the response is unusable after retries — callers
 * should throw since there is no local fallback (gateway is a hard dependency).
 * When a `signal` is supplied, retries stop as soon as it aborts.
 */
export async function ipcClassifyRisk(
  params: ClassifyRiskParams,
  signal?: AbortSignal,
): Promise<ClassificationResult | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await ipcCallPersistent(
        "classify_risk",
        params as unknown as Record<string, unknown>,
        CLASSIFY_RISK_ATTEMPT_TIMEOUT_MS,
      );

      // Returned-but-malformed responses are deterministic, not transient:
      // fail closed immediately (no retry).
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        log.warn(
          { result },
          "ipcClassifyRisk: gateway returned non-object response",
        );
        return undefined;
      }

      const obj = result as Record<string, unknown>;
      if (typeof obj.risk !== "string") {
        log.warn(
          { result },
          "ipcClassifyRisk: gateway response missing 'risk' field",
        );
        return undefined;
      }

      return result as ClassificationResult;
    } catch (err) {
      // A structured gateway error means the gateway was reachable and
      // deterministically rejected the request — not a transient blip.
      const retryable = !(err instanceof IpcCallError);
      if (
        retryable &&
        attempt < CLASSIFY_RISK_MAX_RETRIES &&
        !signal?.aborted
      ) {
        log.warn(
          { err, attempt },
          "ipcClassifyRisk: transient IPC failure, retrying after backoff",
        );
        await abortableSleep(
          computeRetryDelay(attempt, CLASSIFY_RISK_RETRY_BASE_MS),
          signal,
        );
        if (!signal?.aborted) {
          continue;
        }
      }
      log.warn({ err }, "ipcClassifyRisk: persistent IPC call failed");
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Socket path
// ---------------------------------------------------------------------------

function getGatewaySocketPath(): string {
  return resolveIpcSocketPath("gateway").path;
}
