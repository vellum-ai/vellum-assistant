/**
 * Resolution of a conversation's subagent lineage — the chain of forks that
 * leads back to the user-visible thread a background run belongs to.
 */

import { getPersistedParentConversationId } from "../persistence/conversation-parent.js";
import { findConversationOrSubagent } from "./conversation-registry.js";

/**
 * Depth cap: a subagent chain deeper than this is a bug, not a hierarchy.
 * Matches the fork-chain cap in the memory plugin's ancestor walk so the two
 * conversation-ancestry walks agree on what counts as pathological.
 */
export const MAX_LINEAGE_DEPTH = 16;

/**
 * The spawner of a conversation: the in-memory registry's record, falling back
 * to the persisted `parent_conversation_id` column. Returns `undefined` at the
 * top of the chain.
 *
 * Both sources are consulted because residency is short-lived —
 * `SubagentManager` drops a subagent's index entry the moment its run goes
 * terminal, and the evictor sweeps idle top-level conversations — and because
 * a resident instance does not necessarily carry the parentage its row does.
 * The column is stamped at subagent bootstrap and outlives both.
 *
 * A failed durable read is swallowed: linking artifacts to a partial chain is
 * better than failing the caller, which is always a best-effort side effect.
 */
function parentOf(conversationId: string): string | undefined {
  const resident = findConversationOrSubagent(conversationId);
  if (resident?.parentConversationId) {
    return resident.parentConversationId;
  }
  try {
    return getPersistedParentConversationId(conversationId);
  } catch {
    return undefined;
  }
}

/**
 * The conversation itself plus every subagent ancestor above it, nearest
 * first. A subagent Conversation records its spawner in the readonly
 * `parentConversationId` set at construction (see subagent/manager.ts) and in
 * the `parent_conversation_id` column written at bootstrap, so walking that
 * chain reaches the user-visible thread a background run was forked from.
 *
 * Resident hops resolve through {@link findConversationOrSubagent}, because
 * the seed is typically a background subagent and `SubagentManager` keeps live
 * subagent conversations in their own index rather than the eviction-managed
 * top-level store. Non-resident hops fall back to the durable column, so a
 * link attempted after the run went terminal or the thread was evicted still
 * reaches the user-visible ancestor.
 *
 * Never throws: a failed database read degrades to the chain resolved so far,
 * which can therefore be shorter than the true ancestry. Bounded by
 * {@link MAX_LINEAGE_DEPTH} and a visited set, so a cycle terminates.
 */
export function resolveConversationLineage(conversationId: string): string[] {
  const lineage = [conversationId];
  const visited = new Set([conversationId]);

  let current = conversationId;
  while (lineage.length < MAX_LINEAGE_DEPTH) {
    const parent = parentOf(current);
    if (!parent || visited.has(parent)) {
      break;
    }
    lineage.push(parent);
    visited.add(parent);
    current = parent;
  }

  return lineage;
}
