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
import { attachConfirmationToToolCall } from "@/domains/chat/utils/chat";
import { clearConfirmationByRequestId } from "@/domains/chat/utils/send-message-utils";

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
    case "tool_use_preview_start": {
      // Optimistic pre-input affordance: the daemon recognized a tool call
      // before its input finished streaming. Seed a running tool card anchored
      // to first byte so the perceived-latency timer starts now; `tool_use_start`
      // fills in the real input and execution `startedAt` once the call begins.
      const previewToolCall: ChatMessageToolCall = {
        id: event.toolUseId,
        name: event.toolName,
        input: {},
        previewStartedAt:
          typeof event.previewStartedAt === "number"
            ? event.previewStartedAt
            : at,
      };
      return upsertToolCall(messages, previewToolCall, event.messageId, at);
    }
    case "tool_use_start": {
      const toolCall: ChatMessageToolCall = {
        id: event.toolUseId ?? `tool-${at}`,
        name: event.toolName,
        input: event.input,
        startedAt:
          "startedAt" in event && typeof event.startedAt === "number"
            ? event.startedAt
            : at,
        ...("previewStartedAt" in event &&
        typeof event.previewStartedAt === "number"
          ? { previewStartedAt: event.previewStartedAt }
          : {}),
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
        errorCode: event.errorCode,
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
    case "confirmation_request":
      // Attach the inline confirmation marker onto the matching tool-call row.
      // The interaction handler owns the interaction-store side (it derives the
      // same tool-call id read-only); the marker itself folds here so the
      // reducer stays the single writer of transcript content.
      return attachConfirmationToToolCall(messages, {
        requestId: event.requestId,
        toolName: event.toolName,
        riskLevel: event.riskLevel,
        riskReason: event.riskReason,
        allowlistOptions: event.allowlistOptions,
        scopeOptions: event.scopeOptions,
        directoryScopeOptions: event.directoryScopeOptions,
        persistentDecisionsAllowed: event.persistentDecisionsAllowed,
        input: event.input,
        toolUseId: event.toolUseId,
      }).updatedMessages;
    case "interaction_resolved":
      // Clearing the inline confirmation marker is the symmetric fold; only
      // confirmation kinds render one (other kinds own their own lifecycle).
      return event.kind === "confirmation" || event.kind === "acp_confirmation"
        ? clearConfirmationByRequestId(messages, event.requestId)
        : messages;
    default:
      // Total: events that don't change message content (turn lifecycle,
      // queue, subagent/workflow, sync, unknowns) leave the list untouched.
      return messages;
  }
}

/**
 * Advance the snapshot's authoritative `processing` flag from a folded event.
 *
 * `undefined` is the version sentinel — a daemon that omits `processing` on
 * `/messages` (pre-0.8.8) never gets a synthesized value, so `undefined` stays
 * "no authoritative signal, fall back to the turn phase." Only seq-carrying
 * events move a defined flag, so a replayed or out-of-order tail converges the
 * same way `seq`-idempotency converges the message fold — a bare scalar can't
 * rely on the structural upsert that keeps message rows convergent.
 *
 * Mirrors the turn lifecycle the daemon's `processing_started_at` tracks:
 * turn-start / assistant content marks a turn in flight; the terminal
 * `assistant_activity_state(idle)` and `message_complete` mark it done. Cancel
 * / error terminals aren't folded here — the turn phase already idles on those,
 * and the next `/messages` reseed carries the authoritative `false`.
 */
function nextProcessingState(
  current: boolean | undefined,
  event: AssistantEvent,
  seq: number | null | undefined,
): boolean | undefined {
  if (current === undefined) return undefined;
  if (typeof seq !== "number") return current;
  switch (event.type) {
    case "assistant_turn_start":
    case "assistant_text_delta":
    case "assistant_thinking_delta":
      return true;
    case "assistant_activity_state":
      return event.phase === "idle" ? false : true;
    case "message_complete":
      return false;
    default:
      return current;
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
  const processing = nextProcessingState(history.processing, envelope.message, seq);

  return { ...history, messages, seq: nextSeq, processing };
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
