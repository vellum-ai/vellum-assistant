/**
 * Resolution of a conversation's subagent lineage — the chain of forks that
 * leads back to the user-visible thread a background run belongs to.
 */

import { findConversation } from "./conversation-registry.js";

/** Depth cap: a subagent chain deeper than this is a bug, not a hierarchy. */
export const MAX_LINEAGE_DEPTH = 8;

/**
 * The conversation itself plus every subagent ancestor above it, nearest
 * first. A subagent Conversation records its spawner in the readonly
 * `parentConversationId` set at construction (see subagent/manager.ts), so
 * walking that chain reaches the user-visible thread a background run was
 * forked from. A non-resident ancestor ends the walk — the visible thread
 * is resident whenever a live background run is producing artifacts for it.
 */
export function resolveConversationLineage(conversationId: string): string[] {
  const lineage = [conversationId];
  const visited = new Set([conversationId]);

  let current = conversationId;
  while (lineage.length < MAX_LINEAGE_DEPTH) {
    const parent = findConversation(current)?.parentConversationId;
    if (!parent || visited.has(parent)) {
      break;
    }
    lineage.push(parent);
    visited.add(parent);
    current = parent;
  }

  return lineage;
}
