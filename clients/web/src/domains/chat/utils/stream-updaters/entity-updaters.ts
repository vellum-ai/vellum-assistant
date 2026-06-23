/**
 * Entity-level stream updaters: `(MessageEntityState, …) => MessageEntityState`.
 *
 * These route a streaming event to its target row in the normalized store and
 * apply a row-level transform via `patch` — so a per-token delta touches one
 * entity (O(1)) instead of replacing the whole array. The transforms call the
 * shared row helpers (`appendTextSegmentToRow`, …); this module owns the
 * routing and storage around them. They maintain `liveAssistantRowKey`
 * synchronously in the store so subagent attribution can resolve the live
 * assistant row.
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
import { finalizeRunningToolCalls } from "@/domains/chat/utils/stream-updaters/shared";
import { toDisplayAttachments } from "@/utils/display-attachments";
import type { MessageCompleteEvent } from "@vellumai/assistant-api";

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

// ---------------------------------------------------------------------------
// assistant_activity_state (idle)
// ---------------------------------------------------------------------------

/** Finalize any running tool calls across all assistant rows on turn-idle. */
export function finalizeOnIdle(state: MessageEntityState): MessageEntityState {
  let next = state;
  for (const rowKey of state.order) {
    const row = next.byId[rowKey];
    if (row?.role !== "assistant") continue;
    const finalized = finalizeRunningToolCalls(row);
    if (finalized) {
      next = patch(next, rowKey, (r) => ({ ...r, ...finalized }));
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// message_complete
// ---------------------------------------------------------------------------

/**
 * Finalize the live assistant turn on `message_complete`: complete running
 * tool calls, merge attachments, and adopt the server `messageId` on an
 * optimistic row. The adopt is an in-place `patch` — `rowKey` is unchanged, so
 * the row does NOT remount at completion (the array path re-derived the key
 * from the swapped id and could not give this).
 */
export function applyMessageComplete(
  state: MessageEntityState,
  event: MessageCompleteEvent,
): MessageEntityState {
  const tailKey = assistantTailRowKey(state);
  const attachments = toDisplayAttachments(event.attachments);

  if (tailKey === undefined) {
    // No assistant tail (tool-only / aux turn): push a finalized bubble only
    // when there are attachments to carry.
    if (!attachments) return state;
    return appendRow(state, {
      id: event.messageId ?? crypto.randomUUID(),
      ...(event.messageId ? {} : { isOptimistic: true }),
      role: "assistant",
      timestamp: Date.now(),
      attachments,
    });
  }

  return patch(state, tailKey, (row) => {
    const finalized = finalizeRunningToolCalls(row);
    const adoptServerId = row.isOptimistic === true && !!event.messageId;
    return {
      ...row,
      ...(adoptServerId ? { id: event.messageId!, isOptimistic: false } : {}),
      ...(attachments ? { attachments } : {}),
      ...(finalized ?? {}),
    };
  });
}

// ---------------------------------------------------------------------------
// user_message_echo
// ---------------------------------------------------------------------------

/** The rowKey of the optimistic user row this echo confirms, if any. */
function optimisticUserRowKey(
  state: MessageEntityState,
  clientMessageId: string | undefined,
): string | undefined {
  // User-originated rows are keyed by their `clientMessageId`, so the nonce is
  // a direct lookup.
  if (clientMessageId !== undefined) {
    return state.byId[clientMessageId]?.role === "user"
      ? clientMessageId
      : undefined;
  }
  // No nonce (pre-idempotency daemon / synthetic echo): the most recent
  // still-optimistic user row.
  for (let i = state.order.length - 1; i >= 0; i--) {
    const key = state.order[i]!;
    const row = state.byId[key];
    if (row?.role === "user" && row.isOptimistic === true) return key;
  }
  return undefined;
}

/** Apply a `user_message_echo`: dedupe, swap an optimistic row's id, or append. */
export function applyUserMessageEcho(
  state: MessageEntityState,
  event: { text: string; messageId?: string; clientMessageId?: string },
): MessageEntityState {
  const serverId = event.messageId;

  // Already rendered (the originating client's POST resolved, or a prior echo /
  // reconcile pulled the row in).
  if (serverId !== undefined) {
    const ownerKey = rowKeyForServerId(state, serverId);
    if (ownerKey !== undefined && state.byId[ownerKey]?.role === "user") {
      return state;
    }
  }

  const targetKey = optimisticUserRowKey(state, event.clientMessageId);
  if (targetKey !== undefined) {
    // Synthetic echo with no server id to upgrade to — leave the row as-is.
    if (serverId === undefined) return state;
    return patch(state, targetKey, (row) => ({
      ...row,
      id: serverId,
      isOptimistic: false,
    }));
  }

  // Passive viewer / synthetic prompt: render the user turn.
  return appendRow(state, {
    id: serverId ?? crypto.randomUUID(),
    ...(serverId === undefined ? { isOptimistic: true } : {}),
    role: "user",
    textSegments: [event.text],
    contentOrder: [{ type: "text", id: "0" }],
    contentBlocks: [{ type: "text", text: event.text }],
    timestamp: Date.now(),
  });
}
