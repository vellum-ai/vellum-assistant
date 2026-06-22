/**
 * Entity-level stream updaters: `(MessageEntityState, …) => MessageEntityState`.
 *
 * These route a streaming event to its target row in the normalized store and
 * apply a row-level transform via `patch` — so a per-token delta touches one
 * entity (O(1)) instead of replacing the whole array. The row-level transforms
 * themselves are the same ones the legacy array updaters use
 * (`appendTextSegmentToRow`, …), lifted unchanged; only the routing + storage
 * differ. They also maintain the `liveAssistantRowKey` pointer the way the old
 * `currentAssistantMessageIdRef` mirror did, but synchronously in the store.
 */

import {
  type MessageEntityState,
  appendRow,
  deriveRowKey,
  patch,
  rowKeyForServerId,
  setLiveAssistantRowKey,
} from "@/domains/chat/utils/message-entities";
import {
  appendTextSegmentToRow,
  appendThinkingSegmentToRow,
  newAssistantTextBubble,
  newAssistantThinkingBubble,
} from "@/domains/chat/utils/stream-updaters/message-updaters";

/** The tail row's rowKey when it is an assistant row, else `undefined`. */
function assistantTailRowKey(state: MessageEntityState): string | undefined {
  const key = state.order[state.order.length - 1];
  return key !== undefined && state.byId[key]?.role === "assistant" ? key : undefined;
}

/** The assistant row owning `messageId` (primary id or merged alias), if any. */
function ownerAssistantRowKey(
  state: MessageEntityState,
  messageId: string,
): string | undefined {
  const key = rowKeyForServerId(state, messageId);
  return key !== undefined && state.byId[key]?.role === "assistant" ? key : undefined;
}

/**
 * Resolve the assistant row a streaming delta targets, mirroring the array
 * updaters' decision: the row that owns `messageId` (any position) → else the
 * assistant tail (a later LLM call in the same turn folds in as an alias) →
 * else `undefined` (open a fresh bubble). With no `messageId`, tail-only.
 */
function resolveDeltaTarget(
  state: MessageEntityState,
  messageId: string | undefined,
): string | undefined {
  if (messageId !== undefined) {
    return ownerAssistantRowKey(state, messageId) ?? assistantTailRowKey(state);
  }
  return assistantTailRowKey(state);
}

/** Apply an `assistant_text_delta`. */
export function applyTextDelta(
  state: MessageEntityState,
  text: string,
  messageId?: string,
): MessageEntityState {
  const target = resolveDeltaTarget(state, messageId);
  if (target !== undefined) {
    const next = patch(state, target, (row) =>
      appendTextSegmentToRow(row, text, messageId),
    );
    return setLiveAssistantRowKey(next, target);
  }
  const bubble = newAssistantTextBubble(text, messageId);
  return setLiveAssistantRowKey(appendRow(state, bubble), deriveRowKey(bubble));
}

/** Apply an `assistant_thinking_delta`. */
export function applyThinkingDelta(
  state: MessageEntityState,
  thinking: string,
  messageId?: string,
): MessageEntityState {
  const target = resolveDeltaTarget(state, messageId);
  if (target !== undefined) {
    const next = patch(state, target, (row) =>
      appendThinkingSegmentToRow(row, thinking, messageId),
    );
    return setLiveAssistantRowKey(next, target);
  }
  const bubble = newAssistantThinkingBubble(thinking, messageId);
  return setLiveAssistantRowKey(appendRow(state, bubble), deriveRowKey(bubble));
}
