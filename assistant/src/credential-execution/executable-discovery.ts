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
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { getLogger } from "../util/logger.js";
import { getDataDir, getRootDir } from "../util/platform.js";

const log = getLogger("ces-discovery");

// ---------------------------------------------------------------------------
// Well-known paths
// ---------------------------------------------------------------------------

/**
 * Well-known path for the CES bootstrap socket in managed deployments.
 * The CES sidecar writes this socket into a shared emptyDir volume.
 */
const MANAGED_BOOTSTRAP_SOCKET_PATH = "/run/ces/ces.sock";

/**
 * Candidate locations for the local credential-executor binary, checked
 * in order. The first existing path wins.
 *
 * 1. `~/.vellum/bin/credential-executor` — installed alongside the assistant
 * 2. Relative to the repo root (development) — `credential-executor/src/index.ts`
 *    run via `bun run`.
 */
function getLocalBinarySearchPaths(): string[] {
  return [
    join(getRootDir(), "bin", "credential-executor"),
    join(getDataDir(), "bin", "credential-executor"),
  ];
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
// Socket handshake timeout
// ---------------------------------------------------------------------------

const SOCKET_CONNECT_TIMEOUT_MS = 5_000;

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
 * Attempts to connect to the well-known socket path and verifies the
 * connection succeeds within a timeout. Returns a structured result —
 * never throws.
 *
 * The socket path can be overridden via `CES_BOOTSTRAP_SOCKET` env var
 * for testing and non-standard pod layouts.
 */
export async function discoverManagedCes(): Promise<
  ManagedDiscoverySuccess | DiscoveryFailure
> {
  const socketPath =
    process.env["CES_BOOTSTRAP_SOCKET"] ?? MANAGED_BOOTSTRAP_SOCKET_PATH;

  if (!existsSync(socketPath)) {
    const reason = `CES bootstrap socket not found at ${socketPath}`;
    log.warn(reason);
    return { mode: "unavailable", reason };
  }

  // Verify we can actually connect to the socket (fail closed on errors)
  try {
    const socket = await connectWithTimeout(
      socketPath,
      SOCKET_CONNECT_TIMEOUT_MS,
    );
    // Connection succeeded — close the probe socket immediately.
    // The process manager will create the real transport connection.
    socket.destroy();
    log.info({ socketPath }, "Managed CES sidecar socket verified");
    return { mode: "managed", socketPath };
  } catch (err) {
    const reason = `CES bootstrap socket handshake failed at ${socketPath}: ${err instanceof Error ? err.message : String(err)}`;
    log.warn(reason);
    return { mode: "unavailable", reason };
  }
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
export async function discoverCes(): Promise<DiscoveryResult> {
  if (getIsContainerized()) {
    return discoverManagedCes();
  }
  return discoverLocalCes();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Connect to a Unix domain socket with a timeout.
 *
 * Returns the connected socket or rejects with an error. The caller owns
 * the socket lifecycle.
 */
function connectWithTimeout(
  socketPath: string,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(`Connection to ${socketPath} timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
