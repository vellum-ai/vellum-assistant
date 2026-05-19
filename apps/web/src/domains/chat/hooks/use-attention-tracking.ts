
import * as Sentry from "@sentry/react";
import {
  type Dispatch,
  type MutableRefObject,
  useEffect,
  useRef,
} from "react";

import {
  type Conversation,
  listConversationKeysWithPendingInteractions,
  markConversationSeen,
} from "@/domains/chat/lib/api.js";
import type { ConversationListAction } from "@/domains/conversations/conversation-list-store.js";
import type { AssistantStateKind } from "@/domains/chat/types.js";

interface UseAttentionTrackingParams {
  assistantId: string | null;
  assistantStateKind: AssistantStateKind;
  activeConversationKey: string | null;

  // Collections
  conversations: Conversation[];
  activeConversation: Conversation | undefined;
  processingKeys: Set<string>;
  attentionKeys: Set<string>;

  // Refs
  conversationsRef: MutableRefObject<Conversation[]>;
  processingSnapshotsRef: MutableRefObject<Map<string, string | undefined>>;

  // State setters
  dispatchConversationList: Dispatch<ConversationListAction>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Tracks which conversations need user attention (pending interactions)
 * and manages processing-key lifecycle for background conversations.
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
  activeConversationKey,
  conversations,
  activeConversation,
  processingKeys,
  attentionKeys,
  conversationsRef,
  processingSnapshotsRef,
  dispatchConversationList,
}: UseAttentionTrackingParams) {
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
        dispatchConversationList({ type: "MARK_CONVERSATION_SEEN", key: activeConversationKey });
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
    dispatchConversationList,
  ]);

  // -------------------------------------------------------------------------
  // Processing keys cleanup — graduate keys when assistant finishes responding
  //
  // One bulk fetch covers every graduating key. The previous shape fanned out
  // N per-conversation requests in a serial `for await` loop.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (processingKeys.size === 0) return;
    const graduatingKeys: string[] = [];
    for (const key of processingKeys) {
      if (key === activeConversationKey) continue;
      const conv = conversations.find((c) => c.conversationKey === key);
      if (!conv) continue;
      const snapshot = processingSnapshotsRef.current.get(key);
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
        dispatchConversationList(action);
        if (action.type === "REMOVE_PROCESSING_KEY") {
          processingSnapshotsRef.current.delete(action.key);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [conversations, processingKeys, activeConversationKey, assistantId, processingSnapshotsRef, dispatchConversationList]);

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

      // Graduate processing keys that are now pending; drop ones the
      // assistant has finished responding to without raising anything.
      for (const key of processingKeys) {
        if (key === activeConversationKey) continue;
        if (attentionKeys.has(key)) continue;
        if (pendingKeys.has(key)) {
          dispatchConversationList({ type: "ADD_ATTENTION_KEY", key });
          dispatchConversationList({ type: "REMOVE_PROCESSING_KEY", key });
          continue;
        }
        const conv = conversationsRef.current.find((c) => c.conversationKey === key);
        const snapshot = processingSnapshotsRef.current.get(key);
        if (conv?.latestAssistantMessageAt && conv.latestAssistantMessageAt !== snapshot) {
          dispatchConversationList({ type: "REMOVE_PROCESSING_KEY", key });
          processingSnapshotsRef.current.delete(key);
        }
      }

      // Clear attention keys whose interaction has been resolved.
      for (const key of attentionKeys) {
        if (key === activeConversationKey) continue;
        if (!pendingKeys.has(key)) {
          dispatchConversationList({ type: "REMOVE_ATTENTION_KEY", key });
        }
      }
    }, 10_000);

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
    };
  }, [
    assistantId,
    processingKeys,
    attentionKeys,
    activeConversationKey,
    conversationsRef,
    processingSnapshotsRef,
    dispatchConversationList,
  ]);

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
      for (const conv of conversations) {
        if (conv.conversationKey === activeConversationKey) continue;
        if (pendingKeys.has(conv.conversationKey)) {
          dispatchConversationList({ type: "ADD_ATTENTION_KEY", key: conv.conversationKey });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [assistantId, conversations, activeConversationKey, dispatchConversationList]);
}
