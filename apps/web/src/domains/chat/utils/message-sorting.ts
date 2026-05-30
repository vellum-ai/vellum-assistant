import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * Returns the most recent activity timestamp inside a message — the max
 * across the top-level `timestamp` and every tool call's
 * `startedAt` / `completedAt`.
 *
 * Used as a tiebreaker when two messages share the same top-level
 * `timestamp`. This happens when the daemon emits a multi-row server
 * cluster (one assistant turn that wrote ≥2 DB rows) with the same wall
 * clock — the cluster's individual rows are indistinguishable at the
 * top level, but the tool calls inside them did happen in order, so the
 * per-tool-call timestamps recover the right ordering.
 */
function lastContentPartTimestamp(m: DisplayMessage): number | undefined {
  let max = m.timestamp;
  const toolCalls = m.toolCalls;
  if (toolCalls) {
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      const candidates: Array<number | undefined> = [
        tc.startedAt,
        tc.completedAt,
      ];
      for (const ts of candidates) {
        if (ts != null && (max == null || ts > max)) {
          max = ts;
        }
      }
    }
  }
  return max;
}

/**
 * Stable in-place sort by timestamp.  Only messages that have a timestamp
 * participate in the sort; messages without a timestamp stay at their
 * original array position.  This two-pass approach avoids the non-transitive
 * comparator problem that arises when mixing timestamped and non-timestamped
 * elements in a single sort pass.
 *
 * When two messages share the same top-level `timestamp`, falls back to the
 * latest tool-call activity timestamp inside each message — see
 * `lastContentPartTimestamp` for the rationale. This matters for the
 * multi-row server-cluster case (one assistant turn that wrote ≥2 DB rows
 * with the same `timestamp`), where the user-facing order is determined
 * by *when the tool calls actually ran*, not by array order.
 */
export function sortByTimestamp(messages: DisplayMessage[]): void {
  // Collect the slot positions (indices) and the messages that have timestamps.
  const slots: number[] = [];
  const withTs: Array<{ origIdx: number; m: DisplayMessage; effectiveTs: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.timestamp != null) {
      slots.push(i);
      // Precompute once per message so the comparator stays O(1).
      const effectiveTs = lastContentPartTimestamp(m) ?? m.timestamp;
      withTs.push({ origIdx: i, m, effectiveTs });
    }
  }
  if (withTs.length < 2) {
    return;
  }

  // Sort the timestamped subset chronologically. Primary key: top-level
  // `timestamp`. Secondary key: latest content-part timestamp (recovers
  // intra-cluster order for same-timestamp rows). Final tiebreaker:
  // original insertion order (keeps the sort stable for genuinely-equal
  // messages so streaming bubbles don't flicker).
  withTs.sort(
    (a, b) =>
      a.m.timestamp! - b.m.timestamp! ||
      a.effectiveTs - b.effectiveTs ||
      a.origIdx - b.origIdx,
  );

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
