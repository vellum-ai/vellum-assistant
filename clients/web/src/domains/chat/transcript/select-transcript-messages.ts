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
// Order is structural: server-history order, then the live turn (always the
// newest). There is deliberately no timestamp sort — history rows are stamped
// by the server clock and live rows by the client clock, so ordering them by
// timestamp together would interleave the two clocks and scramble the
// transcript.

import { messageMatchKeys } from "@/domains/chat/utils/message-identity";
import type { DisplayMessage } from "@/domains/chat/types/types";

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
        merged.push(liveRow);
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
