/**
 * Seed-race heal for prefix-less re-attach bubbles.
 *
 * When a client re-attaches to an in-flight turn it didn't start (a refresh or
 * a visibility-driven reconnect), the daemon replays the current LLM call's
 * deltas under *that call's* `messageId`. The persisted turn row, though, is
 * anchored on an earlier call's id, with the replayed id folded in as a
 * `mergedMessageIds` alias (the daemon's `mergeConsecutiveAssistantMessages`
 * collapses a multi-call turn onto the first row's id).
 *
 * `resolveHistoryTwin` (stream-handlers/message-handlers.ts) normally seeds a
 * re-attaching live row from its persisted prefix so the live row stays a
 * superset of its history twin — the invariant `selectTranscriptMessages`
 * relies on when it lets the live copy win on content. But the seed lookup is
 * lazy and reads the history cache at delta time: if the first replayed delta
 * beats the initial `/messages` fetch, the cache is empty, no twin is found,
 * and a fresh prefix-less bubble is opened (`createStreamingBubble`). It then
 * holds only the post-reconnect suffix and carries none of the persisted
 * prefix. Once the snapshot lands, the overlay matches that suffix-only bubble
 * to the rich history row *via the history-side alias* and — under "live wins"
 * — the bubble shadows the full answer (a finished reply collapses to a bare
 * "thinking…" fragment: the "messages disappearing on refresh" report).
 *
 * This module is the heal: when a fresh snapshot arrives, drop any live row
 * that is exactly this shape so the authoritative history row renders. The
 * next streamed delta re-seeds the live row from its twin (now cached),
 * restoring the superset invariant. Dropping — rather than merging the two
 * rows at render — is deliberate: a render-time concat can't tell which
 * segments overlap (the per-event `seq` is gone once a delta folds into a
 * row), so it risks double-counting; re-seeding rebuilds the row from the
 * prefix and lets `local-seq` idempotency keep the streamed suffix disjoint.
 */

import {
  messageIdentityKeys,
  messageMatchKeys,
} from "@/domains/chat/utils/message-identity";
import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * A live assistant row shadows a history row when the history row folded the
 * live row's id in as an alias, yet the live row does NOT itself carry the
 * history row's primary id. That asymmetry is the prefix-less signature: the
 * match exists only because the daemon merged the ids server-side, not because
 * the live row is the seeded twin (which carries the primary id and
 * legitimately wins on content).
 */
function isShadowedByHistory(
  liveRow: DisplayMessage,
  historyByKey: Map<string, DisplayMessage>,
): boolean {
  if (liveRow.role !== "assistant" || liveRow.isOptimistic) return false;
  const liveKeys = messageMatchKeys(liveRow);
  for (const key of liveKeys) {
    const twin = historyByKey.get(key);
    // A shadow only when the matched persisted row's *primary* id is not one
    // the live row carries — otherwise this is the seeded / client-merged row
    // that should keep winning.
    if (twin && !liveKeys.includes(twin.id)) return true;
  }
  return false;
}

/**
 * Drop live-turn rows that are prefix-less re-attach shadows of a richer
 * persisted history row. Returns the same `live` reference when nothing is
 * shadowed, so a no-op snapshot update doesn't churn the live turn.
 */
export function pruneShadowedReattachRows(
  live: DisplayMessage[],
  history: DisplayMessage[],
): DisplayMessage[] {
  if (live.length === 0 || history.length === 0) return live;

  // Index persisted assistant rows by every identity key (primary id + merged
  // aliases) so a live row's id resolves to the row that folded it in.
  // Optimistic rows have client-minted ids the daemon hasn't echoed yet and
  // can't be the authoritative twin.
  const historyByKey = new Map<string, DisplayMessage>();
  for (const row of history) {
    if (row.role !== "assistant" || row.isOptimistic) continue;
    for (const key of messageIdentityKeys(row)) {
      if (!historyByKey.has(key)) historyByKey.set(key, row);
    }
  }
  if (historyByKey.size === 0) return live;

  if (!live.some((row) => isShadowedByHistory(row, historyByKey))) {
    return live;
  }
  return live.filter((row) => !isShadowedByHistory(row, historyByKey));
}
