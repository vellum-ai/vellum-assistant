import { join } from "node:path";

import { getConversation } from "../memory/conversation-crud.js";
import { resolveConversationDirectoryPaths } from "../memory/conversation-directories.js";
import { renderWorkspaceTopLevelContext } from "../workspace/top-level-renderer.js";
import { scanTopLevelDirectories } from "../workspace/top-level-scanner.js";

/**
 * Subset of Conversation state that workspace context helpers need.
 */
export interface WorkspaceConversationContext {
  conversationId: string;
  workingDir: string;
  workspaceTopLevelContext: string | null;
  workspaceTopLevelDirty: boolean;
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
    currentConversationPath,
    currentConversationAttachmentsPath: currentConversationPath
      ? `${currentConversationPath}attachments/`
      : null,
  });
  ctx.workspaceTopLevelDirty = false;
}
