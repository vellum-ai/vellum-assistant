// Derive the rendered transcript as the union of two independently-owned
// sources: server history (the TanStack Query cache) and the client-owned
// in-flight turn (the chat-session store). History is never mutated
// client-side — the live turn overlays it.
//
// A live row replaces the history row it shares an identity with (server id,
// a merged alias, or the client-minted `clientMessageId` nonce the daemon
// echoes back on the persisted row): it keeps history's position and wins on
// content, because the live copy carries the freshest streamed text and the
// blob-URL attachments the user is viewing. A live row with no history twin —
// a fresh optimistic send, a still-streaming bubble — is appended after
// history in live order.
//
// One exception breaks "live wins on content": a *prefix-less re-attach*
// bubble. When a tab reconnects mid-turn, the daemon replays the in-flight
// LLM call's deltas under that call's own `messageId` — but the persisted
// turn row carries an *earlier* call's id as its primary, with the replayed
// id folded in as a merged alias. If the first replayed delta beats the
// initial history fetch, the live bubble opens with no history twin to seed
// from (see `resolveHistoryTwin`), so it holds only the post-reconnect suffix
// and knows nothing of the persisted prefix. The overlay then matches it to
// the rich history row *via that history-side alias* and, under the plain
// "live wins" rule, the content-poor live bubble would shadow the full
// answer — the bug where a complete reply collapses to a bare "thinking…"
// bubble on refresh. We detect this exact shape — the live row was matched
// only because history lists its id, while the live row itself carries no
// knowledge of history's primary id — and fold history⊕live instead, so the
// persisted prefix survives and the live suffix extends it. A live row that
// *does* carry history's id among its own keys (the normal seeded / merged
// case) still wins outright.
//
// Order is structural: server-history order, then the live turn (always the
// newest). There is deliberately no timestamp sort — history rows are stamped
// by the server clock and live rows by the client clock, so ordering them by
// timestamp together would interleave the two clocks and scramble the
// transcript.

import { messageMatchKeys } from "@/domains/chat/utils/message-identity";
import {
  canFoldAdjacentAssistant,
  foldAdjacentAssistant,
} from "@/domains/chat/utils/message-merge";
import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * A live row is a *prefix-less re-attach* bubble relative to the history row
 * it matched when: both are assistant rows, the match was made only through a
 * history-side alias (the live row's own identity keys do not include
 * history's primary id), and the two are foldable. In that shape the live row
 * is the replayed suffix of a turn whose persisted prefix lives in the
 * history row — so its content must extend history's, not replace it.
 *
 * The normal seeded / client-merged case (the live row carries history's id as
 * its own id or merged alias) returns false here, preserving "live wins".
 */
function isPrefixlessReattach(
  historyRow: DisplayMessage,
  liveRow: DisplayMessage,
): boolean {
  return (
    historyRow.role === "assistant" &&
    liveRow.role === "assistant" &&
    !messageMatchKeys(liveRow).includes(historyRow.id) &&
    canFoldAdjacentAssistant(historyRow, liveRow)
  );
}

/**
 * Merge cached server history with the client-owned in-flight turn into the
 * flat `DisplayMessage[]` the transcript renders. Returns the `history`
 * reference unchanged when there is no live turn, so the steady-state render
 * stays referentially stable.
 */
export function selectTranscriptMessages(
  history: DisplayMessage[],
  live: DisplayMessage[],
): DisplayMessage[] {
  if (live.length === 0) {
    return history;
  }

  const liveByKey = new Map<string, DisplayMessage>();
  for (const row of live) {
    for (const key of messageMatchKeys(row)) {
      if (!liveByKey.has(key)) {
        liveByKey.set(key, row);
      }
    }
  }

  const merged: DisplayMessage[] = [];
  const placed = new Set<DisplayMessage>();

  for (const historyRow of history) {
    let liveRow: DisplayMessage | undefined;
    for (const key of messageMatchKeys(historyRow)) {
      const found = liveByKey.get(key);
      if (found) {
        liveRow = found;
        break;
      }
    }
    if (liveRow) {
      // Live copy wins, in history's position. A second history row resolving
      // to the same live row is a collapsed cluster the live turn owns — drop
      // it rather than render the row twice.
      if (!placed.has(liveRow)) {
        // Prefix-less re-attach: the live row is the replayed suffix of a turn
        // whose persisted prefix sits in this history row. Fold so the prefix
        // survives instead of letting the suffix-only row shadow it.
        merged.push(
          isPrefixlessReattach(historyRow, liveRow)
            ? foldAdjacentAssistant(historyRow, liveRow)
            : liveRow,
        );
        placed.add(liveRow);
      }
      continue;
    }
    merged.push(historyRow);
  }

  for (const row of live) {
    if (!placed.has(row)) {
      merged.push(row);
    }
  }

  return merged;
}
