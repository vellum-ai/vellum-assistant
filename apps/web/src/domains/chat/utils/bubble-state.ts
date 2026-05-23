/**
 * Helpers for deciding whether the next stream event should append to the
 * latest assistant bubble or open a fresh one.
 *
 * The flag we drive is `needsNewBubbleRef` in `chat-page.tsx`. Background
 * history reconciliation can clear `isStreaming` on a row that still has
 * running tool calls (the server snapshot pre-dates the in-flight tool),
 * so `isStreaming` alone is not a reliable "turn ended" signal.
 *
 * A turn is still in flight while ANY of the following is true on the last
 * assistant bubble:
 *   - `isStreaming` is set
 *   - There is at least one tool call with status `"running"`
 *
 * Treating "running tool call" as an active-turn signal prevents
 * `tool_use_start` from spawning a duplicate `assistant-tool-*` row after
 * the current message's timestamp footer.
 */

import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";

/**
 * Does the message represent an assistant bubble whose turn is still in
 * flight? Used by `syncNeedsNewBubbleFromMessages` and any other code path
 * that needs to decide whether to consolidate or split.
 */
export function assistantBubbleIsActive(
  message: DisplayMessage | undefined,
): boolean {
  if (!message || message.role !== "assistant") return false;
  if (message.isStreaming) return true;
  return !!message.toolCalls?.some((tc) => tc.status === "running");
}

/**
 * Compute the new value for `needsNewBubbleRef` after a messages-state
 * update. We need a fresh bubble whenever the last row is NOT an active
 * assistant bubble.
 */
export function computeNeedsNewBubble(
  nextMessages: DisplayMessage[],
): boolean {
  const lastMsg = nextMessages[nextMessages.length - 1];
  return !assistantBubbleIsActive(lastMsg);
}
