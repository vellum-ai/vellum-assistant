
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
  createDraftConversationKey,
  resolveBootstrappedConversationKey,
} from "@/domains/chat/utils/conversation-selection.js";
import { loadContextWindowUsageMap } from "@/domains/chat/utils/context-window-storage.js";
import {
  loadLastViewedConversationKey,
  saveLastViewedConversationKey,
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

import { getChatContext } from "@/domains/chat/api/assistant.js";
import { ApiError } from "@/domains/chat/api/client.js";
import { type Conversation } from "@/domains/chat/api/conversations.js";
import {
  chatContextQueryKey,
  conversationGroupsQueryKey,
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
  activeConversationKey: string | null;
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
  draftKeyResolutionRef: MutableRefObject<boolean>;
  previousConversationKeyRef: MutableRefObject<string | null>;
  onboardingDraftConversationKeyRef: MutableRefObject<string | null>;
  activeConversationKeyRef: MutableRefObject<string | null>;
  contextWindowUsageByConversationRef: MutableRefObject<Map<string, ContextWindowUsage>>;
  dismissedSurfaceIdsRef: MutableRefObject<Set<string>>;
  needsNewBubbleRef: MutableRefObject<boolean>;
  streamingMessageIdsRef: MutableRefObject<Set<string>>;
  pendingQueuedStableIdsRef: MutableRefObject<string[]>;
  requestIdToStableIdRef: MutableRefObject<Map<string, string>>;
  pendingLocalDeletionsRef: MutableRefObject<Set<string>>;
  confirmationToolCallMapRef: MutableRefObject<Map<string, string>>;
  lastSuggestionMsgIdRef: MutableRefObject<string | null>;
  autoGreetRef: MutableRefObject<boolean>;
  conversationListInvalidatedTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  pendingInitialMessageRef: MutableRefObject<{ conversationKey: string; content: string } | null>;

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
  syncNeedsNewBubbleFromMessages: (nextMessages: DisplayMessage[]) => void;

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
 * Attention/processing-key tracking is now owned by `useAttentionTracking`,
 * mounted in `ChatLayout` so its 10s polling loop covers every chat-layout
 * route (home/library/contacts/identity), not only `/assistant`.
 */
export function useConversationLoader({
  assistantId,
  assistantStateKind,
  activeConversationKey,
  urlConversationKey,
  searchParams,
  navigate,
  conversations,
  conversationGroupsUI,
  refreshEpoch,
  reachabilityReadyEpoch,
  assistantIdRef,
  draftKeyResolutionRef,
  previousConversationKeyRef,
  onboardingDraftConversationKeyRef,
  activeConversationKeyRef,
  contextWindowUsageByConversationRef,
  dismissedSurfaceIdsRef,
  needsNewBubbleRef,
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
  syncNeedsNewBubbleFromMessages,
  shouldSuppressGenericChatErrorNotice,
}: UseConversationLoaderParams) {
  // -------------------------------------------------------------------------
  // Internal refs
  // -------------------------------------------------------------------------
  const refreshConversationsRef = useRef<() => Promise<void>>(async () => {});
  const hydratedAssistantIdRef = useRef<string | null>(null);
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
        // Always fetch (not just read cache): this effect re-runs when
        // `refreshEpoch` or `reachabilityReadyEpoch` changes, and those
        // changes specifically signal "treat any cached data as stale
        // and pick up server-side changes" (pull-to-refresh, pod
        // recovery, conversation removal, etc.). `fetchQuery` with
        // `staleTime: 0` forces a fresh request and writes through to
        // the same cache that `useConversationListQuery` (mounted in
        // `ChatLayout`) subscribes to — so the sidebar refreshes too,
        // and concurrent fetches on initial mount dedup via the
        // shared query key.
        // https://tanstack.com/query/latest/docs/reference/QueryClient#queryclientfetchquery
        const ctx = await queryClient.fetchQuery({
          queryKey: chatContextQueryKey(assistantId),
          queryFn: getChatContext,
          staleTime: 0,
        });
        if (!ctx || cancelled) return;

        // Path param is the canonical source; fall back to legacy search param.
        const explicitKey = urlConversationKey ?? searchParams.get("conversationKey");
        let onboardingDraftConversationKey: string | null = null;
        if (searchParams.get("onboarding") === "1") {
          onboardingDraftConversationKeyRef.current ??= createDraftConversationKey();
          onboardingDraftConversationKey = onboardingDraftConversationKeyRef.current;
        }
        const key = resolveBootstrappedConversationKey({
          queryParamKey: explicitKey,
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

        // The conversation list is already in the React Query cache via
        // `fetchQuery` above; subscribed consumers (`ChatLayout`,
        // `ChatPage`) will re-render with the populated list on the next
        // commit. Set the active key in the client store within the same
        // effect tick so React batches both updates and consumers never
        // observe an active key with an empty list.
        useConversationStore.getState().setActiveKey(key);

        // Ensure the URL reflects the active conversation so the page is
        // deep-linkable from the moment it loads.  `replace` avoids a
        // spurious history entry. This also moves ChatPage from the index
        // route (where it renders inside ConversationKeyRedirect) to the
        // canonical conversations/:key route before any user interaction,
        // preventing a remount when draft keys resolve during sendMessage.
        if (key) {
          void navigate(routes.conversation(key), { replace: true });
        }
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
    urlConversationKey,
    searchParams,
    navigate,
    reachabilityReadyEpoch,
    refreshEpoch,
    assistantIdRef,
    activeConversationKeyRef,
    onboardingDraftConversationKeyRef,
    conversationGroupsUI,
    setAssistantId,
    setError,
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
  const historyResult = useConversationHistory({
    assistantId,
    assistantStateKind,
    activeConversationKey,
    draftKeyResolutionRef,
    previousConversationKeyRef,
    contextWindowUsageByConversationRef,
    dismissedSurfaceIdsRef,
    needsNewBubbleRef,
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
    syncNeedsNewBubbleFromMessages,
    shouldSuppressGenericChatErrorNotice,
  });

  // -------------------------------------------------------------------------
  // switchConversation
  // -------------------------------------------------------------------------
  const switchConversation = useCallback(
    (key: string) => {
      useViewerStore.getState().setMainView("chat");
      if (key === activeConversationKey) return;
      void navigate(routes.conversation(key));
    },
    [activeConversationKey, navigate],
  );

  // -------------------------------------------------------------------------
  // startNewConversation
  // -------------------------------------------------------------------------
  const startNewConversation = useCallback(
    ({ silent, initialMessage }: { silent?: boolean; initialMessage?: string } = {}) => {
      if (!silent) haptic.light();
      useViewerStore.getState().setMainView("chat");
      const draftKey = createDraftConversationKey();
      if (initialMessage) {
        pendingInitialMessageRef.current = { conversationKey: draftKey, content: initialMessage };
      }
      useConversationStore.getState().setActiveKey(draftKey);
      void navigate(routes.conversation(draftKey));
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
