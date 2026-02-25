/**
 * In-memory registry of conversation IDs whose owning task or schedule has
 * failed. The memory extraction worker checks this before processing
 * `extract_items` jobs — if the conversation is marked as failed, extraction
 * is skipped to prevent stale `assistant_inferred` items from being created
 * after the one-shot invalidation in `task-memory-cleanup.ts` has already run.
 *
 * This is intentionally in-memory: on process restart, the set is empty, which
 * is safe because any pending extraction jobs are also reset. The persistent
 * invalidation in `task-memory-cleanup.ts` remains as the belt-and-suspenders
 * safety net.
 */

const failedConversationIds = new Set<string>();

export function markConversationFailed(conversationId: string): void {
  failedConversationIds.add(conversationId);
}

export function isConversationFailed(conversationId: string): boolean {
  return failedConversationIds.has(conversationId);
}

/** Clear all entries — exposed for testing only. */
export function resetFailedConversations(): void {
  failedConversationIds.clear();
}
