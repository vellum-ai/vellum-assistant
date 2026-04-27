/**
 * Module-private in-memory conversation store.
 *
 * All active {@link Conversation} instances live here. External code
 * accesses them exclusively through the exported helper functions,
 * decoupling route handlers and IPC callbacks from the DaemonServer
 * class.
 */

import type { Conversation } from "./conversation.js";

// ── Private store ──────────────────────────────────────────────────

const conversations = new Map<string, Conversation>();

// ── Read helpers ───────────────────────────────────────────────────

export function findConversation(
  conversationId: string,
): Conversation | undefined {
  return conversations.get(conversationId);
}

export function findConversationBySurfaceId(
  surfaceId: string,
): Conversation | undefined {
  // Fast path: exact surfaceId match in surfaceState
  for (const c of conversations.values()) {
    if (c.surfaceState.has(surfaceId)) return c;
  }

  // Fallback: standalone app surfaces use "app-open-{appId}" IDs that
  // were never part of any conversation.  Extract the appId and find
  // a conversation whose surfaceState has a surface for that app.
  const appOpenPrefix = "app-open-";
  if (surfaceId.startsWith(appOpenPrefix)) {
    const appId = surfaceId.slice(appOpenPrefix.length);
    for (const c of conversations.values()) {
      for (const [, state] of c.surfaceState.entries()) {
        const data = state.data as unknown as Record<string, unknown>;
        if (data?.appId === appId) {
          // Register this surfaceId so subsequent lookups are O(1)
          c.surfaceState.set(surfaceId, state);
          return c;
        }
      }
    }
  }

  return undefined;
}

export function hasConversation(conversationId: string): boolean {
  return conversations.has(conversationId);
}

export function conversationCount(): number {
  return conversations.size;
}

/** Iterate over all active conversations. */
export function allConversations(): IterableIterator<Conversation> {
  return conversations.values();
}

/** Iterate over all [id, conversation] entries. */
export function conversationEntries(): IterableIterator<
  [string, Conversation]
> {
  return conversations.entries();
}

/** Iterate over all active conversation IDs. */
export function conversationIds(): IterableIterator<string> {
  return conversations.keys();
}

// ── Write helpers ──────────────────────────────────────────────────

export function setConversation(
  conversationId: string,
  conversation: Conversation,
): void {
  conversations.set(conversationId, conversation);
}

export function deleteConversation(conversationId: string): boolean {
  return conversations.delete(conversationId);
}

export function clearConversations(): void {
  conversations.clear();
}

// ── Underlying Map (for the evictor, which takes a mutable ref) ───

/**
 * Expose the raw Map for the {@link ConversationEvictor}, which needs
 * a mutable reference to delete entries during sweeps. No other code
 * should use this — prefer the named helpers above.
 */
export function getConversationMap(): Map<string, Conversation> {
  return conversations;
}
