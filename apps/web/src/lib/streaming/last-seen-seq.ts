/**
 * Per-conversation seq cursor backed by localStorage.
 *
 * Tracks the highest `seq` value applied from the SSE stream for each
 * conversation. Used by B7.3 gap detection: when an incoming event's
 * `seq` exceeds `stored + 1`, the consumer knows events were lost and
 * can trigger a reconcile/refetch.
 *
 * Writes are monotonic — `setLastSeenSeq` only updates when the new
 * value is strictly greater than the current value. All localStorage
 * operations are wrapped in try/catch so private-browsing or
 * quota-exceeded environments fall back to in-memory-only tracking.
 */

const STORAGE_KEY_PREFIX = "vellum.lastSeenSeq.";

const seqMap = new Map<string, number>();

function storageKey(conversationId: string): string {
  return `${STORAGE_KEY_PREFIX}${conversationId}`;
}

/**
 * Read the last-seen seq for a conversation.
 * Returns `null` if no seq has been recorded.
 */
export function getLastSeenSeq(conversationId: string): number | null {
  return seqMap.get(conversationId) ?? null;
}

/**
 * Persist a seq value for a conversation. Only writes if `seq` is
 * strictly greater than the current stored value (monotonic).
 * Writes through to localStorage synchronously.
 */
export function setLastSeenSeq(conversationId: string, seq: number): void {
  const current = seqMap.get(conversationId);
  if (current !== undefined && seq <= current) return;

  seqMap.set(conversationId, seq);
  try {
    localStorage.setItem(storageKey(conversationId), String(seq));
  } catch {
    // Quota exceeded or private browsing — in-memory only.
  }
}

/**
 * Populate the in-memory map from localStorage. Called once at
 * chat-page mount so the cursor is seeded before the bus subscriber
 * fires. Idempotent — safe to call multiple times.
 */
export function hydrateLastSeenSeqFromStorage(): void {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(STORAGE_KEY_PREFIX)) continue;
      const conversationId = key.slice(STORAGE_KEY_PREFIX.length);
      const raw = localStorage.getItem(key);
      if (raw == null) continue;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) continue;
      const current = seqMap.get(conversationId);
      if (current === undefined || parsed > current) {
        seqMap.set(conversationId, parsed);
      }
    }
  } catch {
    // localStorage unavailable — in-memory only.
  }
}

/**
 * Clear the stored seq for a conversation. Used when a conversation
 * becomes the active conversation to avoid spurious gap detection
 * from stale cursors after a conversation switch.
 */
export function clearLastSeenSeq(conversationId: string): void {
  seqMap.delete(conversationId);
  try {
    localStorage.removeItem(storageKey(conversationId));
  } catch {
    // localStorage unavailable.
  }
}

/** Reset all state. Test-only. */
export function __resetLastSeenSeqForTesting(): void {
  seqMap.clear();
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_KEY_PREFIX)) keysToRemove.push(key);
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage unavailable.
  }
}
