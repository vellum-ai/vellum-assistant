import { recordDiagnostic } from "@/lib/diagnostics";
import {
  appendTextDelta,
  applyUserMessageEcho,
  finalizeMessageComplete,
  finalizeOnIdle,
} from "@/domains/chat/hooks/stream-message-updaters";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import {
  findConversation,
  patchConversation,
} from "@/utils/conversation-cache";
import { useConversationStore } from "@/stores/conversation-store";
import type {
  AssistantActivityStateEvent,
  AssistantTextDeltaEvent,
  AssistantTurnStartEvent,
  GenerationCancelledEvent,
  GenerationHandoffEvent,
  MessageCompleteEvent,
  UserMessageEchoEvent,
} from "@vellumai/assistant-api";
import { useSubagentStore } from "@/domains/chat/subagent-store";

/**
 * Resolve the conversation id for SSE handlers — events that carry it on
 * the wire win, otherwise we fall back to the stream's anchor.
 *
 * Both `assistant_turn_start` and `assistant_text_delta` reliably carry a
 * `conversationId`, but the resolver matches the same fallback chain used
 * by the terminal handlers (`handleMessageComplete`,
 * `handleGenerationCancelled`) for symmetry.
 */
function resolveConversationId(
  event: { conversationId?: string },
  ctx: StreamHandlerContext,
): string | undefined {
  return event.conversationId ?? ctx.streamContext?.conversationId;
}

/**
 * Apply an `assistant_turn_start` event.
 *
 * The daemon emits this from event zero of each LLM call in a turn,
 * carrying the `messageId` of the row it `reserveMessage`'d in SQLite.
 * The handler stamps `currentAssistantMessageIdRef` with the anchor id so
 * subagent attribution and any other consumer that reads the ref before a
 * delta lands sees the correct anchor immediately, and marks the
 * conversation as processing.
 */
export function handleAssistantTurnStart(
  event: AssistantTurnStartEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.currentAssistantMessageIdRef.current = event.messageId;

  // Mark the conversation as processing the moment the daemon emits its
  // first start signal. Covers external-channel turns (Slack/Telegram)
  // where the local `useSendMessage` flow never ran, and serves as a
  // belt-and-suspenders fallback against pre-0.8.7 daemons that don't
  // surface `conversation.isProcessing` on the wire.
  //
  // Seed `processingSnapshots` with the cached conversation's
  // `latestAssistantMessageAt` so attention tracking has a baseline to
  // graduate against. Without this seed, switching away from an
  // SSE-only turn would immediately graduate (comparing `number !==
  // undefined`) and drop the sidebar processing affordance while the
  // assistant is still running.
  const convId = resolveConversationId(event, ctx);
  if (convId) {
    const cached = findConversation(
      ctx.queryClient,
      ctx.assistantId,
      convId,
    );
    useConversationStore
      .getState()
      .markConversationProcessing(convId, cached?.latestAssistantMessageAt);
  }
}

export function handleAssistantTextDelta(
  event: AssistantTextDeltaEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.cancelReconciliation();
  ctx.turnActions.onTextDelta();

  // First delta on a conversation that never saw `assistant_turn_start`
  // (e.g. pre-B3 daemons, or the start event being dropped on a
  // reconnect) still needs to flip the badge on. Idempotent — no-op
  // when the conversation is already marked processing AND the snapshot
  // is already seeded. See `handleAssistantTurnStart` for the snapshot
  // rationale.
  const convId = resolveConversationId(event, ctx);
  if (convId) {
    const cached = findConversation(
      ctx.queryClient,
      ctx.assistantId,
      convId,
    );
    useConversationStore
      .getState()
      .markConversationProcessing(convId, cached?.latestAssistantMessageAt);
  }

  ctx.setMessages((prev) => {
    const next = appendTextDelta(prev, event.text, event.messageId);
    const tail = next[next.length - 1];
    // Stamp the current-assistant ref to the assistant tail. Subagent
    // handlers read this to attribute nested notifications to the right
    // parent bubble.
    if (tail?.role === "assistant") {
      ctx.currentAssistantMessageIdRef.current = tail.id;
    }
    return next;
  });
}

export function handleAssistantActivityState(
  event: AssistantActivityStateEvent,
  ctx: StreamHandlerContext,
): void {
  const convId = resolveConversationId(event, ctx);

  if (convId) {
    const lastSeen = ctx.lastActivityVersionRef.current.get(convId) ?? 0;
    if (event.activityVersion <= lastSeen) {
      recordDiagnostic("sse_activity_state_version_skipped", {
        convId,
        phase: event.phase,
        eventVersion: event.activityVersion,
        lastSeenVersion: lastSeen,
      });
      return;
    }
    ctx.lastActivityVersionRef.current.set(convId, event.activityVersion);
  }

  if (event.phase === "thinking") {
    ctx.turnActions.onActivityThinking(event.statusText);
    recordDiagnostic("sse_activity_state_thinking_handled", {
      convId,
      reason: event.reason,
      activityVersion: event.activityVersion,
    });
    return;
  }

  if (event.phase !== "idle") {
    recordDiagnostic("sse_activity_state_non_idle", {
      convId,
      phase: event.phase,
      reason: event.reason,
      activityVersion: event.activityVersion,
    });
    return;
  }

  ctx.setMessages(finalizeOnIdle);
  if (convId) {
    // Mirrors the cache patch in `handleMessageComplete` /
    // `handleGenerationCancelled` — see those handlers for the
    // stale-snapshot rationale.
    patchConversation(ctx.queryClient, ctx.assistantId, convId, {
      isProcessing: false,
    });
  }
  const turnPhaseBefore = ctx.getTurnState().phase;
  ctx.endTurn({ conversationId: convId, reason: "complete" });
  recordDiagnostic("sse_activity_state_idle_handled", {
    convId,
    reason: event.reason,
    activityVersion: event.activityVersion,
    turnPhaseBefore,
  });
}

export function handleMessageComplete(
  event: MessageCompleteEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.setMessages((prev) => finalizeMessageComplete(prev, event));

  // Re-anchor subagents spawned in this turn from the optimistic streaming
  // bubble id (`currentAssistantMessageIdRef`, the same id used as
  // `parentMessageStableId` at spawn time) onto the durable server
  // `messageId`, which survives reconcile. Multi-LLM-call turns collapse onto
  // the first row's id daemon-side; the common single-call spawn turn is
  // unaffected because entries are indexed under both ids in `byParent`.
  const stableId = ctx.currentAssistantMessageIdRef.current;
  if (event.messageId && stableId) {
    useSubagentStore
      .getState()
      .reanchorToMessage({ stableId, messageId: event.messageId });
  }

  // Prefer the event's own `conversationId` over `streamContext`.
  // The event carries the canonical id; the ref is a mirror that may be
  // cleared by a stream teardown that races the terminal event. All
  // three terminal handlers (`handleAssistantActivityState(idle)`,
  // `handleMessageComplete`, `handleGenerationCancelled`) use this same
  // fallback chain so the processing-key clear stays reliable across
  // reconnects.
  const convId = resolveConversationId(event, ctx);
  if (convId) {
    // Patch the cached conversation row so the server-snapshot half of
    // the processing OR (`activeConversation?.isProcessing`) can't stay
    // latched on a stale `true` after the local set is cleared. Without
    // this, conversations opened or refreshed mid-turn would keep the
    // badge / Stop / streaming state lit until an unrelated refetch.
    patchConversation(ctx.queryClient, ctx.assistantId, convId, {
      isProcessing: false,
    });
  }
  const turnPhaseBefore = ctx.getTurnState().phase;
  ctx.endTurn({ conversationId: convId, reason: "complete" });
  recordDiagnostic("sse_message_complete_handled", {
    convId,
    turnPhaseBefore,
    messageId: event.messageId,
    hasAttachments: !!event.attachments?.length,
    reanchored: !!(event.messageId && stableId),
  });
}

/**
 * Apply a `user_message_echo` event.
 *
 * Renders the user turn on every client — including passive viewers and
 * synthetic surface-action prompts that never issued the originating POST
 * — and dedupes the originating client's optimistic row. The id/optimistic
 * reconciliation lives in the pure `applyUserMessageEcho` updater.
 */
export function handleUserMessageEcho(
  event: UserMessageEchoEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.setMessages((prev) => applyUserMessageEcho(prev, event));
}

export function handleGenerationHandoff(
  _event: GenerationHandoffEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.cancelReconciliation();
  ctx.turnActions.handoffGeneration();
}

export function handleGenerationCancelled(
  event: GenerationCancelledEvent,
  ctx: StreamHandlerContext,
): void {
  // See `handleMessageComplete` for the rationale on the event-first
  // fallback chain and the cache-patch.
  const convId = resolveConversationId(event, ctx);
  if (convId) {
    patchConversation(ctx.queryClient, ctx.assistantId, convId, {
      isProcessing: false,
    });
  }
  ctx.endTurn({ conversationId: convId, reason: "cancelled" });
}
