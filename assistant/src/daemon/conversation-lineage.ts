/**
 * Resolution of a conversation's subagent lineage — the chain of forks that
 * leads back to the user-visible thread a background run belongs to.
 */

import { findConversationOrSubagent } from "./conversation-registry.js";

/** Depth cap: a subagent chain deeper than this is a bug, not a hierarchy. */
export const MAX_LINEAGE_DEPTH = 8;

/**
 * The conversation itself plus every subagent ancestor above it, nearest
 * first. A subagent Conversation records its spawner in the readonly
 * `parentConversationId` set at construction (see subagent/manager.ts), so
 * walking that chain reaches the user-visible thread a background run was
 * forked from.
 *
 * Every hop — including the seed conversation — resolves through
 * {@link findConversationOrSubagent}, because the seed is typically a
 * background subagent, and `SubagentManager` keeps live subagent
 * conversations in their own index rather than the eviction-managed
 * top-level store.
 *
 * Only resident conversations are readable: a top-level conversation until
 * the evictor sweeps it, a subagent conversation while its run is live (the
 * manager drops the index entry once the subagent goes terminal). An id
 * resolvable in neither index ends the walk, so the returned chain can be
 * shorter than the true ancestry. The user-visible thread is resident
 * whenever a live background run is producing artifacts for it.
 */
export function resolveConversationLineage(conversationId: string): string[] {
  const lineage = [conversationId];
  const visited = new Set([conversationId]);

  let current = conversationId;
  while (lineage.length < MAX_LINEAGE_DEPTH) {
    const parent = findConversationOrSubagent(current)?.parentConversationId;
    if (!parent || visited.has(parent)) {
      break;
    }
    lineage.push(parent);
    visited.add(parent);
    current = parent;
  }

  return lineage;
}
