import * as Sentry from "@sentry/react";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useConversationStore } from "@/domains/conversations/conversation-store.js";
import {
  findConversation,
  getConversations,
  markConversationSeenLocal,
  useConversationListQuery,
} from "@/domains/conversations/conversation-queries.js";
import { markConversationSeen } from "@/domains/chat/api/conversations.js";
import { listConversationKeysWithPendingInteractions } from "@/domains/chat/api/interactions.js";
import type { AssistantState } from "@/domains/chat/hooks/use-assistant-lifecycle.js";

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
 * `useConversationListQuery`; reads `processingKeys`, `attentionKeys`, and
 * `processingSnapshots` directly from `useConversationStore`. Mounted
 * in `ChatLayout` so the sidebar's processing/attention indicators stay
 * live on every chat-layout route (home, library, contacts, identity,
 * chat) — not only `/assistant`.
 *
 * Handles:
 * - Marking conversations as seen when opened
 * - Graduating processing keys when the assistant finishes responding
 * - Polling background processing conversations for pending interactions
 * - Clearing attention keys when interactions are resolved
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
 * their snapshots intact; the 10s poller or the next render will retry.
 * Graduating without pending-state knowledge would risk silently dropping the
 * processing indicator on a conversation that actually has a pending approval,
 * and once both processingKeys and attentionKeys are empty the poller's gate
 * (`processingKeys.size === 0 && attentionKeys.size === 0`) short-circuits.
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
  const attentionKeys = useConversationStore.use.attentionKeys();

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
  // Poll processing + attention conversations every 10s.
  //
  // One bulk fetch per tick reconciles both directions:
  //  - processing keys that are now pending → graduate to attention
  //  - attention keys that are no longer pending → clear
  //  - processing keys whose `latestAssistantMessageAt` advanced but have
  //    nothing pending → drop from processing (the assistant responded fully)
  //
  // Previously each direction had its own 10s loop that issued one HTTP
  // request per tracked key.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!assistantId) return;
    if (processingKeys.size === 0 && attentionKeys.size === 0) return;

    let cancelled = false;
    const pollInterval = setInterval(async () => {
      let pendingKeys: Set<string>;
      try {
        pendingKeys = await listConversationKeysWithPendingInteractions(assistantId);
      } catch {
        return; // Best-effort polling — skip this tick on transient failure.
      }
      if (cancelled) return;

      // Read latest store + cache values inside the tick — the effect captured
      // the sets at scheduling time, which would be stale ten seconds later.
      const state = useConversationStore.getState();
      const currentProcessingKeys = state.processingKeys;
      const currentAttentionKeys = state.attentionKeys;
      const currentSnapshots = state.processingSnapshots;
      const currentActiveKey = state.activeConversationKey;

      // Graduate processing keys that are now pending; drop ones the
      // assistant has finished responding to without raising anything.
      for (const key of currentProcessingKeys) {
        if (key === currentActiveKey) continue;
        if (currentAttentionKeys.has(key)) continue;
        if (pendingKeys.has(key)) {
          useConversationStore.getState().addAttentionKey(key);
          useConversationStore.getState().removeProcessingKey(key);
          continue;
        }
        const conv = findConversation(queryClient, assistantId, key);
        const snapshot = currentSnapshots.get(key);
        if (conv?.latestAssistantMessageAt && conv.latestAssistantMessageAt !== snapshot) {
          useConversationStore.getState().removeProcessingKey(key);
        }
      }

      // Clear attention keys whose interaction has been resolved.
      for (const key of currentAttentionKeys) {
        if (key === currentActiveKey) continue;
        if (!pendingKeys.has(key)) {
          useConversationStore.getState().removeAttentionKey(key);
        }
      }
    }, 10_000);

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
    };
  }, [assistantId, processingKeys, attentionKeys, queryClient]);

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
        return; // Best-effort — sidebar can still graduate via the poller.
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
