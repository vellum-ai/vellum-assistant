/**
 * Advances a conversation's materialized history — the `/messages` page shape
 * (`PaginatedHistoryResult`), with `messages` already projected to
 * `DisplayMessage[]` — by folding stream events into it. The fold is pure,
 * total, and idempotent by `seq`, so the same events produce the same history
 * whether applied live or rebuilt from a snapshot.
 */

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import type { AssistantEvent } from "@/types/event-types";
import {
  type Surface,
  classifySurfaceDisplay,
  type DisplayMessage,
} from "@/domains/chat/types/types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import {
  appendTextDelta,
  appendThinkingDelta,
  applyUserMessageEcho,
  finalizeMessageComplete,
  finalizeOnIdle,
  handleConversationError,
} from "@/domains/chat/utils/stream-updaters/message-updaters";
import {
  appendToolOutputChunk,
  applyToolResult,
  upsertToolCall,
} from "@/domains/chat/utils/stream-updaters/tool-call-updaters";
import {
  attachSurface,
  completeSurface,
  dismissSurface,
  updateSurfaceData,
} from "@/domains/chat/utils/stream-updaters/surface-updaters";

/** Parse the envelope's ISO `emittedAt` to epoch ms, the deterministic stamp
 *  for any row an event opens. Falls back to `seq` so a malformed/absent time
 *  still yields a stable, monotonic value. */
function emittedAtMs(emittedAt: string, seq: number | null | undefined): number {
  const parsed = Date.parse(emittedAt);
  return Number.isFinite(parsed) ? parsed : typeof seq === "number" ? seq : 0;
}

/**
 * Fold one event's effect into the message list, reusing the same updaters the
 * live path runs. Every row an event opens is stamped from `at` (no clock read
 * here), so a created row is identical live or on rebuild. Event types that
 * don't change message content return the list unchanged.
 */
export function appendEventToMessages(
  messages: DisplayMessage[],
  event: AssistantEvent,
  at: number,
): DisplayMessage[] {
  switch (event.type) {
    case "assistant_text_delta":
      return appendTextDelta(messages, event.text, event.messageId, undefined, at);
    case "assistant_thinking_delta":
      return appendThinkingDelta(
        messages,
        event.thinking,
        event.messageId,
        undefined,
        at,
      );
    case "message_complete":
      return finalizeMessageComplete(messages, event, at);
    case "user_message_echo":
      return applyUserMessageEcho(
        messages,
        {
          text: event.text,
          messageId: event.messageId,
          clientMessageId: event.clientMessageId,
        },
        at,
      );
    case "assistant_activity_state":
      // Only the terminal `idle` phase changes message content (it finalizes
      // running tool calls); other phases drive turn state, not history.
      return event.phase === "idle" ? finalizeOnIdle(messages, at) : messages;
    case "conversation_error":
      return handleConversationError(messages, at);
    case "tool_use_start": {
      const toolCall: ChatMessageToolCall = {
        id: event.toolUseId ?? `tool-${at}`,
        name: event.toolName,
        input: event.input,
        startedAt:
          "startedAt" in event && typeof event.startedAt === "number"
            ? event.startedAt
            : at,
      };
      return upsertToolCall(messages, toolCall, event.messageId, at);
    }
    case "tool_result":
      return applyToolResult(messages, {
        toolUseId: event.toolUseId,
        result: event.result,
        isError: event.isError,
        riskLevel: event.riskLevel,
        riskReason: event.riskReason,
        matchedTrustRuleId: event.matchedTrustRuleId,
        approvalMode: event.approvalMode,
        approvalReason: event.approvalReason,
        riskThreshold: event.riskThreshold,
        riskAllowlistOptions: event.riskAllowlistOptions,
        riskScopeOptions: event.riskScopeOptions,
        riskDirectoryScopeOptions: event.riskDirectoryScopeOptions,
        imageData: event.imageData,
        imageDataList: event.imageDataList,
        activityMetadata: event.activityMetadata,
        completedAt:
          "completedAt" in event && typeof event.completedAt === "number"
            ? event.completedAt
            : at,
      });
    case "tool_output_chunk":
      if (!event.chunk) return messages;
      return appendToolOutputChunk(messages, {
        chunk: event.chunk,
        toolUseId: event.toolUseId,
        messageId: event.messageId,
      });
    case "ui_surface_show": {
      const surface: Surface = {
        surfaceId: event.surfaceId,
        surfaceType: event.surfaceType,
        title: event.title,
        data: event.data,
        actions: event.actions,
        display: event.display,
      };
      surface.display = classifySurfaceDisplay(surface);
      return attachSurface(messages, surface, event.messageId, at);
    }
    case "ui_surface_update":
      return updateSurfaceData(messages, event.surfaceId, event.data);
    case "ui_surface_dismiss":
      return dismissSurface(messages, event.surfaceId);
    case "ui_surface_complete":
      return completeSurface(messages, event.surfaceId, event.summary);
    default:
      // Total: events that don't change message content (turn lifecycle,
      // queue, subagent/workflow, sync, unknowns) leave the list untouched.
      return messages;
  }
}

/**
 * Fold one event envelope into the history. Drops an event whose `seq` is at or
 * below the history's `seq` — it is already folded — which is what makes replay
 * after reconnect and overlap with a resync safe. `seq` advances to the highest
 * folded value.
 */
export function applyEvent(
  history: PaginatedHistoryResult,
  envelope: AssistantEventEnvelope,
): PaginatedHistoryResult {
  const { seq } = envelope;
  if (
    typeof seq === "number" &&
    typeof history.seq === "number" &&
    seq <= history.seq
  ) {
    return history;
  }

  const at = emittedAtMs(envelope.emittedAt, seq);
  const messages = appendEventToMessages(history.messages, envelope.message, at);
  const nextSeq =
    typeof seq === "number" ? Math.max(history.seq ?? -1, seq) : history.seq ?? null;

  return { ...history, messages, seq: nextSeq };
}

/** Rebuild the history from a snapshot and a run of events — the full
 *  recomputation the invariant certifies against the incremental path. */
export function applyEventsToHistory(
  history: PaginatedHistoryResult,
  events: readonly AssistantEventEnvelope[],
): PaginatedHistoryResult {
  return events.reduce(applyEvent, history);
}

/**
 * Resolve the client's current snapshot from a freshly fetched server snapshot
 * and the buffered event tail to replay onto it (seed and resync share this). A
 * `null` tail means the buffer can't cover the snapshot's watermark (eviction,
 * or no anchor), so the fetched snapshot stands alone; otherwise the tail's
 * `seq > snapshot.seq` events fold on top.
 */
export function resolveSnapshot(
  snapshot: PaginatedHistoryResult,
  tail: readonly AssistantEventEnvelope[] | null,
): PaginatedHistoryResult {
  return tail === null ? snapshot : applyEventsToHistory(snapshot, tail);
}
