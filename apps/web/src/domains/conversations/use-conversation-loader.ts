
import * as Sentry from "@sentry/react";
import { useViewerStore } from "@/stores/viewer-store.js";

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";

import { toast } from "@vellum/design-library";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import {
  createDraftConversationId,
  resolveBootstrappedConversationId,
} from "@/domains/chat/utils/conversation-selection.js";
import {
  loadLastViewedConversationId,
  saveLastViewedConversationId,
} from "@/domains/chat/utils/last-viewed-conversation-storage.js";
import type { TranscriptPaginationState } from "@/domains/chat/transcript/types.js";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator.js";


import { useConversationStore } from "@/domains/conversations/conversation-store.js";
import { haptic } from "@/utils/haptics.js";
import { routes } from "@/utils/routes.js";
import type { NavigateFunction } from "react-router";

import type { AssistantStateKind, ChatError } from "@/domains/chat/types.js";
import { useConversationHistory } from "@/domains/chat/hooks/use-conversation-history.js";
import { useQueryClient } from "@tanstack/react-query";

import { ApiError } from "@/domains/chat/api/client.js";
import { type Conversation } from "@/domains/chat/api/conversations.js";
import {
  chatContextQueryKey,
  conversationGroupsQueryKey,
  useChatContextQuery,
} from "@/domains/conversations/conversation-queries.js";

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

const CONVERSATION_LIST_INVALIDATED_DEBOUNCE_MS = 250;
const CHAT_CONTEXT_LOAD_FAILED_CODE = "CHAT_CONTEXT_LOAD_FAILED";

/** Minimal URL search-params reader (subset of `URLSearchParams`). */
interface SearchParamsLike {
  get: (key: string) => string | null;
  toString: () => string;
}

interface UseConversationLoaderParams {
  // Identity / routing
  assistantId: string | null;
  assistantStateKind: AssistantStateKind;
  activeConversationId: string | null;
  /** Conversation key from the URL path param (e.g. `/assistant/conversations/:key`). */
  urlConversationKey: string | null;
  searchParams: SearchParamsLike;
  /** React Router navigate function for path-based routing. */
  navigate: NavigateFunction;

  // Collections
  conversations: Conversation[];

  // Feature flags / epochs
  conversationGroupsUI: boolean;
  refreshEpoch: number;
  reachabilityReadyEpoch: number;

  // Refs (owned by parent, read/written by this hook)
  assistantIdRef: MutableRefObject<string | null>;
  draftConversationIdResolutionRef: MutableRefObject<boolean>;
  previousConversationIdRef: MutableRefObject<string | null>;
  onboardingDraftConversationIdRef: MutableRefObject<string | null>;
  activeConversationIdRef: MutableRefObject<string | null>;
  contextWindowUsageByConversationRef: MutableRefObject<Map<string, ContextWindowUsage>>;
  dismissedSurfaceIdsRef: MutableRefObject<Set<string>>;
  streamingMessageIdsRef: MutableRefObject<Set<string>>;
  pendingQueuedStableIdsRef: MutableRefObject<string[]>;
  requestIdToStableIdRef: MutableRefObject<Map<string, string>>;
  pendingLocalDeletionsRef: MutableRefObject<Set<string>>;
  confirmationToolCallMapRef: MutableRefObject<Map<string, string>>;
  lastSuggestionMsgIdRef: MutableRefObject<string | null>;
  autoGreetRef: MutableRefObject<boolean>;
  conversationListInvalidatedTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  pendingInitialMessageRef: MutableRefObject<{ conversationId: string; content: string } | null>;

  // State setters
  setAssistantId: Dispatch<SetStateAction<string | null>>;
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  setTranscriptPagination: Dispatch<SetStateAction<Omit<TranscriptPaginationState, "items">>>;
  setIsLoadingHistory: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<ChatError | null>>;
  setAutoGreetPending: Dispatch<SetStateAction<boolean>>;
  setContextWindowUsage: Dispatch<SetStateAction<ContextWindowUsage | null>>;
  setSuggestion: Dispatch<SetStateAction<string | null>>;
  setCompactionCircuitOpenUntil: Dispatch<SetStateAction<Date | null>>;

  // Callbacks
  resetChatAttachments: () => void;

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
 *
 * Attention/processing-key tracking is owned by `useAttentionTracking`,
 * mounted in `ChatLayout` so the bus-driven `interaction_resolved`
 * subscriber and post-reconnect reconcile cover every chat-layout
 * route (home/library/contacts/identity), not only `/assistant`.
 */
export function useConversationLoader({
  assistantId,
  assistantStateKind,
  activeConversationId,
  urlConversationKey,
  searchParams,
  navigate,
  conversations,
  conversationGroupsUI,
  refreshEpoch,
  reachabilityReadyEpoch,
  assistantIdRef,
  draftConversationIdResolutionRef,
  previousConversationIdRef,
  onboardingDraftConversationIdRef,
  activeConversationIdRef,
  contextWindowUsageByConversationRef,
  dismissedSurfaceIdsRef,
  streamingMessageIdsRef,
  pendingQueuedStableIdsRef,
  requestIdToStableIdRef,
  pendingLocalDeletionsRef,
  confirmationToolCallMapRef,
  lastSuggestionMsgIdRef,
  autoGreetRef,
  conversationListInvalidatedTimerRef,
  pendingInitialMessageRef,
  setAssistantId,
  setMessages,
  setTranscriptPagination,
  setIsLoadingHistory,
  setError,
  setAutoGreetPending,
  setContextWindowUsage,
  setSuggestion,
  setCompactionCircuitOpenUntil,
  resetChatAttachments,
  shouldSuppressGenericChatErrorNotice,
}: UseConversationLoaderParams) {
  // -------------------------------------------------------------------------
  // Internal refs
  // -------------------------------------------------------------------------
  const refreshConversationsRef = useRef<() => Promise<void>>(async () => {});
  const queryClient = useQueryClient();

  // -------------------------------------------------------------------------
  // refreshConversations -- invalidate the cached conversation list + groups
  // so subscribed query consumers refetch. The active list query is mounted
  // by `ChatLayout` and `ChatPage`, so invalidation triggers a background
  // refetch through the same `getChatContext` queryFn used at boot.
  // -------------------------------------------------------------------------
  const refreshConversations = useCallback(async () => {
    if (!assistantId) return;
    try {
      await queryClient.invalidateQueries({
        queryKey: chatContextQueryKey(assistantId),
      });
    } catch (err) {
      Sentry.captureException(err, {
        tags: { context: "refresh_conversations" },
      });
    }
    if (conversationGroupsUI) {
      void queryClient
        .invalidateQueries({
          queryKey: conversationGroupsQueryKey(assistantId),
        })
        .catch((err) => {
          Sentry.captureException(err, {
            level: "warning",
            tags: { context: "refreshGroups" },
          });
        });
    }
  }, [assistantId, conversationGroupsUI, queryClient]);

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
  // Chat context query subscription
  //
  // The bootstrapping data (assistant id + conversation list + default
  // conversation key) is owned by a single `useChatContextQuery` here.
  // Sibling consumers in `ChatLayout`, `ChatPage`, and `useAttentionTracking`
  // mount the same query — they all share one cache entry under
  // `chatContextQueryKey(assistantId)`, so dedupe and structural-sharing are
  // automatic.
  //
  // The query owns:
  // - fetch initiation (on first subscribe + on invalidations below)
  // - retry semantics (React Query defaults)
  // - error state (surfaced as `query.isError` / `query.error`)
  // - cache lifetime (`data` from the last successful fetch is preserved
  //   across subsequent failed refetches)
  //
  // We never `try/catch` a fetch here. A failed refetch keeps the previously
  // cached `data` available, so the UI keeps showing the conversations we
  // already have. A genuine "no data at all" failure surfaces via the banner
  // consumer below.
  // -------------------------------------------------------------------------
  const chatContextQuery = useChatContextQuery(
    assistantId,
    assistantStateKind === "active",
  );
  const chatContext = chatContextQuery.data ?? null;
  const chatContextError = chatContextQuery.error;
  const chatContextIsError = chatContextQuery.isError;

  // -------------------------------------------------------------------------
  // Refresh-epoch / reachability-epoch ticks
  //
  // Pull-to-refresh and post-restart reachability are signaled via the
  // epoch counters. They mean "treat any cached data as stale and refetch."
  // Invalidating the query marks the cache entry stale; subscribed consumers
  // (this hook included) refetch automatically. We skip the very first
  // render (`epoch === 0` on both) because the query's initial fetch is
  // already in-flight by then.
  // -------------------------------------------------------------------------
  const firstRefreshTickRef = useRef(true);
  useEffect(() => {
    if (firstRefreshTickRef.current) {
      firstRefreshTickRef.current = false;
      return;
    }
    if (assistantStateKind !== "active" || !assistantId) return;
    void queryClient.invalidateQueries({
      queryKey: chatContextQueryKey(assistantId),
    });
  }, [
    refreshEpoch,
    reachabilityReadyEpoch,
    assistantStateKind,
    assistantId,
    queryClient,
  ]);

  // -------------------------------------------------------------------------
  // 401 auth-failure toast
  //
  // Effect-scoped so the toast fires once per transition to a 401 error,
  // not on every render. The banner consumer below intentionally skips 401
  // because this toast already surfaces the right message.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (chatContextError instanceof ApiError && chatContextError.status === 401) {
      toast.error("Failed to authenticate user.");
    }
  }, [chatContextError]);

  // -------------------------------------------------------------------------
  // Banner consumer
  //
  // Raise the chat-context load-failed banner only when (a) the query is
  // in error state AND (b) we have no cached data to fall back on. A
  // refetch failure that leaves the previous `data` intact is a *refresh*
  // failure, not a load failure — the user is still looking at a
  // populated UI, so there is nothing useful to say.
  //
  // When the query recovers (data arrives), clear any prior load-failed
  // banner. Other error codes are left untouched.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (assistantStateKind !== "active") return;
    const isAuthFail =
      chatContextError instanceof ApiError && chatContextError.status === 401;
    const hasUsableData =
      !!chatContext && chatContext.conversations.length > 0;

    if (chatContextIsError && !hasUsableData && !isAuthFail) {
      Sentry.captureException(chatContextError, {
        level: "warning",
        tags: { context: "getChatContext.bootstrap" },
      });
      setError((prev) => {
        if (shouldSuppressGenericChatErrorNotice(prev)) return prev;
        const status =
          chatContextError instanceof ApiError ? chatContextError.status : 0;
        return {
          code: CHAT_CONTEXT_LOAD_FAILED_CODE,
          message:
            status >= 500
              ? "We couldn't reach your assistant. We'll keep checking the connection."
              : "We couldn't load your conversations. Please refresh and try again.",
        };
      });
      return;
    }
    if (hasUsableData) {
      setError((prev) =>
        prev?.code === CHAT_CONTEXT_LOAD_FAILED_CODE ? null : prev,
      );
    }
  }, [
    assistantStateKind,
    chatContext,
    chatContextError,
    chatContextIsError,
    setError,
    shouldSuppressGenericChatErrorNotice,
  ]);

  // -------------------------------------------------------------------------
  // Bootstrap routing
  //
  // When chat context arrives in the cache (from any source — this hook's
  // own subscription or a sibling subscriber that fetched first), resolve
  // the bootstrap conversation key and write it into the URL + client
  // store. Idempotent: `resolveBootstrappedConversationId` prefers the
  // currently-active key when one is set, so a refetch with the same data
  // shape (de-duped by React Query's structural sharing) does not churn
  // the route.
  //
  // This effect intentionally does not raise the banner — error handling
  // lives in the banner-consumer effect above. Decoupling lets the
  // routing logic run as soon as data is available, even if the *most
  // recent* fetch failed (we still have last-known-good data to land on).
  // -------------------------------------------------------------------------
  const lastAppliedUrlKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (assistantStateKind !== "active") return;
    if (!chatContext) return;

    const explicitConversationId =
      urlConversationKey ?? searchParams.get("conversationKey");

    // When only chatContext changed (e.g. from resolveDraftKey's
    // setQueryData) but the URL hasn't changed, the URL key is stale —
    // a programmatic navigate() is in flight. Trust the store's
    // activeConversationId and let the URL catch up.
    if (
      explicitConversationId != null &&
      explicitConversationId === lastAppliedUrlKeyRef.current &&
      assistantIdRef.current === chatContext.assistantId
    ) {
      return;
    }
    lastAppliedUrlKeyRef.current = explicitConversationId;

    let onboardingDraftConversationId: string | null = null;
    if (searchParams.get("onboarding") === "1") {
      onboardingDraftConversationIdRef.current ??= createDraftConversationId();
      onboardingDraftConversationId = onboardingDraftConversationIdRef.current;
    }
    const key = resolveBootstrappedConversationId({
      queryParamKey: explicitConversationId,
      onboardingDraftConversationId,
      currentConversationId: activeConversationIdRef.current,
      currentAssistantId: assistantIdRef.current,
      nextAssistantId: chatContext.assistantId,
      storedConversationId: loadLastViewedConversationId(chatContext.assistantId),
      defaultConversationId: chatContext.conversationId,
      conversations: chatContext.conversations,
    });

    setAssistantId(chatContext.assistantId);

    useConversationStore.getState().setActiveConversationId(key);
    if (key) {
      void navigate(routes.conversation(key), { replace: true });
    }
  }, [
    chatContext,
    assistantStateKind,
    urlConversationKey,
    searchParams,
    navigate,
    setAssistantId,
    assistantIdRef,
    activeConversationIdRef,
    onboardingDraftConversationIdRef,
  ]);

  // -------------------------------------------------------------------------
  // conversationExistsOnServer
  // -------------------------------------------------------------------------
  const conversationExistsOnServer = useMemo(
    () =>
      activeConversationId != null &&
      conversations.some(
        (c) => c.conversationId === activeConversationId && !c.draft,
      ),
    [activeConversationId, conversations],
  );

  // -------------------------------------------------------------------------
  // Save last-viewed conversation per assistant
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!assistantId || !activeConversationId) return;
    saveLastViewedConversationId(assistantId, activeConversationId);
  }, [assistantId, activeConversationId]);

  // -------------------------------------------------------------------------
  // Delegate: conversation history loading and caching
  // -------------------------------------------------------------------------
  const historyResult = useConversationHistory({
    assistantId,
    assistantStateKind,
    activeConversationId,
    draftConversationIdResolutionRef,
    previousConversationIdRef,
    contextWindowUsageByConversationRef,
    dismissedSurfaceIdsRef,
    streamingMessageIdsRef,
    pendingQueuedStableIdsRef,
    requestIdToStableIdRef,
    pendingLocalDeletionsRef,
    confirmationToolCallMapRef,
    lastSuggestionMsgIdRef,
    autoGreetRef,
    setMessages,
    setTranscriptPagination,
    setIsLoadingHistory,
    setError,
    setAutoGreetPending,
    setContextWindowUsage,
    setSuggestion,
    setCompactionCircuitOpenUntil,
    resetChatAttachments,
    shouldSuppressGenericChatErrorNotice,
  });

  // -------------------------------------------------------------------------
  // switchConversation
  // -------------------------------------------------------------------------
  const switchConversation = useCallback(
    (key: string) => {
      useViewerStore.getState().setMainView("chat");
      if (key === activeConversationId) return;
      void navigate(routes.conversation(key));
    },
    [activeConversationId, navigate],
  );

  // -------------------------------------------------------------------------
  // startNewConversation
  // -------------------------------------------------------------------------
  const startNewConversation = useCallback(
    ({ silent, initialMessage }: { silent?: boolean; initialMessage?: string } = {}) => {
      if (!silent) haptic.light();
      useViewerStore.getState().setMainView("chat");
      const draftConversationId = createDraftConversationId();
      if (initialMessage) {
        pendingInitialMessageRef.current = { conversationId: draftConversationId, content: initialMessage };
      }
      useConversationStore.getState().setActiveConversationId(draftConversationId);
      void navigate(routes.conversation(draftConversationId));
    },
    [navigate, pendingInitialMessageRef],
  );

  return {
    refreshConversations,
    scheduleConversationListRefetch,
    switchConversation,
    startNewConversation,
    conversationExistsOnServer,
    historyResult,
  };
}
