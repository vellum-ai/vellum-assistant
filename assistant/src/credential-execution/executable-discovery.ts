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
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { getLogger } from "../util/logger.js";
import { getBinDir } from "../util/platform.js";

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

/**
 * Candidate locations for the local credential-executor binary, checked
 * in order. The first existing path wins.
 *
 * Only paths outside the sandbox working directory are eligible.
 * `getDataDir()` (under `$VELLUM_WORKSPACE_DIR/data`) was previously included
 * but is inside the sandbox write boundary, so a sandboxed tool could plant
 * a malicious binary there. Removed to close the sandbox-escape vector.
 *
 * Search order:
 * 1. Alongside the running executable, but ONLY when running from a
 *    packaged macOS app bundle (`<App>.app/Contents/MacOS/credential-executor`).
 *    In dev mode, `process.execPath` points at the bun/node install dir
 *    (e.g. `~/.bun/bin`), where an unrelated file named `credential-executor`
 *    could be picked up by accident.
 * 2. `<binDir>/credential-executor` — user-installed override (dev flow).
 */
function getLocalBinarySearchPaths(): string[] {
  const paths: string[] = [];

  // Only check the sibling of process.execPath when running from a packaged
  // app bundle — the .app/Contents/MacOS directory is a controlled location.
  // In dev mode, process.execPath is the bun/node binary (e.g. ~/.bun/bin/bun)
  // and a sibling lookup there could discover an unrelated or untrusted
  // executable.
  const execDir = dirname(process.execPath);
  if (execDir.includes(".app/Contents/MacOS")) {
    paths.push(join(execDir, "credential-executor"));
  }

  paths.push(join(getBinDir(), "credential-executor"));
  return paths;
}

// ---------------------------------------------------------------------------
// Discovery result types
// ---------------------------------------------------------------------------

export interface LocalDiscoverySuccess {
  mode: "local";
  executablePath: string;
}

export interface LocalSourceDiscoverySuccess {
  mode: "local-source";
  sourcePath: string;
}

export interface ManagedDiscoverySuccess {
  mode: "managed";
  socketPath: string;
}

/**
 * A local CES running as an independent sibling process (not spawned by the
 * assistant), reached over a Unix socket. Transport-identical to managed; the
 * distinct mode records that the assistant does not own this process's
 * lifecycle. Opted into via `CES_STANDALONE`.
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
  | LocalDiscoverySuccess
  | LocalSourceDiscoverySuccess
  | ManagedDiscoverySuccess
  | SiblingDiscoverySuccess
  | DiscoveryFailure;

// ---------------------------------------------------------------------------
// Local discovery
// ---------------------------------------------------------------------------

/**
 * Discover the local CES executable.
 *
 * Searches well-known paths for the `credential-executor` binary. If the
 * compiled binary is not found, falls back to the TypeScript source entry
 * point in the monorepo. Returns a structured result — never throws. If
 * neither the binary nor the source entry point is found, returns
 * `{ mode: "unavailable" }` so the caller can fail closed.
 *
 * @deprecated The assistant-spawns-CES stdio path is being retired in favor of
 * the CLI-launched sibling (`CES_STANDALONE`), which matches how containerized
 * homes already run CES. Kept only until the sibling topology becomes default.
 */
export function discoverLocalCes():
  | LocalDiscoverySuccess
  | LocalSourceDiscoverySuccess
  | DiscoveryFailure {
  const searchPaths = getLocalBinarySearchPaths();

  for (const candidate of searchPaths) {
    if (existsSync(candidate)) {
      log.info({ path: candidate }, "Found local CES executable");
      return { mode: "local", executablePath: candidate };
    }
  }

  // Fallback: check for source entry point in the monorepo
  const monorepoRoot = join(import.meta.dir, "..", "..", "..");
  const sourceEntry = join(
    monorepoRoot,
    "credential-executor",
    "src",
    "main.ts",
  );
  if (existsSync(sourceEntry)) {
    log.info({ path: sourceEntry }, "Found local CES source entry point");
    return { mode: "local-source", sourcePath: sourceEntry };
  }

  // npm-layout fallback: resolve via node_modules when installed as a package
  try {
    const _require = createRequire(import.meta.url);
    const pkgPath = _require.resolve(
      "@vellumai/credential-executor/package.json",
    );
    const npmSourceEntry = join(dirname(pkgPath), "src", "main.ts");
    if (existsSync(npmSourceEntry)) {
      log.info({ path: npmSourceEntry }, "Found CES source via npm package");
      return { mode: "local-source", sourcePath: npmSourceEntry };
    }
  } catch {
    // Package not installed — fall through to unavailable
  }

  const reason = `CES executable not found. Searched: ${searchPaths.join(", ")}; also checked source at ${sourceEntry}`;
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
// Sibling discovery (temporary — CES_STANDALONE)
// ---------------------------------------------------------------------------

/**
 * Whether the assistant should connect to a CLI-launched CES sibling process
 * instead of spawning CES itself. Temporary opt-in while we move local CES to a
 * proper sibling process; only applies to non-containerized (bare-metal) homes.
 */
export function isCesSiblingOptIn(): boolean {
  return !getIsContainerized() && process.env["CES_STANDALONE"] === "1";
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
      "CES_STANDALONE is set but CES_LOCAL_SOCKET is not — cannot locate the CES sibling socket";
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
 * - Non-containerized + `CES_STANDALONE` → CLI-launched sibling socket
 * - Non-containerized (default) → local executable discovery (assistant spawns)
 */
export function discoverCes(): DiscoveryResult {
  if (getIsContainerized()) {
    return discoverManagedCes();
  }
  if (isCesSiblingOptIn()) {
    return discoverLocalSiblingCes();
  }
  return discoverLocalCes();
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
  // Only a socket that CES binds asynchronously is worth polling for — the
  // managed bootstrap socket, or a CLI-launched sibling that may still be
  // coming up. A missing local binary will not appear by waiting.
  if (!getIsContainerized() && !isCesSiblingOptIn()) {
    return discoverCes();
  }

  const deadline = Date.now() + timeoutMs;
  let result = discoverCes();
  while (result.mode === "unavailable" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    result = discoverCes();
  }
  return result;
}
