import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useConversationStore } from "@/stores/conversation-store";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import { listConversationIdsWithPendingInteractions } from "@/domains/chat/api/interactions";
import { USER_FACING_INTERACTION_KINDS } from "@/types/event-types";
import type { AssistantState } from "@/assistant/types";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { decideGraduationDispatches } from "@/domains/chat/hooks/attention-tracking-utils";
import { reconcileAttentionKeys } from "@/domains/chat/utils/reconcile-attention-keys";

import { useActiveConversation } from "./use-active-conversation";
import { useMarkSeenOnOpen } from "./use-mark-seen-on-open";

interface UseAttentionTrackingParams {
  /** From `useAssistantLifecycle` in `ChatLayout`. */
  assistantId: string | null;
  /** From `useAssistantLifecycle` in `ChatLayout`. */
  assistantStateKind: AssistantState["kind"];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Tracks which conversations need user attention (pending interactions)
 * and manages processing-key lifecycle for background conversations.
 *
 * Reads `conversations` from the TanStack Query chat-context cache via
 * `useConversationListQuery`; reads `processingConversationIds` and
 * `processingSnapshots` directly from `useConversationStore`. Mounted
 * in `ChatLayout` so the sidebar's processing/attention indicators stay
 * live on every chat-layout route (home, library, contacts, identity,
 * chat) — not only `/assistant`.
 *
 * Handles:
 * - Graduating processing keys when the assistant finishes responding
 * - Clearing attention/processing keys when an `interaction_resolved`
 *   SSE event arrives on the event bus
 * - Post-reconnect reconciliation of attention state
 * - One-time initial sweep of all conversations for pending interactions
 *
 * Mark-seen-on-open is handled by `useMarkSeenOnOpen` (conversation
 * lifecycle, not attention tracking).
 */

export function useAttentionTracking({
  assistantId,
  assistantStateKind,
}: UseAttentionTrackingParams) {
  const queryClient = useQueryClient();
  const { conversations } = useConversationListQuery(
    assistantId,
    assistantStateKind === "active",
  );
  const activeConversationId = useConversationStore.use.activeConversationId();
  const processingConversationIds = useConversationStore.use.processingConversationIds();

  // Resolve from either list cache (fetching the single row on demand) so a
  // background/scheduled thread opened before its sidebar section is revealed
  // is still marked seen on open.
  const activeConversation = useActiveConversation(
    assistantId,
    activeConversationId,
    assistantStateKind === "active",
  );

  const initialAttentionSweepDoneRef = useRef(false);

  // -------------------------------------------------------------------------
  // Mark conversation as seen when opened
  // -------------------------------------------------------------------------
  useMarkSeenOnOpen({
    assistantId,
    assistantStateKind,
    activeConversationId,
    activeConversation,
  });

  // -------------------------------------------------------------------------
  // Processing keys cleanup — graduate keys when assistant finishes responding
  //
  // One bulk fetch covers every graduating key. The previous shape fanned out
  // N per-conversation requests in a serial `for await` loop.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (processingConversationIds.size === 0) return;
    const snapshots = useConversationStore.getState().processingSnapshots;
    const graduatingKeys: string[] = [];
    for (const key of processingConversationIds) {
      if (key === activeConversationId) continue;
      const conv = conversations.find((c) => c.conversationId === key);
      if (!conv) continue;
      const snapshot = snapshots.get(key);
      if (conv.latestAssistantMessageAt && conv.latestAssistantMessageAt !== snapshot) {
        graduatingKeys.push(key);
      }
    }
    if (graduatingKeys.length === 0) return;

    let cancelled = false;
    (async () => {
      if (!assistantId) return;
      let pendingKeys: Set<string>;
      try {
        pendingKeys = await listConversationIdsWithPendingInteractions(assistantId);
      } catch {
        // See `decideGraduationDispatches` — null signals "do nothing".
        return;
      }
      if (cancelled) return;
      const actions = decideGraduationDispatches(graduatingKeys, pendingKeys);
      for (const action of actions) {
        if (action.type === "ADD_ATTENTION_KEY") {
          useConversationStore.getState().addAttentionConversationId(action.key);
        } else {
          useConversationStore.getState().removeProcessingConversationId(action.key);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [conversations, processingConversationIds, activeConversationId, assistantId]);

  // -------------------------------------------------------------------------
  // Push-based attention reconciliation.
  //
  // The daemon publishes `interaction_resolved` on the bus-owned SSE
  // connection the instant a pending interaction transitions to resolved
  // (approved, rejected, answered, cancelled, or superseded). When that
  // event fires for a non-active conversation, drop it from both
  // `attentionConversationIds` and `processingConversationIds` — the user has either responded
  // elsewhere or the daemon discarded the prompt.
  //
  // Only the user-facing interaction kinds (confirmation, secret,
  // question, acp_confirmation — see `USER_FACING_INTERACTION_KINDS`)
  // signal that the daemon has handed control back to a person and the
  // attention indicator should clear. Every other kind (today, the
  // host-proxy family: `host_bash`, `host_file`, `host_cu`,
  // `host_browser`, `host_app_control`, `host_transfer`) resolves as
  // an intermediate tool step during a turn that is still running, so
  // those must not clear the processing indicator. Filtering by an
  // explicit allowlist — rather than denylisting `host_*` — means
  // future intermediate-step kinds without that prefix stay
  // silently-ignored by default instead of accidentally clearing
  // processing state.
  // -------------------------------------------------------------------------
  useBusSubscription("sse.event", (envelope) => {
    if (!assistantId) return;
    const event = envelope.message;
    if (event.type !== "interaction_resolved") return;
    if (!USER_FACING_INTERACTION_KINDS.has(event.kind)) return;
    const key = event.conversationId;
    if (!key) return;
    const state = useConversationStore.getState();
    if (key === state.activeConversationId) return;
    if (state.attentionConversationIds.has(key)) {
      state.removeAttentionConversationId(key);
    }
    if (state.processingConversationIds.has(key)) {
      state.removeProcessingConversationId(key);
    }
  });

  // -------------------------------------------------------------------------
  // Post-reconnect reconciliation.
  //
  // The bus-owned SSE connection is live-only — it tears down on
  // `app.hidden` and reopens on `app.resume` or a reachability bounce.
  // Any `interaction_resolved` event published while the stream is down
  // is permanently missed, which would leave a stale attention dot on
  // the sidebar until the user opens the conversation or refreshes.
  // Re-running the bulk pending-interactions fetch closes that gap:
  // anything no longer pending is removed from `attentionConversationIds` /
  // `processingConversationIds`, and anything newly pending is promoted to
  // `attentionConversationIds`. Skips the very first `sse.opened` (cause ===
  // "fresh") because the initial-sweep effect below handles that.
  // -------------------------------------------------------------------------
  useBusSubscription("sse.opened", ({ cause }) => {
    if (!assistantId || cause === "fresh") return;
    void reconcileAttentionKeys(assistantId, queryClient, {
      pruneStale: true,
    });
  });

  // -------------------------------------------------------------------------
  // One-time sweep on mount: seed attention keys for every non-active
  // conversation with a pending interaction. Single bulk request, intersected
  // with the loaded conversations list so we only flag conversations the
  // sidebar actually knows about.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!assistantId || conversations.length === 0 || initialAttentionSweepDoneRef.current) return;
    initialAttentionSweepDoneRef.current = true;

    void reconcileAttentionKeys(assistantId, queryClient);
  }, [assistantId, conversations, queryClient]);
}
