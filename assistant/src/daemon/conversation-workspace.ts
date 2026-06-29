import { join } from "node:path";

import { getConversation } from "../persistence/conversation-crud.js";
import { resolveConversationDirectoryPaths } from "../persistence/conversation-directories.js";
import { renderWorkspaceTopLevelContext } from "../workspace/top-level-renderer.js";
import { scanTopLevelDirectories } from "../workspace/top-level-scanner.js";
import { findConversationOrSubagent } from "./conversation-registry.js";

/**
 * Subset of Conversation state that workspace context helpers need.
 */
export interface WorkspaceConversationContext {
  conversationId: string;
  workingDir: string;
  workspaceTopLevelContext: string | null;
  workspaceTopLevelDirty: boolean;
  /**
   * Client-reported host home directory, populated from host-proxy
   * transport metadata (see `supportsHostProxy` / `HostProxyInterfaceId`).
   * Used to render the `<workspace>` block correctly for platform-managed
   * daemons where `os.homedir()` would return the container's home instead
   * of the user's actual client-side home.
   */
  hostHomeDir?: string;
  /** Client-reported host username. See `hostHomeDir`. */
  hostUsername?: string;
}

/**
 * Resolve the live workspace top-level block for a conversation, refreshing
 * the dirty-guarded cache first so a workspace-mutating tool's
 * `markWorkspaceTopLevelDirty` from the prior turn is picked up. Returns `null`
 * when no live conversation is found (no active conversation, or a context with
 * no conversation id) or when the rendered context is empty.
 */
export function resolveWorkspaceTopLevelContext(
  conversationId: string | undefined,
): string | null {
  const conversation = findConversationOrSubagent(conversationId);
  if (!conversation) return null;
  refreshWorkspaceTopLevelContextIfNeeded(conversation);
  return conversation.workspaceTopLevelContext;
}

/** Refresh workspace top-level directory context if needed. */
export function refreshWorkspaceTopLevelContextIfNeeded(
  ctx: WorkspaceConversationContext,
): void {
  if (!ctx.workspaceTopLevelDirty && ctx.workspaceTopLevelContext != null)
    return;
  const snapshot = scanTopLevelDirectories(ctx.workingDir);
  const conversation = getConversation(ctx.conversationId);
  let currentConversationPath: string | null = null;
  if (conversation && typeof conversation.createdAt === "number") {
    const { resolvedDirName } = resolveConversationDirectoryPaths(
      conversation.id,
      conversation.createdAt,
      join(ctx.workingDir, "conversations"),
    );
    currentConversationPath = `conversations/${resolvedDirName}/`;
  }
  ctx.workspaceTopLevelContext = renderWorkspaceTopLevelContext(snapshot, {
    conversationAttachmentsPath: currentConversationPath
      ? `${currentConversationPath}attachments/`
      : null,
    hostHomeDir: ctx.hostHomeDir,
    hostUsername: ctx.hostUsername,
  });
  ctx.workspaceTopLevelDirty = false;
}
