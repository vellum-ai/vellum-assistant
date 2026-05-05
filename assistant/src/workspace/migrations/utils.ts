import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Resolve the legacy Vellum root directory (~/.vellum).
 *
 * Resolution order:
 * 1. Parent of VELLUM_WORKSPACE_DIR — e.g. /data/.vellum/workspace → /data/.vellum
 * 2. If that parent is "/" (workspace at top level, e.g. /workspace), fall back
 *    to homedir()/.vellum
 *
 * This replaces the old inlined `getRootDir()` pattern used by individual migrations.
 */
export function getVellumRoot(): string {
  const workspaceDir = process.env.VELLUM_WORKSPACE_DIR?.trim();
  if (workspaceDir) {
    const parent = dirname(workspaceDir);
    if (parent !== "/") return parent;
  }
  return join(homedir(), ".vellum");
}
