import type { ServerMessage } from "../../daemon/message-protocol.js";
import { browserManager } from "./browser-manager.js";

// Registry of sendToClient callbacks per conversation
const conversationSenders = new Map<string, (msg: ServerMessage) => void>();

/**
 * Register a sendToClient callback for a conversation.
 * Called from conversation-tool-setup when the conversation is created.
 */
export function registerConversationSender(
  conversationId: string,
  sendToClient: (msg: ServerMessage) => void,
): void {
  conversationSenders.set(conversationId, sendToClient);
}

/**
 * Unregister the sendToClient callback for a conversation.
 */
export function unregisterConversationSender(conversationId: string): void {
  conversationSenders.delete(conversationId);
}

function getSender(
  conversationId: string,
): ((msg: ServerMessage) => void) | undefined {
  return conversationSenders.get(conversationId);
}

export async function ensureScreencast(conversationId: string): Promise<void> {
  if (browserManager.isScreencastActive(conversationId)) return;

  try {
    // Ensure the page exists (may trigger browser launch/connect).
    // Must come before setScreencastActive since it creates the session entry.
    await browserManager.getOrCreateSessionPage(conversationId);
    browserManager.setScreencastActive(conversationId, true);
  } catch (err) {
    // Roll back so future calls can retry
    browserManager.setScreencastActive(conversationId, false);
    throw err;
  }
}

export async function stopBrowserScreencast(
  conversationId: string,
): Promise<void> {
  if (!browserManager.isScreencastActive(conversationId)) return;

  // Safe no-op if CDP screencast was never started
  await browserManager.stopScreencast(conversationId);
}

export async function stopAllScreencasts(): Promise<void> {
  // stopScreencast is called per-session inside closeAllPages/closeSession,
  // but this function is called from browser_close tool for the close_all_pages path.
  // The manager's closeAllPages handles it, so this is best-effort for any stragglers.
}

export function isScreencastActive(conversationId: string): boolean {
  return browserManager.isScreencastActive(conversationId);
}

export { getSender };
