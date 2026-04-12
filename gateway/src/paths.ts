/**
 * Core path helpers for the gateway module.
 *
 * These live in their own file (rather than credential-reader.ts) so that
 * lightweight consumers like CLI scripts can resolve workspace / root paths
 * without pulling in the full credential-reader dependency tree.
 */

import { join } from "node:path";

export function getRootDir(): string {
  return join(
    process.env.BASE_DATA_DIR?.trim() || (process.env.HOME ?? "/tmp"),
    ".vellum",
  );
}

/**
 * Returns the workspace root for user-facing state.
 *
 * When VELLUM_WORKSPACE_DIR is set, returns that value (used in containerized
 * deployments where the workspace is a separate volume). Otherwise falls back
 * to ~/.vellum/workspace.
 */
export function getWorkspaceDir(): string {
  const override = process.env.VELLUM_WORKSPACE_DIR?.trim();
  if (override) return override;
  return join(getRootDir(), "workspace");
}
