
import * as Sentry from "@sentry/react";
import type { ViewSelection } from "@/domains/chat/lib/navigation-history.js";
import type { MainView } from "@/stores/viewer-store.js";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";

import {
  ApiError,
  type Conversation,
  fetchGroups,
  getChatContext,
  listConversations,
} from "@/domains/chat/lib/api.js";
import { toast } from "@vellum/design-library";
import type { DisplayMessage } from "@/domains/chat/lib/reconcile.js";
import {
  createDraftConversationKey,
  resolveBootstrappedConversationKey,
} from "@/domains/chat/lib/conversation-selection.js";
import { loadContextWindowUsageMap } from "@/domains/chat/lib/contextWindowStorage.js";
import {
  loadLastViewedConversationKey,
  saveLastViewedConversationKey,
} from "@/domains/chat/lib/lastViewedConversationStorage.js";
import type { TranscriptPaginationState } from "@/domains/chat/lib/transcript/types.js";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator.js";
import type { DomainEvent } from "@/domains/messaging/turn-store.js";
import type { InteractionEvent, InteractionState } from "@/domains/interactions/interaction-store.js";
import type { ConversationListAction } from "@/domains/conversations/conversation-list-store.js";
import type { SubagentAction } from "@/domains/subagents/subagent-store.js";
import { haptic } from "@/utils/haptics.js";

import type { RefreshSettleHandle } from "@/domains/chat/hooks/use-pull-refresh.js";
import type { AssistantStateKind, ChatError } from "@/domains/chat/types.js";
import {
  useConversationHistory,
  type HistoryPaginationSnapshot,
} from "@/domains/chat/hooks/use-conversation-history.js";
import { useAttentionTracking } from "@/domains/chat/hooks/use-attention-tracking.js";

// Re-export for consumers that import from this module
export {
  MAX_CACHED_CONVERSATIONS,
  type HistoryPaginationSnapshot,
  getPaginationAfterLatestHistory,
} from "@/domains/chat/hooks/use-conversation-history.js";

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

const CONVERSATION_LIST_INVALIDATED_DEBOUNCE_MS = 250;
const CHAT_CONTEXT_LOAD_FAILED_CODE = "CHAT_CONTEXT_LOAD_FAILED";

/**
 * Minimal URL search-params reader — accepts any object that supports
 * `get` and `toString`. Both Next.js `ReadonlyURLSearchParams` and the
 * standard `URLSearchParams` satisfy this.
 */
interface SearchParamsLike {
  get: (key: string) => string | null;
  toString: () => string;
}

interface UseConversationLoaderParams {
  // Identity / routing
  assistantId: string | null;
  assistantStateKind: AssistantStateKind;
  activeConversationKey: string | null;
  searchParams: SearchParamsLike;
  /** Navigate to a URL string. Callers wire this to their framework router. */
  pushRoute: (url: string) => void;

  // Collections
  conversations: Conversation[];
  activeConversation: Conversation | undefined;
  processingKeys: Set<string>;
  attentionKeys: Set<string>;
  transcriptPagination: Omit<TranscriptPaginationState, "items">;

  // Feature flags / epochs
  conversationGroupsUI: boolean;
  refreshEpoch: number;
  reachabilityReadyEpoch: number;

  // Refs (owned by parent, read/written by this hook)
  assistantIdRef: MutableRefObject<string | null>;
  conversationCacheRef: MutableRefObject<
    Map<string, { messages: DisplayMessage[]; pagination: HistoryPaginationSnapshot }>
  >;
  draftKeyResolutionRef: MutableRefObject<boolean>;
  previousConversationKeyRef: MutableRefObject<string | null>;
  onboardingDraftConversationKeyRef: MutableRefObject<string | null>;
  activeConversationKeyRef: MutableRefObject<string | null>;
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  draftsRef: MutableRefObject<Map<string, string>>;
  messagesRef: MutableRefObject<DisplayMessage[]>;
  conversationsRef: MutableRefObject<Conversation[]>;
  interactionStateRef: MutableRefObject<InteractionState>;
  contextWindowUsageByConversationRef: MutableRefObject<Map<string, ContextWindowUsage>>;
  dismissedSurfaceIdsRef: MutableRefObject<Set<string>>;
  needsNewBubbleRef: MutableRefObject<boolean>;
  streamingMessageIdsRef: MutableRefObject<Set<string>>;
  pendingQueuedStableIdsRef: MutableRefObject<string[]>;
  requestIdToStableIdRef: MutableRefObject<Map<string, string>>;
  pendingLocalDeletionsRef: MutableRefObject<Set<string>>;
  confirmationToolCallMapRef: MutableRefObject<Map<string, string>>;
  processingSnapshotsRef: MutableRefObject<Map<string, string | undefined>>;
  refreshSettleRef: MutableRefObject<RefreshSettleHandle | null>;
  lastSuggestionMsgIdRef: MutableRefObject<string | null>;
  autoGreetRef: MutableRefObject<boolean>;
  initialPageOldestTsRef: MutableRefObject<number | null>;
  isLoadingOlderRef: MutableRefObject<boolean>;
  historyLoadedRef: MutableRefObject<boolean>;
  conversationListInvalidatedTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  loadEpochRef: MutableRefObject<number>;
  pendingInitialMessageRef: MutableRefObject<{ conversationKey: string; content: string } | null>;

  // State setters
  setAssistantId: Dispatch<SetStateAction<string | null>>;
  dispatchConversationList: Dispatch<ConversationListAction>;
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  setTranscriptPagination: Dispatch<SetStateAction<Omit<TranscriptPaginationState, "items">>>;
  setIsLoadingHistory: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<ChatError | null>>;
  dispatchInteraction: Dispatch<InteractionEvent>;
  setAutoGreetPending: Dispatch<SetStateAction<boolean>>;
  setContextWindowUsage: Dispatch<SetStateAction<ContextWindowUsage | null>>;
  setSuggestion: Dispatch<SetStateAction<string | null>>;
  setCompactionCircuitOpenUntil: Dispatch<SetStateAction<Date | null>>;
  setInput: Dispatch<SetStateAction<string>>;
  setMainView: Dispatch<SetStateAction<MainView>>;
  dispatchTurn: Dispatch<DomainEvent>;
  dispatchSubagent: Dispatch<SubagentAction>;

  // Callbacks
  resetChatAttachments: () => void;
  syncNeedsNewBubbleFromMessages: (nextMessages: DisplayMessage[]) => void;
  navPush: (selection: ViewSelection) => void;
  /**
   * Fires after a non-empty saved draft is restored into the composer on a
   * conversation switch. Receives the conversation key the draft belongs to.
   * Used by the page to render a transient "Draft restored" notice so the
   * user does not mistake the restored text for a stale unsent message (see
   * LUM-1516). Optional — omit to suppress the notice (e.g. in tests).
   */
  onDraftRestored?: (conversationKey: string) => void;

  // Error classification
  shouldSuppressGenericChatErrorNotice: (prev: ChatError | null) => boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Loads and synchronizes conversation data: initial hydration, conversation
 * switching, draft resolution, message history pagination, and periodic
 * polling for new messages.
 *
 * Owns the primary data-fetching lifecycle for the chat sidebar and
 * transcript. Returns `switchConversation`, `startNewConversation`,
 * `refreshConversations`, and `scheduleConversationListRefetch` for use
 * by sibling hooks.
 *
 * Delegates to:
 * - `useConversationHistory` -- conversation switch, cache, and history loading
 * - `useAttentionTracking` -- processing/attention key lifecycle and polling
 */
export function useConversationLoader({
  assistantId,
  assistantStateKind,
  activeConversationKey,
  searchParams,
  pushRoute,
  conversations,
  activeConversation,
  processingKeys,
  attentionKeys,
  transcriptPagination,
  conversationGroupsUI,
  refreshEpoch,
  reachabilityReadyEpoch,
  assistantIdRef,
  conversationCacheRef,
  draftKeyResolutionRef,
  previousConversationKeyRef,
  onboardingDraftConversationKeyRef,
  activeConversationKeyRef,
  inputRef,
  draftsRef,
  messagesRef,
  conversationsRef,
  interactionStateRef,
  contextWindowUsageByConversationRef,
  dismissedSurfaceIdsRef,
  needsNewBubbleRef,
  streamingMessageIdsRef,
  pendingQueuedStableIdsRef,
  requestIdToStableIdRef,
  pendingLocalDeletionsRef,
  confirmationToolCallMapRef,
  processingSnapshotsRef,
  refreshSettleRef,
  lastSuggestionMsgIdRef,
  autoGreetRef,
  initialPageOldestTsRef,
  isLoadingOlderRef,
  historyLoadedRef,
  conversationListInvalidatedTimerRef,
  loadEpochRef,
  pendingInitialMessageRef,
  setAssistantId,
  dispatchConversationList,
  setMessages,
  setTranscriptPagination,
  setIsLoadingHistory,
  setError,
  dispatchInteraction,
  setAutoGreetPending,
  setContextWindowUsage,
  setSuggestion,
  setCompactionCircuitOpenUntil,
  setInput,
  setMainView,
  dispatchTurn,
  dispatchSubagent,
  resetChatAttachments,
  syncNeedsNewBubbleFromMessages,
  navPush,
  onDraftRestored,
  shouldSuppressGenericChatErrorNotice,
}: UseConversationLoaderParams) {
  // -------------------------------------------------------------------------
  // Internal refs
  // -------------------------------------------------------------------------
  const refreshConversationsRef = useRef<() => Promise<void>>(async () => {});
  const hydratedAssistantIdRef = useRef<string | null>(null);

  // -------------------------------------------------------------------------
  // refreshConversations -- fetch conversation list + groups
  // -------------------------------------------------------------------------
  const refreshConversations = useCallback(async () => {
    if (!assistantId) return;
    try {
      const updated = await listConversations(assistantId);
      dispatchConversationList({ type: "SET_CONVERSATIONS", conversations: updated });
    } catch (err) {
      Sentry.captureException(err, {
        tags: { context: "refresh_conversations" },
      });
    }
    if (conversationGroupsUI) {
      fetchGroups(assistantId)
        .then((groups) => dispatchConversationList({ type: "SET_GROUPS", groups }))
        .catch((err) => {
          Sentry.captureException(err, {
            level: "warning",
            tags: { context: "refreshGroups" },
          });
        });
    }
  }, [assistantId, conversationGroupsUI, dispatchConversationList]);

  // Keep the ref in sync so the debounced scheduler always calls the latest.
  useEffect(() => {
    refreshConversationsRef.current = refreshConversations;
  }, [refreshConversations]);

  // -------------------------------------------------------------------------
  // scheduleConversationListRefetch -- trailing-edge debounce (250 ms)
  // -------------------------------------------------------------------------
  const scheduleConversationListRefetch = useCallback(() => {
    if (conversationListInvalidatedTimerRef.current) {
      clearTimeout(conversationListInvalidatedTimerRef.current);
    }
    conversationListInvalidatedTimerRef.current = setTimeout(() => {
      conversationListInvalidatedTimerRef.current = null;
      refreshConversationsRef.current();
    }, CONVERSATION_LIST_INVALIDATED_DEBOUNCE_MS);
  }, [conversationListInvalidatedTimerRef]);

  // -------------------------------------------------------------------------
  // Context window usage hydration from localStorage
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!assistantId) return;
    if (hydratedAssistantIdRef.current === assistantId) return;
    hydratedAssistantIdRef.current = assistantId;
    const stored = loadContextWindowUsageMap(assistantId);
    if (stored.size === 0) return;
    const merged = new Map(contextWindowUsageByConversationRef.current);
    for (const [key, value] of stored) {
      if (!merged.has(key)) {
        merged.set(key, value);
      }
    }
    contextWindowUsageByConversationRef.current = merged;
    if (activeConversationKey) {
      const cached = merged.get(activeConversationKey);
      if (cached) {
        setContextWindowUsage(cached);
      }
    }
  }, [assistantId, activeConversationKey, contextWindowUsageByConversationRef, setContextWindowUsage]);

  // -------------------------------------------------------------------------
  // Init effect -- fetch conversations when the assistant becomes active
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (assistantStateKind !== "active") return;

    let cancelled = false;

    const init = async () => {
      try {
        const ctx = await getChatContext();
        if (!ctx || cancelled) return;

        const qpKey = searchParams.get("conversationKey");
        let onboardingDraftConversationKey: string | null = null;
        if (searchParams.get("onboarding") === "1") {
          onboardingDraftConversationKeyRef.current ??= createDraftConversationKey();
          onboardingDraftConversationKey = onboardingDraftConversationKeyRef.current;
        }
        const key = resolveBootstrappedConversationKey({
          queryParamKey: qpKey,
          onboardingDraftConversationKey,
          currentConversationKey: activeConversationKeyRef.current,
          currentAssistantId: assistantIdRef.current,
          nextAssistantId: ctx.assistantId,
          storedConversationKey: loadLastViewedConversationKey(ctx.assistantId),
          defaultConversationKey: ctx.conversationKey,
          conversations: ctx.conversations,
        });

        if (cancelled) return;

        setAssistantId(ctx.assistantId);
        setError((prev) =>
          prev?.code === CHAT_CONTEXT_LOAD_FAILED_CODE ? null : prev,
        );
        dispatchConversationList({ type: "SET_CONVERSATIONS", conversations: ctx.conversations });

        if (conversationGroupsUI) {
          fetchGroups(ctx.assistantId)
            .then((groups) => {
              if (!cancelled) dispatchConversationList({ type: "SET_GROUPS", groups });
            })
            .catch((err) => {
              Sentry.captureException(err, {
                level: "warning",
                tags: { context: "fetchGroups.init" },
              });
            });
        }

        dispatchConversationList({ type: "SET_ACTIVE_KEY", key });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          toast.error("Failed to authenticate user.");
        } else {
          Sentry.captureException(err, {
            level: "warning",
            tags: { context: "getChatContext.init" },
          });
          setError((prev) => {
            if (shouldSuppressGenericChatErrorNotice(prev)) return prev;
            return {
              code: CHAT_CONTEXT_LOAD_FAILED_CODE,
              message:
                err instanceof ApiError && err.status >= 500
                  ? "We couldn't reach your assistant. We'll keep checking the connection."
                  : "We couldn't load your conversations. Please refresh and try again.",
            };
          });
        }
      }
    };

    init();

    return () => {
      cancelled = true;
    };
    // `reachabilityReadyEpoch` is intentionally in the deps: when the
    // assistant pod recovers from a restart we want to re-run
    // getChatContext() so the conversation list populates without a
    // manual reload.
  }, [
    assistantStateKind,
    searchParams,
    reachabilityReadyEpoch,
    refreshEpoch,
    assistantIdRef,
    activeConversationKeyRef,
    onboardingDraftConversationKeyRef,
    conversationGroupsUI,
    setAssistantId,
    setError,
    dispatchConversationList,
    shouldSuppressGenericChatErrorNotice,
  ]);

  // -------------------------------------------------------------------------
  // conversationExistsOnServer
  // -------------------------------------------------------------------------
  const conversationExistsOnServer = useMemo(
    () =>
      activeConversationKey != null &&
      conversations.some(
        (c) => c.conversationKey === activeConversationKey && !c.draft,
      ),
    [activeConversationKey, conversations],
  );

  // -------------------------------------------------------------------------
  // Save last-viewed conversation per assistant
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!assistantId || !activeConversationKey) return;
    saveLastViewedConversationKey(assistantId, activeConversationKey);
  }, [assistantId, activeConversationKey]);

  // -------------------------------------------------------------------------
  // Delegate: conversation history loading and caching
  // -------------------------------------------------------------------------
  useConversationHistory({
    assistantId,
    assistantStateKind,
    activeConversationKey,
    refreshEpoch,
    transcriptPagination,
    conversationCacheRef,
    draftKeyResolutionRef,
    previousConversationKeyRef,
    inputRef,
    draftsRef,
    messagesRef,
    interactionStateRef,
    contextWindowUsageByConversationRef,
    dismissedSurfaceIdsRef,
    needsNewBubbleRef,
    streamingMessageIdsRef,
    pendingQueuedStableIdsRef,
    requestIdToStableIdRef,
    pendingLocalDeletionsRef,
    confirmationToolCallMapRef,
    refreshSettleRef,
    lastSuggestionMsgIdRef,
    autoGreetRef,
    initialPageOldestTsRef,
    isLoadingOlderRef,
    historyLoadedRef,
    loadEpochRef,
    dispatchConversationList,
    setMessages,
    setTranscriptPagination,
    setIsLoadingHistory,
    setError,
    dispatchInteraction,
    setAutoGreetPending,
    setContextWindowUsage,
    setSuggestion,
    setCompactionCircuitOpenUntil,
    setInput,
    dispatchTurn,
    dispatchSubagent,
    onDraftRestored,
    resetChatAttachments,
    syncNeedsNewBubbleFromMessages,
    shouldSuppressGenericChatErrorNotice,
  });

  // -------------------------------------------------------------------------
  // Delegate: attention tracking and processing key lifecycle
  // -------------------------------------------------------------------------
  useAttentionTracking({
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
  });

  // -------------------------------------------------------------------------
  // switchConversation
  // -------------------------------------------------------------------------
  const switchConversation = useCallback(
    (key: string) => {
      setMainView("chat");
      if (key === activeConversationKey) return;
      const params = new URLSearchParams(searchParams.toString());
      params.set("conversationKey", key);
      pushRoute(`?${params.toString()}`);
    },
    [activeConversationKey, pushRoute, searchParams, setMainView],
  );

  // -------------------------------------------------------------------------
  // startNewConversation
  // -------------------------------------------------------------------------
  const startNewConversation = useCallback(
    ({ silent, initialMessage }: { silent?: boolean; initialMessage?: string } = {}) => {
      if (!silent) haptic.light();
      setMainView("chat");
      const draftKey = createDraftConversationKey();
      if (initialMessage) {
        pendingInitialMessageRef.current = { conversationKey: draftKey, content: initialMessage };
      }
      dispatchConversationList({ type: "SET_ACTIVE_KEY", key: draftKey });
      navPush({ type: "conversation", key: draftKey });
      const params = new URLSearchParams(searchParams.toString());
      params.set("conversationKey", draftKey);
      pushRoute(`?${params.toString()}`);
    },
    [pushRoute, searchParams, navPush, setMainView, pendingInitialMessageRef, dispatchConversationList],
  );

  return {
    refreshConversations,
    scheduleConversationListRefetch,
    switchConversation,
    startNewConversation,
    conversationExistsOnServer,
  };
}
