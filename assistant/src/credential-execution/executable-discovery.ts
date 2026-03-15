/**
 * CES executable discovery and transport bootstrap.
 *
 * Provides two discovery strategies:
 *
 * 1. **Local mode** — Locates the bundled `credential-executor` binary and
 *    returns the path for `process-manager.ts` to spawn as a child process
 *    with stdio transport.
 *
 * 2. **Managed mode** — Locates the bootstrap Unix socket exposed by the CES
 *    sidecar container through a shared emptyDir volume, and returns a
 *    connected Unix socket transport.
 *
 * Both strategies fail closed: if the executable or socket cannot be found,
 * the discovery returns a structured error rather than falling back to
 * in-process credential handling.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { getLogger } from "../util/logger.js";
import { getRootDir } from "../util/platform.js";

const log = getLogger("ces-discovery");

// ---------------------------------------------------------------------------
// Well-known paths
// ---------------------------------------------------------------------------

/** Default directory for the bootstrap socket shared volume. */
const DEFAULT_BOOTSTRAP_SOCKET_DIR = "/run/ces";

/** Bootstrap socket filename. */
const BOOTSTRAP_SOCKET_NAME = "ces.sock";

/**
 * Resolve the CES bootstrap socket path.
 *
 * Priority:
 * 1. `CES_BOOTSTRAP_SOCKET_DIR` env var (directory) — appends `ces.sock`
 * 2. `CES_BOOTSTRAP_SOCKET` env var (full file path override)
 * 3. Hardcoded default: `/run/ces/ces.sock`
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

/**
 * Candidate locations for the local credential-executor binary, checked
 * in order. The first existing path wins.
 *
 * Only paths outside the sandbox working directory are eligible.
 * `getDataDir()` (under `~/.vellum/workspace/data`) was previously included
 * but is inside the sandbox write boundary, so a sandboxed tool could plant
 * a malicious binary there. Removed to close the sandbox-escape vector.
 */
function getLocalBinarySearchPaths(): string[] {
  return [join(getRootDir(), "bin", "credential-executor")];
}

// ---------------------------------------------------------------------------
// Discovery result types
// ---------------------------------------------------------------------------

export interface LocalDiscoverySuccess {
  mode: "local";
  executablePath: string;
}

export interface ManagedDiscoverySuccess {
  mode: "managed";
  socketPath: string;
}

export interface DiscoveryFailure {
  mode: "unavailable";
  reason: string;
}

export type DiscoveryResult =
  | LocalDiscoverySuccess
  | ManagedDiscoverySuccess
  | DiscoveryFailure;

// ---------------------------------------------------------------------------
// Local discovery
// ---------------------------------------------------------------------------

/**
 * Discover the local CES executable.
 *
 * Searches well-known paths for the `credential-executor` binary. Returns
 * a structured result — never throws. If the binary is not found, returns
 * `{ mode: "unavailable" }` so the caller can fail closed.
 */
export function discoverLocalCes(): LocalDiscoverySuccess | DiscoveryFailure {
  const searchPaths = getLocalBinarySearchPaths();

  for (const candidate of searchPaths) {
    if (existsSync(candidate)) {
      log.info({ path: candidate }, "Found local CES executable");
      return { mode: "local", executablePath: candidate };
    }
  }

  const reason = `CES executable not found. Searched: ${searchPaths.join(", ")}`;
  log.warn(reason);
  return { mode: "unavailable", reason };
}

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
// Auto-discovery
// ---------------------------------------------------------------------------

/**
 * Automatically discover CES using the appropriate strategy for the
 * current deployment topology.
 *
 * - Containerized environments → managed sidecar discovery
 * - Non-containerized environments → local executable discovery
 */
export function discoverCes(): DiscoveryResult {
  if (getIsContainerized()) {
    return discoverManagedCes();
  }
  return discoverLocalCes();
}
