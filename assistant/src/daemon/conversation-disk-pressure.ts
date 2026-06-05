/**
 * Subset of Conversation state the disk-pressure warning injector reads.
 */
export interface DiskPressureConversationContext {
  conversationId: string;
  /**
   * True when the current turn is restricted to disk-pressure cleanup-safe
   * work. Set per turn by the agent loop when it classifies the turn's
   * disk-pressure policy; the injector reads the live value to decide whether
   * to emit the cleanup warning.
   */
  diskPressureCleanupModeActive?: boolean;
}

/**
 * Registry of the live, per-conversation disk-pressure contexts keyed by
 * conversation id. A `Conversation` registers itself on construction and
 * removes itself on `dispose`, so the `disk-pressure-warning` injector — which
 * only knows a conversation id — can source the turn's cleanup-mode flag itself
 * instead of having the agent loop compute and thread it. Not a general service
 * locator: it exposes only the cleanup-mode slice, and the daemon's
 * `Conversation` remains the owner of the instance's lifecycle and of the
 * flag's per-turn value.
 */
const liveByConversation = new Map<string, DiskPressureConversationContext>();

/** Register a conversation's live disk-pressure context in the lookup registry. */
export function registerConversationDiskPressure(
  ctx: DiskPressureConversationContext,
): void {
  liveByConversation.set(ctx.conversationId, ctx);
}

/**
 * Remove a conversation's disk-pressure context from the registry. Guards
 * against clobbering a newer registration for the same id (eviction +
 * recreation) by only deleting when the stored entry still points at this
 * instance.
 */
export function unregisterConversationDiskPressure(
  ctx: DiskPressureConversationContext,
): void {
  if (liveByConversation.get(ctx.conversationId) === ctx) {
    liveByConversation.delete(ctx.conversationId);
  }
}

/**
 * Whether the conversation's current turn is running in disk-pressure cleanup
 * mode. Returns `false` when no conversation is registered (no active
 * conversation, or a context with no conversation id).
 */
export function isDiskPressureCleanupModeActive(
  conversationId: string | undefined,
): boolean {
  if (!conversationId) return false;
  return (
    liveByConversation.get(conversationId)?.diskPressureCleanupModeActive ===
    true
  );
}
