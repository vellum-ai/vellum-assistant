import { getConversation } from "../memory/conversation-crud.js";
import { getConversationDirName } from "../memory/conversation-disk-view.js";
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
  const currentConversationPath =
    conversation && typeof conversation.createdAt === "number"
      ? `conversations/${getConversationDirName(conversation.id, conversation.createdAt)}/`
      : null;
  ctx.workspaceTopLevelContext = renderWorkspaceTopLevelContext(snapshot, {
    currentConversationPath,
    currentConversationAttachmentsPath: currentConversationPath
      ? `${currentConversationPath}attachments/`
      : null,
  });
  ctx.workspaceTopLevelDirty = false;
}
