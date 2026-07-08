/**
 * CES executable discovery and transport bootstrap.
 *
 * Provides two discovery strategies:
 *
 * 1. **Sibling mode** — Locates the CLI-launched CES sibling process via its
 *    Unix socket (`CES_LOCAL_SOCKET`). Used by bare-metal/local instances.
 *
 * 2. **Managed mode** — Locates the bootstrap Unix socket exposed by the CES
 *    sidecar container through a shared emptyDir volume, and returns a
 *    connected Unix socket transport.
 *
 * Both strategies fail closed: if the socket cannot be found, the discovery
 * returns a structured error rather than falling back to in-process
 * credential handling.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("ces-discovery");

// ---------------------------------------------------------------------------
// Well-known paths
// ---------------------------------------------------------------------------

/** Default directory for the bootstrap socket shared volume. */
const DEFAULT_BOOTSTRAP_SOCKET_DIR = "/run/ces-bootstrap";

/** Bootstrap socket filename. */
const BOOTSTRAP_SOCKET_NAME = "ces.sock";

/**
 * Resolve the CES bootstrap socket path.
 *
 * Priority:
 * 1. `CES_BOOTSTRAP_SOCKET_DIR` env var (directory) — appends `ces.sock`
 * 2. `CES_BOOTSTRAP_SOCKET` env var (full file path override)
 * 3. Hardcoded default: `/run/ces-bootstrap/ces.sock`
 *
 * The pod template exports `CES_BOOTSTRAP_SOCKET_DIR`; the full-path
 * override is kept for local testing convenience.
 */
function getManagedBootstrapSocketPath(): string {
  const dir = process.env["CES_BOOTSTRAP_SOCKET_DIR"];
  if (dir) {
    return join(dir, BOOTSTRAP_SOCKET_NAME);
  }
  return (
    process.env["CES_BOOTSTRAP_SOCKET"] ??
    join(DEFAULT_BOOTSTRAP_SOCKET_DIR, BOOTSTRAP_SOCKET_NAME)
  );
}

// ---------------------------------------------------------------------------
// Discovery result types
// ---------------------------------------------------------------------------

export interface ManagedDiscoverySuccess {
  mode: "managed";
  socketPath: string;
}

/**
 * A local CES running as an independent sibling process (not spawned by the
 * assistant), reached over a Unix socket. Transport-identical to managed; the
 * distinct mode records that the assistant does not own this process's
 * lifecycle. This is the default topology for bare-metal/local instances.
 */
export interface SiblingDiscoverySuccess {
  mode: "sibling";
  socketPath: string;
}

export interface DiscoveryFailure {
  mode: "unavailable";
  reason: string;
}

export type DiscoveryResult =
  | ManagedDiscoverySuccess
  | SiblingDiscoverySuccess
  | DiscoveryFailure;

// ---------------------------------------------------------------------------
// Managed discovery
// ---------------------------------------------------------------------------

/**
 * Discover the managed CES sidecar via its bootstrap Unix socket.
 *
 * Checks that the well-known socket file exists on disk. Does NOT open a
 * connection — the CES sidecar accepts exactly one connection and then
 * unlinks the socket, so a probe would consume the only slot. The actual
 * connection is made later by `CesProcessManager.start()`.
 *
 * The socket path is derived from `CES_BOOTSTRAP_SOCKET_DIR` (matching the
 * pod template), with `CES_BOOTSTRAP_SOCKET` as a full-path fallback.
 */
export function discoverManagedCes():
  | ManagedDiscoverySuccess
  | DiscoveryFailure {
  const socketPath = getManagedBootstrapSocketPath();

  if (!existsSync(socketPath)) {
    const reason = `CES bootstrap socket not found at ${socketPath}`;
    log.warn(reason);
    return { mode: "unavailable", reason };
  }

  log.info({ socketPath }, "Managed CES bootstrap socket found");
  return { mode: "managed", socketPath };
}

// ---------------------------------------------------------------------------
// Sibling discovery (local bare-metal topology)
// ---------------------------------------------------------------------------

/**
 * Whether the assistant should connect to a CLI-launched CES sibling process
 * instead of spawning CES itself. Now always true for non-containerized
 * (bare-metal) homes — the sibling model is the default topology.
 */
export function isCesSiblingOptIn(): boolean {
  return !getIsContainerized();
}

/**
 * Discover a CLI-launched local CES sibling via its Unix socket. The CLI sets
 * `CES_LOCAL_SOCKET` on both the sibling and the daemon so they agree on the
 * path. Does not open a connection — that happens in `CesProcessManager.start()`.
 */
export function discoverLocalSiblingCes():
  | SiblingDiscoverySuccess
  | DiscoveryFailure {
  const socketPath = process.env["CES_LOCAL_SOCKET"];
  if (!socketPath) {
    const reason =
      "CES_LOCAL_SOCKET is not set — cannot locate the CES sibling socket. The CLI should set this during wake/hatch.";
    log.warn(reason);
    return { mode: "unavailable", reason };
  }
  if (!existsSync(socketPath)) {
    return {
      mode: "unavailable",
      reason: `CES sibling socket not found at ${socketPath}`,
    };
  }
  log.info({ socketPath }, "Local CES sibling socket found");
  return { mode: "sibling", socketPath };
}

// ---------------------------------------------------------------------------
// Auto-discovery
// ---------------------------------------------------------------------------

/**
 * Automatically discover CES using the appropriate strategy for the
 * current deployment topology.
 *
 * - Containerized environments → managed sidecar discovery
 * - Non-containerized → CLI-launched sibling socket discovery
 */
export function discoverCes(): DiscoveryResult {
  if (getIsContainerized()) {
    return discoverManagedCes();
  }
  return discoverLocalSiblingCes();
}

/** How long to poll for the managed bootstrap socket before giving up. */
const MANAGED_DISCOVERY_TIMEOUT_MS = 3_000;

/** Delay between managed bootstrap-socket discovery attempts. */
const MANAGED_DISCOVERY_INTERVAL_MS = 100;

/**
 * Discover CES, polling for the managed bootstrap socket with a short
 * backoff before failing.
 *
 * The managed CES sidecar re-binds its bootstrap socket after each assistant
 * session ends — it outlives any single assistant and accepts the next
 * connection (see `credential-executor/src/managed-main.ts`). A reconnecting
 * assistant (e.g. after a container restart) can therefore probe during the
 * brief window before the socket is re-bound. A single existence check would
 * race that window and incorrectly report the sidecar as unavailable; polling
 * absorbs the gap.
 *
 * Local discovery is returned immediately — a missing binary will not appear
 * by waiting, so there is nothing to poll for.
 */
export async function discoverCesWithRetry({
  timeoutMs = MANAGED_DISCOVERY_TIMEOUT_MS,
  intervalMs = MANAGED_DISCOVERY_INTERVAL_MS,
}: { timeoutMs?: number; intervalMs?: number } = {}): Promise<DiscoveryResult> {
  // Both the managed bootstrap socket and the CLI-launched sibling socket
  // are bound asynchronously, so polling is worthwhile. A missing local
  // binary (the old stdio path) would not appear by waiting, but that path
  // is gone — the sibling is the only local topology now.
  const deadline = Date.now() + timeoutMs;
  let result = discoverCes();
  while (result.mode === "unavailable" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    result = discoverCes();
  }
  return result;
}
