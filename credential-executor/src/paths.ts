/**
 * CES private data-root layout.
 *
 * Defines the directory structure for CES-private durable state (grants,
 * audit logs, tool store). This state is never stored on the assistant-visible
 * workspace/data root — it lives in a CES-only path that the assistant process
 * cannot read or write.
 *
 * Two modes:
 *
 * - **Local**: CES private state lives under the Vellum root's `protected/`
 *   directory at `<rootDir>/protected/credential-executor/`.
 *
 * - **Managed**: CES private state lives at `/ces-data`, a dedicated volume
 *   mounted only into the CES container. The assistant container never sees
 *   this volume.
 *
 * The assistant-visible data root (where workspace, embeddings, etc. live)
 * is a separate path and must never be used for CES-private writes.
 */

import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

export type CesMode = "local" | "managed";

/**
 * Determine the CES operating mode from the environment.
 *
 * `CES_MODE=managed` is set explicitly in managed container entrypoints.
 * Everything else defaults to local.
 */
export function getCesMode(): CesMode {
  return process.env["CES_MODE"] === "managed" ? "managed" : "local";
}

// ---------------------------------------------------------------------------
// Root directory helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the Vellum root directory, respecting `BASE_DATA_DIR` for
 * multi-instance deployments. Mirrors the logic in `assistant/src/util/platform.ts`.
 */
function getVellumRootDir(): string {
  const baseDataDir = process.env["BASE_DATA_DIR"]?.trim();
  return join(baseDataDir || homedir(), ".vellum");
}

/** Well-known managed CES data root (dedicated volume mount). */
const MANAGED_CES_DATA_ROOT = "/ces-data";

/**
 * Return the CES-private data root.
 *
 * - Local: `<vellumRoot>/protected/credential-executor/`
 * - Managed: `/ces-data`
 */
export function getCesDataRoot(mode?: CesMode): string {
  const resolvedMode = mode ?? getCesMode();
  if (resolvedMode === "managed") {
    return MANAGED_CES_DATA_ROOT;
  }
  return join(getVellumRootDir(), "protected", "credential-executor");
}

// ---------------------------------------------------------------------------
// Subdirectory layout
// ---------------------------------------------------------------------------

/** Directory for CES grant persistence. */
export function getCesGrantsDir(mode?: CesMode): string {
  return join(getCesDataRoot(mode), "grants");
}

/** Directory for CES audit log persistence. */
export function getCesAuditDir(mode?: CesMode): string {
  return join(getCesDataRoot(mode), "audit");
}

/** Directory for CES secure tool store (registered secure command tools). */
export function getCesToolStoreDir(mode?: CesMode): string {
  return join(getCesDataRoot(mode), "toolstore");
}

// ---------------------------------------------------------------------------
// Bootstrap socket path (managed mode only)
// ---------------------------------------------------------------------------

/** Default directory for the bootstrap Unix socket shared volume. */
const BOOTSTRAP_SOCKET_DIR = "/run/ces";

/** Default bootstrap socket filename. */
const BOOTSTRAP_SOCKET_NAME = "ces.sock";

/**
 * Return the path to the bootstrap Unix socket.
 *
 * In managed mode, CES listens on this socket for exactly one assistant
 * connection, then unlinks it. The path is on a shared `emptyDir` volume
 * visible to both containers.
 *
 * Can be overridden via `CES_BOOTSTRAP_SOCKET` env var.
 */
export function getBootstrapSocketPath(): string {
  return (
    process.env["CES_BOOTSTRAP_SOCKET"] ??
    join(BOOTSTRAP_SOCKET_DIR, BOOTSTRAP_SOCKET_NAME)
  );
}

// ---------------------------------------------------------------------------
// Health port (managed mode only)
// ---------------------------------------------------------------------------

/** Default health probe port for managed CES. */
const DEFAULT_HEALTH_PORT = 7841;

/**
 * Return the health probe port for managed mode.
 *
 * Health probes are served on a dedicated HTTP port, separate from the
 * Unix socket command transport. This ensures liveness/readiness probes
 * work without a Unix socket client.
 */
export function getHealthPort(): number {
  const envPort = process.env["CES_HEALTH_PORT"];
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_HEALTH_PORT;
}
