/**
 * CES socket discovery and transport bootstrap.
 *
 * Local siblings and managed sidecars share one resolver: `ces.sock` under
 * `CES_BOOTSTRAP_SOCKET_DIR` (default `/run/ces-bootstrap`). Discovery fails
 * closed if the socket cannot be found.
 */

import { existsSync } from "node:fs";

import {
  isNamedPipePath,
  resolveIpcEndpoint,
} from "@vellumai/ipc-server-utils";

import { getLogger } from "../util/logger.js";

const log = getLogger("ces-discovery");

/** Default directory for the CES Unix socket. */
const DEFAULT_BOOTSTRAP_SOCKET_DIR = "/run/ces-bootstrap";

/**
 * Resolve the CES socket path used in every environment.
 *
 * Uses `CES_BOOTSTRAP_SOCKET_DIR` when set, otherwise `/run/ces-bootstrap`.
 * `ces.sock` is resolved through `resolveIpcEndpoint`.
 */
function getCesSocketPath(): string {
  const dir =
    process.env["CES_BOOTSTRAP_SOCKET_DIR"]?.trim() ||
    DEFAULT_BOOTSTRAP_SOCKET_DIR;
  return resolveIpcEndpoint("ces", { workspaceDir: dir }).path;
}

export interface ManagedDiscoverySuccess {
  mode: "managed";
  socketPath: string;
}

export interface DiscoveryFailure {
  mode: "unavailable";
  reason: string;
}

export type DiscoveryResult = ManagedDiscoverySuccess | DiscoveryFailure;

/**
 * Discover CES via the shared bootstrap Unix socket.
 *
 * Checks that the well-known socket exists. Does not open a connection.
 * CES serves a multi-connection listener, so the assistant and its child
 * processes can each connect. The actual connection is made later by
 * `CesProcessManager.start()`.
 */
export function discoverCes(): DiscoveryResult {
  const socketPath = getCesSocketPath();

  if (!isNamedPipePath(socketPath) && !existsSync(socketPath)) {
    const reason = `CES bootstrap socket not found at ${socketPath}`;
    log.warn(reason);
    return { mode: "unavailable", reason };
  }

  log.info({ socketPath }, "CES bootstrap socket found");
  return { mode: "managed", socketPath };
}

/** How long to poll for the CES socket before giving up. */
const MANAGED_DISCOVERY_TIMEOUT_MS = 3_000;

/** Delay between CES socket discovery attempts. */
const MANAGED_DISCOVERY_INTERVAL_MS = 100;

/**
 * Discover CES, polling for the socket with a short backoff before failing.
 *
 * CES binds its socket asynchronously. A reconnecting assistant can probe
 * during the brief window before the socket is re-bound. Polling absorbs
 * that gap.
 */
export async function discoverCesWithRetry({
  timeoutMs = MANAGED_DISCOVERY_TIMEOUT_MS,
  intervalMs = MANAGED_DISCOVERY_INTERVAL_MS,
}: { timeoutMs?: number; intervalMs?: number } = {}): Promise<DiscoveryResult> {
  const deadline = Date.now() + timeoutMs;
  let result = discoverCes();
  while (result.mode === "unavailable" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    result = discoverCes();
  }
  return result;
}
