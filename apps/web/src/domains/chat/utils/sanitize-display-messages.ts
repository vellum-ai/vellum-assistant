// -----------------------------------------------------------------------------
// sanitizeDisplayMessages — single home for "this shouldn't be necessary,
// but is" frontend cleanup applied to DisplayMessage[] before the transcript
// renders.
//
// Every sub-method below patches over an upstream issue. They are SHORT TERM
// and should be removed as the assistant backend stabilises the corresponding
// emission behaviour. Keeping them all in one file means we only have to look
// in one place when a render-layer "why am I seeing X" report lands, and we
// only have to delete one file when the backend is fixed.
// -----------------------------------------------------------------------------

import { sortedByTimestamp } from "@/domains/chat/utils/message-sorting.js";
import type { DisplayMessage } from "@/domains/chat/types/types.js";

export function sanitizeDisplayMessages(
  messages: DisplayMessage[],
): DisplayMessage[] {
  const pipeline = [
    sortByTimestamp,
    removeInvalidMessages,
    removeDuplicateTrailingAssistant,
  ];
  return pipeline.reduce((msgs, step) => step(msgs), messages);
}

// -----------------------------------------------------------------------------
// Hack #1 — defensive ascending-timestamp sort at the render boundary
// -----------------------------------------------------------------------------
// Why it exists: the internal mutators (stream handlers, reconcile, message
// merge, etc.) try to keep `messages` sorted, but several paths can land
// rows out of order:
//   - multi-row server clusters that share the same `daemonMessageId`,
//   - late `tool_result` events for an earlier bubble,
//   - history pages stitched around an in-flight stream.
// Sorting here guarantees the user always sees messages in chronological
// order regardless of which write path landed last.
//
// `sortedByTimestamp` is stable: rows without a `timestamp` keep their
// original slot, and equal timestamps preserve insertion order — so
// streaming bubbles don't flicker.
//
// SHORT TERM until: the assistant backend merges multi-row clusters
// server-side so the client never sees the fragmented rows.
// -----------------------------------------------------------------------------
function sortByTimestamp(messages: DisplayMessage[]): DisplayMessage[] {
  // Thin wrapper around `sortedByTimestamp` so this file owns all three
  // pipeline steps locally. `sortedByTimestamp` is still consumed by
  // `reconcile.ts`; when that cleanup lands and reconcile is deleted, the
  // import can collapse without touching the pipeline shape.
  return sortedByTimestamp(messages);
}

// -----------------------------------------------------------------------------
// Hack #2 — drop blank / phantom user rows
// -----------------------------------------------------------------------------
// Why it exists: two upstream emission patterns leave us with user rows that
// have nothing to render:
//   - At a history-pagination boundary the runtime keeps `tool_result`-only
//     user rows even when their parent `tool_use` lives on a previous page
//     (to avoid permanent data loss). The daemon's renderer then drops the
//     orphan `tool_result` block, leaving a blank user bubble on the wire.
//   - The assistant synthesises tool calls with `toolName === "unknown"` when a
//     `tool_result` has no matching `tool_use`. Those arrive as empty user
//     messages whose only payload is a list of "unknown" tools and would
//     otherwise render as a confusing "Used unknown" chip.
//
// SHORT TERM until: the assistant stops emitting orphan `tool_result` rows and
// phantom unknown-tool placeholders at history boundaries.
// -----------------------------------------------------------------------------
function removeInvalidMessages(messages: DisplayMessage[]): DisplayMessage[] {
  let result: DisplayMessage[] | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (isInvalidMessage(m)) {
      if (!result) result = messages.slice(0, i);
      continue;
    }
    if (result) result.push(m);
  }
  return result ?? messages;
}

function isInvalidMessage(message: DisplayMessage): boolean {
  // Assistant rows always render; queued user rows collapse into a marker upstream.
  if (message.role !== "user") return false;
  if (message.queueStatus === "queued") return false;

  // Any meaningful signal short-circuits as valid. Without one of these the
  // row is a blank bubble (e.g. an orphan tool_result at a pagination boundary
  // that the daemon's renderer already stripped).
  if (message.content && message.content.trim().length > 0) return false;
  if (
    message.textSegments?.some(
      (s) => typeof s.content === "string" && s.content.trim().length > 0,
    )
  )
    return false;
  if (message.surfaces && message.surfaces.length > 0) return false;
  if (message.attachments && message.attachments.length > 0) return false;
  if (message.slackMessage) return false;
  if (message.toolCalls?.some((tc) => tc.toolName !== "unknown")) return false;

  return true;
}

// -----------------------------------------------------------------------------
// Hack #3 — drop a duplicate trailing assistant message
// -----------------------------------------------------------------------------
// Why it exists: occasionally the daemon emits two rows for what is logically
// the same assistant turn — one with a server-assigned `id` and a `stableId`
// of the form "server-…", followed immediately by a sibling row with `id`
// undefined and a `stableId` of the form "assistant-…". The existing dedupe
// keys (`id` and `stableId`) both miss this case because both fields differ
// between the rows. Without this filter the UI renders the final assistant
// message twice (and `window._vellumDebug.chat.getClientMessages()` returns it twice).
//
// Predicate (must ALL hold to filter):
//   - the last two messages are both `role: "assistant"`,
//   - the trailing row has SOMETHING substantive to render — at least one of
//     `textSegments`/`toolCalls` is non-empty. Guards against accidentally
//     dropping two empty placeholders that happen to be sequentially equal,
//   - their `textSegments` arrays match position-for-position on `type` and
//     `content`,
//   - their `toolCalls` arrays match position-for-position on `toolName` and
//     `result`.
// When all four hold, drop the trailing row.
//
// SHORT TERM until: the assistant backend root-causes the duplicate emission
// (a parallel investigation owns the deeper fix).
// -----------------------------------------------------------------------------
function removeDuplicateTrailingAssistant(
  messages: DisplayMessage[],
): DisplayMessage[] {
  if (messages.length < 2) return messages;

  const last = messages[messages.length - 1]!;
  const prev = messages[messages.length - 2]!;

  if (last.role !== "assistant" || prev.role !== "assistant") return messages;
  if (!hasSubstantiveContent(last)) return messages;
  if (!textSegmentsMatch(prev, last)) return messages;
  if (!toolCallsMatch(prev, last)) return messages;

  return messages.slice(0, -1);
}

function hasSubstantiveContent(message: DisplayMessage): boolean {
  if (message.textSegments && message.textSegments.length > 0) return true;
  if (message.toolCalls && message.toolCalls.length > 0) return true;
  return false;
}

function textSegmentsMatch(a: DisplayMessage, b: DisplayMessage): boolean {
  const aSegs = a.textSegments ?? [];
  const bSegs = b.textSegments ?? [];
  if (aSegs.length !== bSegs.length) return false;
  for (let i = 0; i < aSegs.length; i++) {
    const aSeg = aSegs[i]!;
    const bSeg = bSegs[i]!;
    if (aSeg.type !== bSeg.type) return false;
    if (aSeg.content !== bSeg.content) return false;
  }
  return true;
}

function toolCallsMatch(a: DisplayMessage, b: DisplayMessage): boolean {
  const aTcs = a.toolCalls ?? [];
  const bTcs = b.toolCalls ?? [];
  if (aTcs.length !== bTcs.length) return false;
  for (let i = 0; i < aTcs.length; i++) {
    const aTc = aTcs[i]!;
    const bTc = bTcs[i]!;
    if (aTc.toolName !== bTc.toolName) return false;
    if (aTc.result !== bTc.result) return false;
  }
  return true;
}
