import type { DisplayMessage } from "@/domains/chat/lib/types.js";

/**
 * Stable in-place sort by timestamp.  Only messages that have a timestamp
 * participate in the sort; messages without a timestamp stay at their
 * original array position.  This two-pass approach avoids the non-transitive
 * comparator problem that arises when mixing timestamped and non-timestamped
 * elements in a single sort pass.
 */
export function sortByTimestamp(messages: DisplayMessage[]): void {
  // Collect the slot positions (indices) and the messages that have timestamps.
  const slots: number[] = [];
  const withTs: Array<{ origIdx: number; m: DisplayMessage }> = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.timestamp != null) {
      slots.push(i);
      withTs.push({ origIdx: i, m: messages[i]! });
    }
  }
  if (withTs.length < 2) {
    return;
  }

  // Sort the timestamped subset chronologically (stable — equal timestamps
  // preserve their original relative order via the origIdx tiebreaker).
  withTs.sort((a, b) => a.m.timestamp! - b.m.timestamp! || a.origIdx - b.origIdx);

  // Write the sorted messages back into the slots that had timestamps,
  // leaving non-timestamped messages untouched at their original positions.
  for (let i = 0; i < slots.length; i++) {
    messages[slots[i]!] = withTs[i]!.m;
  }
}

export function sortedByTimestamp(messages: DisplayMessage[]): DisplayMessage[] {
  const sorted = [...messages];
  sortByTimestamp(sorted);
  return sorted;
}

export function timestampToMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
