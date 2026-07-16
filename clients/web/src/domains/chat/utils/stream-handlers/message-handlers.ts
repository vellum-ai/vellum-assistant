import { recordDiagnostic } from "@/lib/diagnostics";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import {
  findConversation,
  patchConversation,
} from "@/utils/conversation-cache";
import { useConversationStore } from "@/stores/conversation-store";
import type {
  AssistantActivityStateEvent,
  AssistantTextDeltaEvent,
  AssistantThinkingDeltaEvent,
  AssistantTurnStartEvent,
  GenerationCancelledEvent,
  GenerationHandoffEvent,
  MessageCompleteEvent,
  UserMessageEchoEvent,
} from "@vellumai/assistant-api";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";

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
 * Mark a conversation as processing in response to an SSE turn signal
 * (`assistant_turn_start`, or the first `assistant_text_delta` when the
 * start event was dropped on a reconnect).
 *
 * Patches the cached conversation row's `isProcessing` to `true` so
 * 0.8.8+ clients can read `conversation.isProcessing` as the single
 * source of truth — the symmetric counterpart to the terminal handlers'
 * `isProcessing: false` patch. The patch is guarded on the current cached
 * value so a long run of text deltas doesn't rewrite the cache (and
 * re-render its readers) on every chunk.
 *
 * Also seeds the client optimistic mirror (`processingConversationIds`),
 * which older daemons that omit `isProcessing` on the wire still rely on.
 * The mirror is seeded with the cached `latestAssistantMessageAt` so
 * attention tracking has a baseline to graduate against — without it,
 * switching away from an SSE-only turn would immediately graduate
 * (comparing `number !== undefined`) and drop the sidebar processing
 * affordance while the assistant is still running.
 */
function markConversationProcessingFromStream(
  ctx: StreamHandlerContext,
  conversationId: string,
): void {
  const cached = findConversation(
    ctx.queryClient,
    ctx.assistantId,
    conversationId,
  );
  if (cached?.isProcessing !== true) {
    patchConversation(ctx.queryClient, ctx.assistantId, conversationId, {
      isProcessing: true,
    });
  }
  useConversationStore
    .getState()
    .markConversationProcessing(conversationId, cached?.latestAssistantMessageAt);
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
  // where the local `useSendMessage` flow never ran.
  const convId = resolveConversationId(event, ctx);
  if (convId) {
    markConversationProcessingFromStream(ctx, convId);
  }
}

export function handleAssistantTextDelta(
  event: AssistantTextDeltaEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.cancelReconciliation();
  ctx.turnActions.onTextDelta();

  // First delta on a conversation that never saw `assistant_turn_start`
  // (e.g. the start event being dropped on a reconnect) still needs to
  // flip processing on. Idempotent — see
  // `markConversationProcessingFromStream`.
  const convId = resolveConversationId(event, ctx);
  if (convId) {
    markConversationProcessingFromStream(ctx, convId);
  }

  // Transcript content is folded into the materialized snapshot by the
  // rolling-snapshot reducer (`use-event-stream`); the handler only stamps the
  // current-assistant anchor so subagent handlers attribute nested
  // notifications to the right parent bubble.
  if (event.messageId) {
    ctx.currentAssistantMessageIdRef.current = event.messageId;
  }
}

/**
 * Apply an `assistant_thinking_delta` event — a streaming reasoning chunk
 * from a thinking-capable model. Accumulates the chunk into the streaming
 * assistant row's `thinkingSegments` and `contentOrder` so the reasoning
 * block renders live instead of only after a history refresh.
 *
 * Reasoning-heavy models emit a long run of thinking deltas before any
 * text/tool output, so this handler often opens the streaming bubble. It
 * deliberately does not touch conversation processing state — that is
 * driven by `assistant_turn_start` / `assistant_text_delta`; a thinking
 * delta without a started turn is not a meaningful state on its own.
 */
export function handleAssistantThinkingDelta(
  event: AssistantThinkingDeltaEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.cancelReconciliation();

  // Content folds into the snapshot via the reducer; stamp the anchor only.
  if (event.messageId) {
    ctx.currentAssistantMessageIdRef.current = event.messageId;
  }
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
    // Daemon-initiated work (e.g. summarize-up-to-here) reports thinking
    // without a client-initiated turn. Allow the signal to start activity
    // from an idle turn store only when the event belongs to the active
    // conversation — a background conversation's activity must not light
    // this tab's indicator.
    const activeConversationId =
      useConversationStore.getState().activeConversationId;
    ctx.turnActions.onActivityThinking(event.statusText, {
      canStartFromIdle: convId != null && convId === activeConversationId,
    });
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

  // The reducer finalizes running tool calls on the snapshot when it folds the
  // `idle` activity state; the handler owns only the turn/processing teardown.
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
  // The reducer folds `message_complete` into the snapshot (finalizing the
  // assistant row); the handler owns subagent re-anchoring and turn teardown.

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
 * The reducer folds the echoed server user row into the snapshot — rendering
 * the user turn on every client, including passive viewers and synthetic
 * surface-action prompts that never issued the originating POST. The handler's
 * job is to retire the originating client's optimistic send so the overlay
 * doesn't double-render it next to the now-persisted server row.
 *
 * The common path correlates on `clientMessageId` (the nonce the daemon echoes
 * back) and removes the optimistic copy — with one exception: a send that
 * carries attachments is kept. The echo event has no attachment payload, so
 * the snapshot row the reducer folds is text-only; the optimistic row holds
 * the only copy of the user's previews (blob URLs for pasted images) until
 * the turn-end reseed pulls the hydrated server row. The kept row is upgraded
 * to the server id (so id-keyed actions resolve and the overlay collapses it
 * onto the folded snapshot row) and its queue fields are cleared; the reseed's
 * `pruneConfirmedOptimisticSends` retires it once the authoritative snapshot
 * carries the persisted row with attachment data.
 *
 * Retiring the optimistic row is gated on the snapshot being seeded. The fold
 * that materializes the echoed server row (`applyEnvelopeToSnapshot`, dispatched
 * from the same `sse.event` in `use-event-stream`) is itself a no-op until the
 * snapshot exists — so on the FIRST message of a freshly server-minted
 * conversation, whose history hasn't loaded yet, retiring the optimistic row
 * here would drop the only rendered copy and blank the message out until
 * `seedSnapshot` lands (the staging first-message flicker). When the snapshot is
 * unseeded we leave the optimistic row in place and let
 * `pruneConfirmedOptimisticSends` retire it atomically on the reseed — the
 * persisted row carries the same `clientMessageId`, so it matches there.
 *
 * When the echo carries no nonce — the field is optional and pre-idempotency
 * daemons omit it — there's no shared key for the overlay to collapse on, so
 * fall back to retiring the most recent optimistic user send, mirroring the
 * legacy echo correlation. A no-op for echoes with no matching optimistic row
 * (other clients' sends, synthetic prompts).
 */
export function handleUserMessageEcho(
  event: UserMessageEchoEvent,
  ctx: StreamHandlerContext,
): void {
  if (event.clientMessageId) {
    // No snapshot yet → the paired fold can't materialize this row, so retiring
    // the overlay now would leave a render gap (the staging first-message
    // flicker). Defer to the reseed's `pruneConfirmedOptimisticSends`, which
    // matches the persisted row on this same `clientMessageId`.
    if (!useChatSessionStore.getState().snapshot) {
      return;
    }
    const nonce = event.clientMessageId;
    const serverId = event.messageId;
    ctx.setOptimisticSends((prev) => {
      const idx = prev.findIndex((m) => m.clientMessageId === nonce);
      if (idx === -1) {
        return prev;
      }
      const row = prev[idx]!;
      // A synthetic echo (no messageId) leaves nothing to upgrade to, and an
      // attachment-less send has no preview to preserve — remove either.
      if (serverId === undefined || !row.attachments?.length) {
        return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      }
      const next = [...prev];
      next[idx] = {
        ...row,
        id: serverId,
        isOptimistic: false,
        queueStatus: undefined,
        queuePosition: undefined,
      };
      return next;
    });
    return;
  }
  ctx.setOptimisticSends((prev) => {
    for (let i = prev.length - 1; i >= 0; i--) {
      const m = prev[i];
      if (m && m.role === "user" && m.isOptimistic === true) {
        return [...prev.slice(0, i), ...prev.slice(i + 1)];
      }
    }
    return prev;
  });
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
