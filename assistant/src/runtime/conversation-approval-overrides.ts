/**
 * Per-conversation temporary approval overrides.
 *
 * When a user chooses `allow_conversation` or `allow_10m`, the session records a
 * temporary approval mode scoped to the conversation. Subsequent tool-use
 * confirmations within the same conversation can check this state to
 * auto-approve without prompting.
 *
 * State is in-memory only -- it does not survive daemon restarts, which is
 * the desired behavior for temporary approvals. Conversation-scoped overrides
 * persist until the session ends or the mode is explicitly cleared. Timed
 * overrides expire after their TTL (checked at read time, no background sweep).
 */

export type TemporaryApprovalMode =
  | { kind: "conversation" }
  | { kind: "timed"; expiresAt: number };

const DEFAULT_TIMED_DURATION_MS = 10 * 60 * 1000; // 10 minutes

const store = new Map<string, TemporaryApprovalMode>();

/**
 * Set conversation-scoped temporary approval for a conversation.
 * Remains active until explicitly cleared or session ends.
 * Replaces any existing mode for the conversation.
 */
export function setConversationMode(conversationId: string): void {
  store.set(conversationId, { kind: "conversation" });
}

/**
 * Set time-limited temporary approval for a conversation.
 * Replaces any existing mode for the conversation.
 *
 * @param conversationId - The conversation to scope the override to
 * @param durationMs - How long the override lasts (defaults to 10 minutes)
 */
export function setTimedMode(
  conversationId: string,
  durationMs: number = DEFAULT_TIMED_DURATION_MS,
): void {
  store.set(conversationId, {
    kind: "timed",
    expiresAt: Date.now() + durationMs,
  });
}

/**
 * Clear any temporary approval mode for a conversation.
 */
export function clearMode(conversationId: string): void {
  store.delete(conversationId);
}

/**
 * Get the effective temporary approval mode for a conversation.
 *
 * Returns undefined if no mode is set or if a timed mode has expired.
 * Expired timed modes are cleaned up lazily on read.
 */
export function getEffectiveMode(
  conversationId: string,
): TemporaryApprovalMode | undefined {
  const mode = store.get(conversationId);
  if (!mode) return undefined;

  if (mode.kind === "timed" && Date.now() >= mode.expiresAt) {
    store.delete(conversationId);
    return undefined;
  }

  return mode;
}

/**
 * Check whether a conversation has an active (non-expired) temporary approval.
 */
export function hasActiveOverride(conversationId: string): boolean {
  return getEffectiveMode(conversationId) !== undefined;
}

/** Clear all overrides. Useful for testing. */
export function clearAll(): void {
  store.clear();
}
