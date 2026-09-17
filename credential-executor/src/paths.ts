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
 * - **Managed**: CES private state lives at `/ces-data` by default
 *   (overridable via `CES_DATA_DIR` env var). The assistant container never
 *   sees this path.
 *
 * The assistant-visible data root (where workspace, embeddings, etc. live)
 * is a separate path and must never be used for CES-private writes.
 */

import { join } from "node:path";
import { homedir } from "node:os";

import { resolveIpcEndpoint } from "@vellumai/ipc-server-utils";

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
 * Resolve the CES security directory.
 *
 * Priority:
 * 1. `CREDENTIAL_SECURITY_DIR` env var (set by the platform template for the
 *    CES container — `/ces-security` in managed mode)
 * 2. Default: `~/.vellum/protected` (local mode shares the filesystem with
 *    the gateway)
 */
export function getSecurityDir(): string {
  return (
    process.env["CREDENTIAL_SECURITY_DIR"]?.trim() ||
    join(homedir(), ".vellum", "protected")
  );
}

/**
 * Default managed CES data root.
 *
 * Defaults to `/ces-data` — the platform template provisions this path
 * via the `CES_DATA_DIR` env var and a dedicated PVC.
 */
const DEFAULT_MANAGED_CES_DATA_ROOT = "/ces-data";

/**
 * Return the CES-private data root.
 *
 * - Local: `<securityDir>/credential-executor/`
 * - Managed: `CES_DATA_DIR` env var, or `/ces-data` by default
 */
export function getCesDataRoot(mode?: CesMode): string {
  const resolvedMode = mode ?? getCesMode();
  if (resolvedMode === "managed") {
    return process.env["CES_DATA_DIR"] ?? DEFAULT_MANAGED_CES_DATA_ROOT;
  }
  return join(getSecurityDir(), "credential-executor");
}

// ---------------------------------------------------------------------------
// Subdirectory layout
// ---------------------------------------------------------------------------

/** Directory for CES log files. */
export function getCesLogDir(mode?: CesMode): string {
  return join(getCesDataRoot(mode), "logs");
}

// ---------------------------------------------------------------------------
// CES socket path (local sibling and managed sidecar)
// ---------------------------------------------------------------------------

/** Default directory for the CES Unix socket. */
const BOOTSTRAP_SOCKET_DIR = "/run/ces-bootstrap";

/**
 * Return the path to the CES Unix socket used in every environment.
 *
 * Local siblings and managed sidecars share this resolver. The assistant
 * dials the same path CES binds.
 *
 * Uses `CES_BOOTSTRAP_SOCKET_DIR` when set, otherwise `/run/ces-bootstrap`.
 * `ces.sock` is resolved through `resolveIpcEndpoint` so macOS AF_UNIX
 * limits and Windows named pipes stay consistent.
 *
 * The pod template and local CLI export `CES_BOOTSTRAP_SOCKET_DIR`.
 */
export function getBootstrapSocketPath(): string {
  const dir =
    process.env["CES_BOOTSTRAP_SOCKET_DIR"]?.trim() || BOOTSTRAP_SOCKET_DIR;
  return resolveIpcEndpoint("ces", { workspaceDir: dir }).path;
}

// ---------------------------------------------------------------------------
// Health port (managed mode only)
// ---------------------------------------------------------------------------

/** Default health probe port for managed CES. */
const DEFAULT_HEALTH_PORT = 8090;

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
