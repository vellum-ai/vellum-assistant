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
  PersistentIpcClient as PackagePersistentIpcClient,
} from "@vellumai/gateway-client/ipc-client";

import type {
  ClassificationResult,
  ClassifyRiskParams,
} from "../permissions/ipc-risk-types.js";
import { getLogger } from "../util/logger.js";
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
): Promise<unknown> {
  const socketPath = getGatewaySocketPath();
  return packageIpcCall(socketPath, method, params, log);
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
): Promise<unknown> {
  if (!persistentClient) {
    persistentClient = new PackagePersistentIpcClient(
      getGatewaySocketPath(),
      undefined,
      log,
    );
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

/**
 * Classify risk for a tool invocation via the gateway's persistent IPC
 * connection.
 *
 * Uses `ipcCallPersistent` (not the one-shot `ipcCall`) because risk
 * classification is on the hot path for every tool invocation and the
 * persistent connection avoids per-call connect overhead.
 *
 * Returns `undefined` when the gateway is unreachable, the response is
 * malformed, or the call fails for any reason — callers should throw
 * since there is no local fallback (gateway is a hard dependency).
 */
export async function ipcClassifyRisk(
  params: ClassifyRiskParams,
): Promise<ClassificationResult | undefined> {
  try {
    const result = await ipcCallPersistent(
      "classify_risk",
      params as unknown as Record<string, unknown>,
    );

    // Validate the response has at minimum a `risk` field
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
    log.warn({ err }, "ipcClassifyRisk: persistent IPC call failed");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Socket path
// ---------------------------------------------------------------------------

function getGatewaySocketPath(): string {
  return resolveIpcSocketPath("gateway").path;
}
