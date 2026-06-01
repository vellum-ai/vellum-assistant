/**
 * Per-conversation seq cursor backed by localStorage.
 *
 * Tracks the highest `seq` value applied from the SSE stream for each
 * conversation. Used by B7.3 gap detection: when an incoming event's
 * `seq` exceeds `stored + 1`, the consumer knows events were lost and
 * can trigger a reconcile/refetch.
 *
 * Writes are monotonic — `setLastSeenSeq` only updates when the new
 * value is strictly greater than the current value.
 *
 * `replaceLastSeenSeq` unconditionally replaces the cursor. Used when
 * the server seq counter restarts (e.g., daemon restart) and the
 * observed seq is lower than the stored value.
 *
 * The in-memory map is capped at {@link MAX_TRACKED_CONVERSATIONS}.
 * When the cap is exceeded, the oldest entry (Map iteration order =
 * insertion order) is evicted from both memory and localStorage.
 * Every write promotes the conversation to the end of the map so
 * recently-active conversations are retained.
 *
 * All localStorage operations are wrapped in try/catch so
 * private-browsing or quota-exceeded environments fall back to
 * in-memory-only tracking.
 */

const STORAGE_KEY_PREFIX = "vellum.lastSeenSeq.";

/** Visible for testing. */
export const MAX_TRACKED_CONVERSATIONS = 256;

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
 * Write a cursor value, promote the conversation to the end of the
 * Map (LRU), and evict the oldest entry if over capacity.
 */
function writeThrough(conversationId: string, seq: number): void {
  // Delete-then-set promotes to the end of Map iteration order.
  seqMap.delete(conversationId);
  seqMap.set(conversationId, seq);

  if (seqMap.size > MAX_TRACKED_CONVERSATIONS) {
    const oldest = seqMap.keys().next().value;
    if (oldest != null) {
      seqMap.delete(oldest);
      try {
        localStorage.removeItem(storageKey(oldest));
      } catch {
        // localStorage unavailable.
      }
    }
  }

  try {
    localStorage.setItem(storageKey(conversationId), String(seq));
  } catch {
    // Quota exceeded or private browsing — in-memory only.
  }
}

/**
 * Persist a seq value for a conversation. Only writes if `seq` is
 * strictly greater than the current stored value (monotonic).
 * Writes through to localStorage synchronously.
 */
export function setLastSeenSeq(conversationId: string, seq: number): void {
  const current = seqMap.get(conversationId);
  if (current !== undefined && seq <= current) {
    return;
  }
  writeThrough(conversationId, seq);
}

/**
 * Unconditionally replace the cursor for a conversation. Used when
 * a backwards seq is observed (server restarted and counters reset).
 * Unlike `setLastSeenSeq`, this does not enforce monotonicity.
 */
export function replaceLastSeenSeq(conversationId: string, seq: number): void {
  writeThrough(conversationId, seq);
}

/**
 * Populate the in-memory map from localStorage. Called once at
 * chat-page mount so the cursor is seeded before the bus subscriber
 * fires. Idempotent — safe to call multiple times.
 *
 * If localStorage contains more keys than {@link MAX_TRACKED_CONVERSATIONS},
 * excess entries are pruned from localStorage to bound storage growth.
 */
export function hydrateLastSeenSeqFromStorage(): void {
  try {
    const entries: Array<{ conversationId: string; seq: number }> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(STORAGE_KEY_PREFIX)) {
        continue;
      }
      const conversationId = key.slice(STORAGE_KEY_PREFIX.length);
      const raw = localStorage.getItem(key);
      if (raw == null) {
        continue;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        continue;
      }
      entries.push({ conversationId, seq: parsed });
    }

    // Sort ascending so lowest-seq (oldest) entries are inserted first.
    // Map preserves insertion order, and writeThrough evicts from the
    // front, so the highest-seq (most recent) entries must be last.
    entries.sort((a, b) => a.seq - b.seq);

    // When localStorage has accumulated more than the cap, prune the
    // lowest-seq entries from localStorage and keep only the tail.
    if (entries.length > MAX_TRACKED_CONVERSATIONS) {
      const pruneCount = entries.length - MAX_TRACKED_CONVERSATIONS;
      for (let i = 0; i < pruneCount; i++) {
        localStorage.removeItem(storageKey(entries[i].conversationId));
      }
      entries.splice(0, pruneCount);
    }

    for (const { conversationId, seq } of entries) {
      const current = seqMap.get(conversationId);
      if (current === undefined || seq > current) {
        seqMap.set(conversationId, seq);
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

/** Snapshot of all in-memory seq cursors. Keyed by conversationId. */
export function getSeqCursors(): Record<string, number> {
  return Object.fromEntries(seqMap);
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
