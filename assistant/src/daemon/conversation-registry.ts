/**
 * In-memory registry of active {@link Conversation} instances, keyed by
 * conversation ID, plus the read/write accessors over it.
 *
 * This is a leaf module: it imports `Conversation` as a type only, so any
 * layer — including the memory-retrieval plugin's injectors, which only know a
 * conversation id — can look up the live conversation and read its state
 * without pulling in the daemon-core creation graph (providers, system-prompt
 * assembly, the `Conversation` class value) that `getOrCreateConversation` in
 * `conversation-store` depends on. Keeping the registry free of those value
 * imports is what lets the injector chain consume it without forming an import
 * cycle (`injectors → store → conversation → agent-loop → runtime-assembly →
 * injector-chain → injectors`).
 *
 * `conversation-store` owns the creation/reuse lifecycle and writes top-level
 * conversations into this map via {@link setConversation}.
 */

import type { Conversation } from "./conversation.js";

const conversations = new Map<string, Conversation>();

// ── Read helpers ───────────────────────────────────────────────────

export function findConversation(
  conversationId: string | undefined,
): Conversation | undefined {
  if (!conversationId) return undefined;
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

// ── Subagent live-conversation index ───────────────────────────────
//
// Subagents run their own agent loop — and therefore the injector chain — but
// are owned by the `SubagentManager` rather than the daemon's eviction-managed
// store, so they are deliberately absent from `conversations` above. This
// point-lookup index lets the per-conversation injectors (workspace context,
// disk-pressure warning) resolve a subagent's live `Conversation` by id and
// read state off it. It is intentionally excluded from the iteration accessors
// and the evictor map so subagent lifecycle stays solely with the manager.

const subagentConversations = new Map<string, Conversation>();

/** Register a subagent's live conversation for point lookups. */
export function setSubagentConversation(
  conversationId: string,
  conversation: Conversation,
): void {
  subagentConversations.set(conversationId, conversation);
}

/**
 * Remove a subagent's conversation from the index. Guards against clobbering a
 * newer registration for the same id by only deleting when the stored entry
 * still points at this instance.
 */
export function removeSubagentConversation(
  conversationId: string,
  conversation: Conversation,
): void {
  if (subagentConversations.get(conversationId) === conversation) {
    subagentConversations.delete(conversationId);
  }
}

/**
 * Resolve a live `Conversation` by id, including subagent conversations.
 * Top-level conversations are checked first, then subagents. Used by the
 * per-conversation injectors, which run for subagent turns too; other callers
 * should use {@link findConversation}, which is scoped to the eviction-managed
 * top-level conversations.
 */
export function findConversationOrSubagent(
  conversationId: string | undefined,
): Conversation | undefined {
  if (!conversationId) return undefined;
  return (
    conversations.get(conversationId) ??
    subagentConversations.get(conversationId)
  );
}
