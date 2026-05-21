import * as Sentry from "@sentry/react";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useConversationStore } from "@/domains/conversations/conversation-store.js";
import {
  getConversations,
  markConversationSeenLocal,
  useConversationListQuery,
} from "@/domains/conversations/conversation-queries.js";
import { markConversationSeen } from "@/domains/chat/api/conversations.js";
import { listConversationKeysWithPendingInteractions } from "@/domains/chat/api/interactions.js";
import type { AssistantState } from "@/domains/chat/hooks/use-assistant-lifecycle.js";
import { useBusSubscription } from "@/hooks/use-bus-subscription.js";

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
 * `useConversationListQuery`; reads `processingKeys` and
 * `processingSnapshots` directly from `useConversationStore`. Mounted
 * in `ChatLayout` so the sidebar's processing/attention indicators stay
 * live on every chat-layout route (home, library, contacts, identity,
 * chat) — not only `/assistant`.
 *
 * Handles:
 * - Marking conversations as seen when opened
 * - Graduating processing keys when the assistant finishes responding
 * - Clearing attention/processing keys when an `interaction_resolved`
 *   SSE event arrives on the event bus
 * - One-time initial sweep of all conversations for pending interactions
 */

type GraduationAction =
  | { type: "ADD_ATTENTION_KEY"; key: string }
  | { type: "REMOVE_PROCESSING_KEY"; key: string };

/**
 * Decide which conversation-list actions to dispatch for a batch of graduating
 * processing keys after a bulk pending-interactions fetch.
 *
 * Pass `pendingKeys = null` to signal "we don't know" (bulk fetch failed). In
 * that case this returns no actions so the keys stay in `processingKeys` with
 * their snapshots intact; the next render will retry. Graduating without
 * pending-state knowledge would risk silently dropping the processing
 * indicator on a conversation that actually has a pending approval.
 *
 * Pass `pendingKeys` as a Set when the fetch succeeded. Every graduating key
 * is removed from `processingKeys`; ones that are pending also get added to
 * `attentionKeys` first (the red-dot indicator).
 *
 * Exported for unit testing.
 */
export function decideGraduationDispatches(
  graduatingKeys: readonly string[],
  pendingKeys: ReadonlySet<string> | null,
): GraduationAction[] {
  if (pendingKeys === null) return [];
  const actions: GraduationAction[] = [];
  for (const key of graduatingKeys) {
    if (pendingKeys.has(key)) actions.push({ type: "ADD_ATTENTION_KEY", key });
    actions.push({ type: "REMOVE_PROCESSING_KEY", key });
  }
  return actions;
}

export function useAttentionTracking({
  assistantId,
  assistantStateKind,
}: UseAttentionTrackingParams) {
  const queryClient = useQueryClient();
  const { conversations } = useConversationListQuery(
    assistantId,
    assistantStateKind === "active",
  );
  const activeConversationKey = useConversationStore.use.activeConversationKey();
  const processingKeys = useConversationStore.use.processingKeys();

  const activeConversation = conversations.find(
    (c) => c.conversationKey === activeConversationKey,
  );

  const lastSeenOnOpenConversationKeyRef = useRef<string | null>(null);
  const initialAttentionSweepDoneRef = useRef(false);

  // -------------------------------------------------------------------------
  // Mark conversation as seen when opened
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (assistantStateKind !== "active" || !assistantId || !activeConversationKey) return;
    if (!activeConversation) return;
    if (lastSeenOnOpenConversationKeyRef.current === activeConversationKey) return;

    lastSeenOnOpenConversationKeyRef.current = activeConversationKey;
    if (!activeConversation.hasUnseenLatestAssistantMessage) return;

    let cancelled = false;

    markConversationSeen(assistantId, activeConversationKey)
      .then(() => {
        if (cancelled) return;
        markConversationSeenLocal(queryClient, assistantId, activeConversationKey);
      })
      .catch((err) => {
        Sentry.captureException(err, {
          tags: { context: "mark_conversation_seen" },
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeConversation,
    activeConversationKey,
    assistantId,
    assistantStateKind,
    queryClient,
  ]);

  // -------------------------------------------------------------------------
  // Processing keys cleanup — graduate keys when assistant finishes responding
  //
  // One bulk fetch covers every graduating key. The previous shape fanned out
  // N per-conversation requests in a serial `for await` loop.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (processingKeys.size === 0) return;
    const snapshots = useConversationStore.getState().processingSnapshots;
    const graduatingKeys: string[] = [];
    for (const key of processingKeys) {
      if (key === activeConversationKey) continue;
      const conv = conversations.find((c) => c.conversationKey === key);
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
        pendingKeys = await listConversationKeysWithPendingInteractions(assistantId);
      } catch {
        // See `decideGraduationDispatches` — null signals "do nothing".
        return;
      }
      if (cancelled) return;
      const actions = decideGraduationDispatches(graduatingKeys, pendingKeys);
      for (const action of actions) {
        if (action.type === "ADD_ATTENTION_KEY") {
          useConversationStore.getState().addAttentionKey(action.key);
        } else {
          useConversationStore.getState().removeProcessingKey(action.key);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [conversations, processingKeys, activeConversationKey, assistantId]);

  // -------------------------------------------------------------------------
  // Push-based attention reconciliation.
  //
  // The daemon publishes `interaction_resolved` on the bus-owned SSE
  // connection the instant a pending interaction transitions to resolved
  // (approved, rejected, answered, cancelled, or superseded). When that
  // event fires for a non-active conversation, drop it from both
  // `attentionKeys` and `processingKeys` — the user has either responded
  // elsewhere or the daemon discarded the prompt.
  //
  // Host-proxy kinds (`host_bash`, `host_file`, `host_cu`,
  // `host_browser`, `host_app_control`, `host_transfer`) resolve as
  // intermediate tool steps during a turn that is still running, so
  // they must not clear the processing indicator. Only the
  // user-facing kinds (confirmation, secret, question,
  // acp_confirmation) signal that the turn has handed control back.
  // -------------------------------------------------------------------------
  useBusSubscription("sse.event", (event) => {
    if (!assistantId) return;
    if (event.type !== "interaction_resolved") return;
    if (event.kind.startsWith("host_")) return;
    const key = event.conversationKey;
    if (!key) return;
    const state = useConversationStore.getState();
    if (key === state.activeConversationKey) return;
    if (state.attentionKeys.has(key)) {
      state.removeAttentionKey(key);
    }
    if (state.processingKeys.has(key)) {
      state.removeProcessingKey(key);
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
  // anything no longer pending is removed from `attentionKeys` /
  // `processingKeys`, and anything newly pending is promoted to
  // `attentionKeys`. Skips the very first `sse.opened` (cause ===
  // "fresh") because the initial-sweep effect below handles that.
  // -------------------------------------------------------------------------
  useBusSubscription("sse.opened", ({ cause }) => {
    if (!assistantId || cause === "fresh") return;
    void (async () => {
      let pendingKeys: Set<string>;
      try {
        pendingKeys = await listConversationKeysWithPendingInteractions(assistantId);
      } catch {
        return; // Best-effort — sse.event will catch subsequent transitions.
      }
      const state = useConversationStore.getState();
      const activeKey = state.activeConversationKey;
      for (const key of state.attentionKeys) {
        if (key === activeKey) continue;
        if (!pendingKeys.has(key)) state.removeAttentionKey(key);
      }
      for (const key of state.processingKeys) {
        if (key === activeKey) continue;
        if (pendingKeys.has(key)) {
          state.addAttentionKey(key);
          state.removeProcessingKey(key);
        }
      }
      for (const key of pendingKeys) {
        if (key === activeKey) continue;
        if (!state.attentionKeys.has(key) && !state.processingKeys.has(key)) {
          state.addAttentionKey(key);
        }
      }
    })();
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

    let cancelled = false;
    (async () => {
      let pendingKeys: Set<string>;
      try {
        pendingKeys = await listConversationKeysWithPendingInteractions(assistantId);
      } catch {
        return; // Best-effort — sidebar can still graduate via SSE events.
      }
      if (cancelled || pendingKeys.size === 0) return;
      // Pull the current snapshot from the cache to avoid the closed-over
      // `conversations` capture from the effect's first render.
      const currentConversations = getConversations(queryClient, assistantId);
      for (const conv of currentConversations) {
        if (conv.conversationKey === activeConversationKey) continue;
        if (pendingKeys.has(conv.conversationKey)) {
          useConversationStore.getState().addAttentionKey(conv.conversationKey);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [assistantId, conversations, activeConversationKey, queryClient]);
}
