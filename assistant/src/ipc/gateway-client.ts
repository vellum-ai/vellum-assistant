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

import { getLogger } from "../util/logger.js";
import { resolveIpcSocketPath } from "./socket-path.js";

const log = getLogger("gateway-ipc-client");

// Re-export the package's PersistentIpcClient under the same name so
// existing test imports (`import { PersistentIpcClient } from ...`) and
// direct instantiations continue to work without changes.
export { PackagePersistentIpcClient as PersistentIpcClient };

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
// Socket path
// ---------------------------------------------------------------------------

function getGatewaySocketPath(): string {
  return resolveIpcSocketPath("gateway.sock").path;
}
