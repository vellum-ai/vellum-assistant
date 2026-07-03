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

import { DEFAULT_TOOL_EXECUTION_TIMEOUT_SEC } from "@vellumai/assistant-api";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";
import { mapMessageToolCalls } from "@/domains/chat/utils/map-message-tool-calls";
import type { DisplayMessage } from "@/domains/chat/types/types";

export function sanitizeDisplayMessages(
  messages: DisplayMessage[],
): DisplayMessage[] {
  const pipeline = [
    removeInvalidMessages,
    removeDuplicateTrailingAssistant,
    repairDanglingToolCalls,
    failStaleToolCalls,
  ];
  return pipeline.reduce((msgs, step) => step(msgs), messages);
}

// -----------------------------------------------------------------------------
// Drop blank / phantom user rows
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
  // Assistant rows always render; queued user rows render in the queue drawer.
  if (message.role !== "user") return false;
  if (message.queueStatus === "queued") return false;

  // Any meaningful signal short-circuits as valid. Without one of these the
  // row is a blank bubble (e.g. an orphan tool_result at a pagination boundary
  // that the daemon's renderer already stripped).
  if (message.textSegments?.some((s) => s.trim().length > 0)) return false;
  if (message.surfaces && message.surfaces.length > 0) return false;
  if (message.attachments && message.attachments.length > 0) return false;
  if (message.slackMessage) return false;
  if (message.toolCalls?.some((tc) => tc.name !== "unknown")) return false;

  return true;
}

// -----------------------------------------------------------------------------
// Hack #3 — drop a duplicate trailing assistant message
// -----------------------------------------------------------------------------
// Why it exists: occasionally the daemon emits two rows for what is logically
// the same assistant turn — one with a server-assigned `id`, followed
// immediately by a sibling row whose `id` is a different value (either another
// server id or a client-synthesized optimistic id). Dedupe-by-id misses this
// case because the ids differ between the rows. Without this filter the UI
// renders the final assistant message twice (and
// `window._vellumDebug.chat.getClientMessages()` returns it twice).
//
// Predicate (must ALL hold to filter):
//   - the last two messages are both `role: "assistant"`,
//   - the trailing row has SOMETHING substantive to render — at least one of
//     `textSegments`/`toolCalls` is non-empty. Guards against accidentally
//     dropping two empty placeholders that happen to be sequentially equal,
//   - their `textSegments` arrays match position-for-position,
//   - their `toolCalls` arrays match position-for-position on `name` and
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
    if (aSegs[i] !== bSegs[i]) return false;
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
    if (aTc.name !== bTc.name) return false;
    if (aTc.result !== bTc.result) return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Hack #4 — repair dangling tool calls on older assistant messages
// -----------------------------------------------------------------------------
// Why it exists: occasionally a `tool_result` SSE event is lost between the
// daemon and the client (network drop, reconnect race, server-side fanout
// glitch). The tool call stays `status: "running"` forever in the client's
// `DisplayMessage[]`, even though the assistant clearly continued — there
// is a subsequent assistant message in the transcript, which is only
// possible if the LLM provider received the tool result on the server side.
//
// The render layer shows these stuck calls as a permanent spinner on an
// older message bubble, which is misleading: the tool DID complete, the
// client just never saw the result.
//
// Predicate (must ALL hold for a tool call to be patched):
//   - its parent message is `role: "assistant"`,
//   - the parent message is NOT the last assistant in the transcript (the
//     last assistant may still be streaming; its dangling tools could
//     legitimately resolve via an in-flight `tool_result`),
//   - `isToolCallRunning(tool_call)` (the UI's canonical "no result yet"
//     signal — see `tool-call-chip.tsx`'s `isRunning`).
// When all three hold, mutate the tool call to set `isError: true` (so the
// derived status becomes `"error"`) plus a synthetic result:
//   - `result: SYNTHETIC_DANGLING_RESULT` (explains the client-side data loss
//     so a feedback report shows the root cause, not a vague tool failure).
//
// Pipeline placement: runs AFTER `removeDuplicateTrailingAssistant` so the
// dedup filter's pairwise `result` equality check sees the original (still
// undefined) values and can correctly identify the duplicate. If both
// duplicate trailing assistants carry the same dangling tools, dedup drops
// one and the remaining one becomes the last assistant — at which point this
// step conservatively skips it.
//
// SHORT TERM until: the assistant backend reliably delivers `tool_result`
// SSE events (or the reconcile pass closes the gap by treating dangling
// tools as authoritative client-side state to repair against /v1/history).
// -----------------------------------------------------------------------------
const SYNTHETIC_DANGLING_RESULT =
  "Tool call completed on the server, but the result never reached the client. Subsequent assistant activity confirms the tool returned — this is a client-side data loss, not a tool failure.";

function repairDanglingToolCalls(
  messages: DisplayMessage[],
): DisplayMessage[] {
  const lastAssistantIdx = findLastAssistantIndex(messages);
  // No subsequent-assistant evidence anywhere → nothing to repair against.
  if (lastAssistantIdx <= 0) return messages;

  let result: DisplayMessage[] | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const isPatchable =
      m.role === "assistant" &&
      i < lastAssistantIdx &&
      hasDanglingToolCall(m);
    if (!isPatchable) {
      if (result) result.push(m);
      continue;
    }
    if (!result) result = messages.slice(0, i);
    result.push(withRepairedToolCalls(m));
  }
  return result ?? messages;
}

function findLastAssistantIndex(messages: DisplayMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") return i;
  }
  return -1;
}

function hasDanglingToolCall(message: DisplayMessage): boolean {
  return (
    message.toolCalls?.some((tc) => isToolCallRunning(tc)) ?? false
  );
}

function withRepairedToolCalls(message: DisplayMessage): DisplayMessage {
  return mapMessageToolCalls(message, repairIfDangling);
}

function repairIfDangling(tc: ChatMessageToolCall): ChatMessageToolCall {
  if (!isToolCallRunning(tc)) {
    return tc;
  }
  return {
    ...tc,
    isError: true,
    result: SYNTHETIC_DANGLING_RESULT,
  };
}

// -----------------------------------------------------------------------------
// Hack #5 — fail stale tool calls on assistant restart / silent daemon death
// -----------------------------------------------------------------------------
// Why it exists: when the assistant daemon restarts (or crashes silently)
// mid-tool-execution, it never delivers the `tool_result` SSE for the call
// it was running. Unlike Hack #4 — which patches dangling tools that have a
// SUBSEQUENT assistant message proving the tool completed server-side —
// this case has no subsequent activity at all. The bubble where the tool
// started simply spins forever, even across page reloads.
//
// This step is the client-side last line of defense. It applies whenever
// the elapsed time since the tool's last sign of life exceeds the
// configured execution timeout (plus a small grace buffer to absorb
// daemon-side delivery delay).
//
// Predicate (must ALL hold for a tool call to be patched):
//   - `isToolCallRunning(tool_call)` (the UI's canonical "no result yet"
//     signal — see `tool-call-chip.tsx`'s `isRunning`),
//   - `tool_call.startedAt` is set (else we have no clock to measure
//     against; typically only happens for tool calls hydrated from a
//     pre-stamping history boundary),
//   - `tool_call.pendingConfirmation` is null/undefined (a tool waiting on
//     user approval is correctly stalled and must not be marked stale —
//     the daemon's own execution timeout doesn't start until approval
//     lands),
//   - `now - startedAt > DEFAULT_TOOL_EXECUTION_TIMEOUT_MS + STALE_GRACE_MS`.
//
// The timeout uses `DEFAULT_TOOL_EXECUTION_TIMEOUT_SEC` (the canonical
// default the daemon uses when no override is configured), exported from
// `@vellumai/assistant-api` so backend enforcement and frontend detection
// reference the same wire-contract default — drift between them would let
// stale tools spin past the server-side ceiling, or worse, fail tools the
// server still considers in-flight.
//
// When all four hold, mutate the tool call to:
//   - `isError: true` (so the derived status becomes `"error"`),
//   - `result: SYNTHETIC_STALE_RESULT` (explains the client-side timeout
//     so a feedback report shows the root cause).
//
// Pipeline placement: runs AFTER `repairDanglingToolCalls`. Hack #4 has
// the stricter evidence (a later assistant message proves the server
// continued past the tool); whatever it leaves still-running gets
// evaluated against the timeout here. The two synthetic messages stay
// distinct on purpose — Hack #4 says "the server continued without us",
// Hack #5 says "we gave up waiting".
//
// SHORT TERM until: the assistant runtime survives restarts cleanly,
// either by persisting an "in-flight tool" record so the new process
// can emit a synthetic `tool_result` on boot, or by the gateway / host
// proxy buffering `tool_result` events across a daemon restart.
// -----------------------------------------------------------------------------
const SYNTHETIC_STALE_RESULT =
  "Tool call exceeded the execution timeout with no result. The assistant may have restarted while the tool was in flight — this is a client-side timeout, not a tool failure.";

/**
 * Grace period added on top of the configured execution timeout before a
 * still-running tool call is treated as stale. Absorbs the daemon-side
 * lag between hitting its own timeout (which produces a synthetic error
 * tool_result) and that result actually crossing the SSE wire. Generous
 * on purpose: false positives — marking a still-running tool as failed
 * — are worse than a few seconds of extra spinner.
 */
const STALE_GRACE_MS = 30_000;

function failStaleToolCalls(messages: DisplayMessage[]): DisplayMessage[] {
  // Read the wall clock once at the top of this step so every tool
  // call in this pass is evaluated against the same instant. Tests
  // mock `Date.now` via `spyOn(Date, "now")` for deterministic
  // stale-detection windows.
  const nowMs = Date.now();
  let result: DisplayMessage[] | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !hasStaleToolCall(m, nowMs)) {
      if (result) result.push(m);
      continue;
    }
    if (!result) result = messages.slice(0, i);
    result.push(withStaleToolCallsFailed(m, nowMs));
  }
  return result ?? messages;
}

function hasStaleToolCall(message: DisplayMessage, nowMs: number): boolean {
  return message.toolCalls?.some((tc) => isStale(tc, nowMs)) ?? false;
}

function withStaleToolCallsFailed(
  message: DisplayMessage,
  nowMs: number,
): DisplayMessage {
  return mapMessageToolCalls(message, (tc) =>
    isStale(tc, nowMs) ? markStale(tc) : tc,
  );
}

function isStale(tc: ChatMessageToolCall, nowMs: number): boolean {
  if (!isToolCallRunning(tc)) {
    return false;
  }
  if (tc.pendingConfirmation) {
    return false;
  }
  if (tc.startedAt === undefined) return false;
  const effectiveTimeoutMs = DEFAULT_TOOL_EXECUTION_TIMEOUT_SEC * 1000;
  return nowMs - tc.startedAt > effectiveTimeoutMs + STALE_GRACE_MS;
}

function markStale(tc: ChatMessageToolCall): ChatMessageToolCall {
  return {
    ...tc,
    isError: true,
    result: SYNTHETIC_STALE_RESULT,
  };
}
