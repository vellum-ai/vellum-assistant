/**
 * Shared helpers and array utilities for SSE stream message updaters.
 *
 * Helpers here are used across multiple updater modules (message, surface,
 * tool-call) and by external consumers (reconcile, ui-state hooks).
 * Queue updaters are generic message-array transforms with no SSE-event
 * coupling.
 */

import type { DisplayMessage } from "@/domains/chat/types/types";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";

// ---------------------------------------------------------------------------
// Row resolution
// ---------------------------------------------------------------------------

/** Whether the tail row is an assistant message. */
export function tailIsAssistant(prev: DisplayMessage[]): boolean {
  const last = prev[prev.length - 1];
  return !!last && last.role === "assistant";
}

/**
 * Identify the assistant row that is currently live (still streaming) for
 * the active conversation, or `null` when none is.
 *
 * The live row is the last assistant message when the conversation is
 * processing and that row trails the most recent user message. A brand-new
 * turn always begins with a user row; a turn with no user row (external
 * channels) has the assistant run as the tail. Trailing user rows still
 * waiting in the queue (`queueStatus: "queued"`) are skipped so a message
 * queued mid-turn doesn't sever the in-flight assistant from its live
 * status.
 *
 * Pure and position-based: this is the single source of truth for row
 * liveness, derived from message position and the conversation's
 * processing state rather than a per-row flag.
 */
export function liveAssistantRowId(
  messages: DisplayMessage[],
  isProcessing: boolean,
): string | null {
  if (!isProcessing) {
    return null;
  }

  let tailIdx = messages.length - 1;
  while (
    tailIdx >= 0 &&
    messages[tailIdx]!.role === "user" &&
    messages[tailIdx]!.queueStatus === "queued"
  ) {
    tailIdx--;
  }

  const tail = messages[tailIdx];
  if (!tail || tail.role !== "assistant") {
    return null;
  }
  return tail.id;
}

/**
 * Find the assistant row that owns `messageId` — by its primary `id` or by
 * a folded `mergedMessageIds` alias.
 *
 * The daemon reserves a fresh `messageId` per LLM call within a single
 * agent turn, and the backend's `mergeConsecutiveAssistantMessages`
 * collapses that run onto the first row's id, listing the later ids as
 * aliases. Matching on aliases — not just the primary id — lets a later
 * LLM call's deltas and tool calls fold into the same anchor instead of
 * opening a duplicate streaming bubble for an id the run already owns.
 */
export function findAssistantRowIndexByMessageId(
  prev: DisplayMessage[],
  messageId: string,
): number {
  return prev.findIndex(
    (m) =>
      m.role === "assistant" &&
      (m.id === messageId || !!m.mergedMessageIds?.includes(messageId)),
  );
}

/**
 * Record `messageId` as a `mergedMessageIds` alias on `row` when it isn't
 * already the row's primary id or a known alias. Mirrors the backend merge
 * so a subsequent reconcile / SSE lookup by that id resolves to this row.
 */
export function withMergedAlias(
  row: DisplayMessage,
  messageId: string | undefined,
): DisplayMessage {
  if (!messageId || row.id === messageId) return row;
  const existing = row.mergedMessageIds ?? [];
  if (existing.includes(messageId)) return row;
  return { ...row, mergedMessageIds: [...existing, messageId] };
}

/**
 * Force-complete every running tool call on a row by stamping `completedAt`,
 * in lockstep across the positional `toolCalls` array and the matching
 * `contentBlocks` `tool_use` entries so the row reads as completed from either
 * slice. With no `result`/`isError`, the timestamp alone reads as completed
 * (not running); reconcile later backfills the real result if it arrives.
 *
 * Returns the patched `toolCalls`/`contentBlocks` fields, or `null` when no
 * tool call was running, so callers can skip rewriting the row.
 */
export function finalizeRunningToolCalls(
  row: Pick<DisplayMessage, "toolCalls" | "contentBlocks">,
): Pick<DisplayMessage, "toolCalls" | "contentBlocks"> | null {
  if (!row.toolCalls?.some((tc) => isToolCallRunning(tc))) {
    return null;
  }
  const completedAt = Date.now();
  const toolCalls = row.toolCalls.map((tc) =>
    isToolCallRunning(tc) ? { ...tc, completedAt } : tc,
  );
  const contentBlocks = row.contentBlocks?.map((block) =>
    block.type === "tool_use" && isToolCallRunning(block.toolCall)
      ? { type: "tool_use" as const, toolCall: { ...block.toolCall, completedAt } }
      : block,
  );
  return { toolCalls, contentBlocks };
}

// ---------------------------------------------------------------------------
// Queue updaters
// ---------------------------------------------------------------------------

/** Set queue position on a message by id. */
export function setQueuePosition(
  prev: DisplayMessage[],
  id: string,
  position: number,
): DisplayMessage[] {
  return prev.map((m) => (m.id === id ? { ...m, queuePosition: position } : m));
}

/** Clear queue status on a message by id. */
export function clearQueueStatus(
  prev: DisplayMessage[],
  id: string,
): DisplayMessage[] {
  return prev.map((m) =>
    m.id === id
      ? { ...m, queueStatus: undefined, queuePosition: undefined }
      : m,
  );
}

/** Remove a queued message by id. */
export function removeQueuedMessage(
  prev: DisplayMessage[],
  id: string,
): DisplayMessage[] {
  return prev.filter((m) => m.id !== id);
}
