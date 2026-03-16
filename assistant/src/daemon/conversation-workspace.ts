import { renderWorkspaceTopLevelContext } from "../workspace/top-level-renderer.js";
import { scanTopLevelDirectories } from "../workspace/top-level-scanner.js";

/**
 * Subset of Session state that workspace context helpers need.
 */
export interface WorkspaceSessionContext {
  workingDir: string;
  workspaceTopLevelContext: string | null;
  workspaceTopLevelDirty: boolean;
}

/** Refresh workspace top-level directory context if needed. */
export function refreshWorkspaceTopLevelContextIfNeeded(
  ctx: WorkspaceSessionContext,
): void {
  if (!ctx.workspaceTopLevelDirty && ctx.workspaceTopLevelContext != null)
    return;
  const snapshot = scanTopLevelDirectories(ctx.workingDir);
  ctx.workspaceTopLevelContext = renderWorkspaceTopLevelContext(snapshot);
  ctx.workspaceTopLevelDirty = false;
}
