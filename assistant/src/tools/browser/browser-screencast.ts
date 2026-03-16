import type { ServerMessage } from "../../daemon/message-protocol.js";
import { browserManager } from "./browser-manager.js";

// Track which conversations have an active browser page.
const activeBrowserConversations = new Set<string>();

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
  if (activeBrowserConversations.has(conversationId)) return;

  activeBrowserConversations.add(conversationId);

  try {
    // Ensure the page exists (may trigger browser launch/connect)
    await browserManager.getOrCreateSessionPage(conversationId);
  } catch (err) {
    // Roll back so future calls can retry
    activeBrowserConversations.delete(conversationId);
    throw err;
  }
}

export async function stopBrowserScreencast(
  conversationId: string,
): Promise<void> {
  if (!activeBrowserConversations.has(conversationId)) return;

  // Safe no-op if CDP screencast was never started
  await browserManager.stopScreencast(conversationId);

  activeBrowserConversations.delete(conversationId);
}

export async function stopAllScreencasts(): Promise<void> {
  for (const conversationId of activeBrowserConversations) {
    try {
      await browserManager.stopScreencast(conversationId);
    } catch {
      /* best-effort */
    }
  }
  activeBrowserConversations.clear();
}

export function isScreencastActive(conversationId: string): boolean {
  return activeBrowserConversations.has(conversationId);
}

export { getSender };
