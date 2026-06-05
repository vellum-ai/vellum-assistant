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
 * Registry of the live, per-conversation workspace contexts keyed by
 * conversation id. A `Conversation` registers itself on construction and
 * removes itself on `dispose`, so the `workspace-context` injector — which
 * only knows a conversation id — can source the dirty-guarded top-level cache
 * itself instead of having the agent loop compute and thread it. Not a general
 * service locator: it holds only the workspace-context slice, and the daemon's
 * `Conversation` remains the owner of the instance's lifecycle.
 */
const liveByConversation = new Map<string, WorkspaceConversationContext>();

/** Register a conversation's live workspace context in the lookup registry. */
export function registerConversationWorkspace(
  ctx: WorkspaceConversationContext,
): void {
  liveByConversation.set(ctx.conversationId, ctx);
}

/**
 * Remove a conversation's workspace context from the registry. Guards against
 * clobbering a newer registration for the same id (eviction + recreation) by
 * only deleting when the stored entry still points at this instance.
 */
export function unregisterConversationWorkspace(
  ctx: WorkspaceConversationContext,
): void {
  if (liveByConversation.get(ctx.conversationId) === ctx) {
    liveByConversation.delete(ctx.conversationId);
  }
}

/**
 * Resolve the live workspace top-level block for a conversation, refreshing
 * the dirty-guarded cache first so a workspace-mutating tool's
 * `markWorkspaceTopLevelDirty` from the prior turn is picked up. Returns `null`
 * when no conversation is registered (no active conversation, or a context with
 * no conversation id) or when the rendered context is empty.
 */
export function resolveWorkspaceTopLevelContext(
  conversationId: string | undefined,
): string | null {
  if (!conversationId) return null;
  const ctx = liveByConversation.get(conversationId);
  if (!ctx) return null;
  refreshWorkspaceTopLevelContextIfNeeded(ctx);
  return ctx.workspaceTopLevelContext;
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
