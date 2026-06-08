
import { captureError } from "@/lib/sentry/capture-error";
import { useViewerStore } from "@/stores/viewer-store";

import {
    type MutableRefObject,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
} from "react";

import {
    createDraftConversationId,
    resolveBootstrappedConversationId,
    startDraftConversation,
} from "@/domains/chat/utils/conversation-selection";
import {
    loadLastViewedConversationId,
    saveLastViewedConversationId,
} from "@/utils/last-viewed-conversation-storage";
import { toast } from "@vellumai/design-library";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useConversationStore } from "@/stores/conversation-store";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";
import { useNavigate } from "react-router";

import { useConversationHistory } from "@/domains/chat/hooks/use-conversation-history";
import type { AssistantStateKind } from "@/domains/chat/types";
import { shouldSuppressGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";
import { useQueryClient } from "@tanstack/react-query";

import { useConversationListQuery } from "@/hooks/conversation-queries";
import { conversationGroupsQueryKey } from "@/lib/sync/query-tags";
import type { Conversation } from "@/types/conversation-types";
import { ApiError } from "@/utils/api-errors";
import { invalidateConversationQueries } from "@/utils/conversation-cache";
import { isBackgroundConversation } from "@/utils/conversation-predicates";

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

const CONVERSATION_LIST_INVALIDATED_DEBOUNCE_MS = 250;
const CONVERSATION_LIST_LOAD_FAILED_CODE = "CONVERSATION_LIST_LOAD_FAILED";

interface UseConversationLoaderParams {
  // Identity / routing
  assistantId: string | null;
  assistantStateKind: AssistantStateKind;
  activeConversationId: string | null;
  /** Conversation id from the URL path param (e.g. `/assistant/conversations/:conversationId`). */
  urlConversationId: string | null;
  searchParams: URLSearchParams;

  // The resolved row for the currently-open conversation, drawn from either
  // list cache (or fetched on demand). Used to decide whether the active
  // thread exists server-side; null while loading or for local-only drafts.
  activeConversation: Conversation | undefined;

  // Feature flags / epochs
  conversationGroupsUI: boolean;
  refreshEpoch: number;
  reachabilityReadyEpoch: number;

  // Infrastructure refs (not per-conversation state)
  onboardingDraftConversationIdRef: MutableRefObject<string | null>;
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
  urlConversationId,
  searchParams,
  activeConversation,
  conversationGroupsUI,
  refreshEpoch,
  reachabilityReadyEpoch,
  onboardingDraftConversationIdRef,
}: UseConversationLoaderParams) {
  const navigate = useNavigate();

  // -------------------------------------------------------------------------
  // Internal refs
  // -------------------------------------------------------------------------
  const assistantIdRef = useRef<string | null>(assistantId);
  useLayoutEffect(() => {
    assistantIdRef.current = assistantId;
  }, [assistantId]);
  const refreshConversationsRef = useRef<() => Promise<void>>(async () => {});
  const conversationListInvalidatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryClient = useQueryClient();

  // -------------------------------------------------------------------------
  // refreshConversations -- invalidate the cached conversation list + groups
  // so subscribed query consumers refetch. The active list query is mounted
  // by `ChatLayout` and `ChatPage`, so invalidation triggers a background
  // refetch through the same `listConversations` queryFn used at boot.
  // -------------------------------------------------------------------------
  const refreshConversations = useCallback(async () => {
    if (!assistantId) return;
    try {
      await invalidateConversationQueries(queryClient, assistantId);
    } catch (err) {
      captureError(err, { context: "refresh_conversations" });
    }
    if (conversationGroupsUI) {
      void queryClient
        .invalidateQueries({
          queryKey: conversationGroupsQueryKey(assistantId),
        })
        .catch((err) => {
          captureError(err, { context: "refreshGroups", level: "warning" });
        });
    }
  }, [assistantId, conversationGroupsUI, queryClient]);

  // Keep the ref in sync so the debounced scheduler always calls the latest.
  useLayoutEffect(() => {
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
  }, []);

  /** Cancel any pending debounced conversation list refetch. */
  const cancelScheduledRefetch = useCallback(() => {
    if (conversationListInvalidatedTimerRef.current) {
      clearTimeout(conversationListInvalidatedTimerRef.current);
      conversationListInvalidatedTimerRef.current = null;
    }
  }, []);

  // -------------------------------------------------------------------------
  // Conversation list query subscription
  //
  // The conversation list is owned by `useConversationListQuery`, which
  // fetches the foreground conversations for the given `assistantId`.
  // Background and scheduled jobs load separately via
  // `useBackgroundConversationListQuery`, gated on the sidebar revealing
  // those sections, so a large background backlog never blocks the initial
  // render. Sibling consumers in `ChatLayout` and `ChatPage` mount the same
  // foreground query — they all share one cache entry under
  // `conversationsQueryKey(assistantId)`, so dedupe and structural-sharing
  // are automatic.
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
  const conversationListQuery = useConversationListQuery(
    assistantId,
    assistantStateKind === "active",
  );
  const queryConversations = conversationListQuery.conversations;
  const conversationListIsPending = conversationListQuery.isPending;
  const conversationListError = conversationListQuery.error;
  const conversationListIsError = conversationListQuery.isError;

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
    void invalidateConversationQueries(queryClient, assistantId);
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
    if (conversationListError instanceof ApiError && conversationListError.status === 401) {
      toast.error("Failed to authenticate user.");
    }
  }, [conversationListError]);

  // -------------------------------------------------------------------------
  // Banner consumer
  //
  // Raise the conversation-list load-failed banner only when (a) the query
  // is in error state AND (b) we have no cached data to fall back on. A
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
      conversationListError instanceof ApiError && conversationListError.status === 401;
    const hasUsableData = queryConversations.length > 0;

    if (conversationListIsError && !hasUsableData && !isAuthFail) {
      captureError(conversationListError, {
        context: "conversationList.bootstrap",
        level: "warning",
      });
      useChatSessionStore.getState().setError((prev) => {
        if (shouldSuppressGenericChatErrorNotice(prev)) return prev;
        const status =
          conversationListError instanceof ApiError ? conversationListError.status : 0;
        return {
          code: CONVERSATION_LIST_LOAD_FAILED_CODE,
          message:
            status >= 500
              ? "We couldn't reach your assistant. We'll keep checking the connection."
              : "We couldn't load your conversations. Please refresh and try again.",
        };
      });
      return;
    }
    if (hasUsableData) {
      useChatSessionStore.getState().setError((prev) =>
        prev?.code === CONVERSATION_LIST_LOAD_FAILED_CODE ? null : prev,
      );
    }
  }, [
    assistantStateKind,
    queryConversations,
    conversationListError,
    conversationListIsError,
    shouldSuppressGenericChatErrorNotice,
  ]);

  // -------------------------------------------------------------------------
  // Bootstrap routing
  //
  // When conversation data arrives in the cache (from any source — this
  // hook's own subscription or a sibling subscriber that fetched first),
  // resolve the bootstrap conversation key and write it into the URL +
  // client store. Idempotent: `resolveBootstrappedConversationId` prefers
  // the currently-active key when one is set, so a refetch with the same
  // data shape (de-duped by React Query's structural sharing) does not
  // churn the route.
  //
  // This effect intentionally does not raise the banner — error handling
  // lives in the banner-consumer effect above. Decoupling lets the
  // routing logic run as soon as data is available, even if the *most
  // recent* fetch failed (we still have last-known-good data to land on).
  // -------------------------------------------------------------------------
  const lastAppliedUrlConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (assistantStateKind !== "active") return;
    if (!assistantId) return;

    const explicitConversationId = urlConversationId;

    // Only the "resume last-viewed" / "land on latest foreground" fallbacks
    // read the fetched list. An explicit URL key, an onboarding draft, or the
    // existing in-memory selection all resolve without it — so the chat
    // transcript the user opened renders immediately instead of blocking on
    // the sidebar's conversation-list API.
    const needsConversationList = !(
      explicitConversationId != null ||
      searchParams.get("onboarding") === "1" ||
      (assistantIdRef.current === assistantId &&
        useConversationStore.getState().activeConversationId != null)
    );
    if (needsConversationList && conversationListIsPending) {
      return;
    }

    // When only the conversation list changed (e.g. from resolveDraftKey's
    // setQueryData) but the URL hasn't changed, the URL key is stale —
    // a programmatic navigate() is in flight. Trust the store's
    // activeConversationId and let the URL catch up.
    if (
      explicitConversationId != null &&
      explicitConversationId === lastAppliedUrlConversationIdRef.current &&
      assistantIdRef.current === assistantId
    ) {
      return;
    }
    lastAppliedUrlConversationIdRef.current = explicitConversationId;

    // Compute the default landing conversation — prefer the latest
    // foreground conversation. Background/scheduled conversations live
    // behind a collapsed-by-default sidebar section and must never be
    // selected implicitly.
    const active = queryConversations.filter((c) => c.archivedAt == null);
    const latestForeground = active.find((c) => !isBackgroundConversation(c));
    const defaultConversationId = latestForeground
      ? latestForeground.conversationId
      : assistantId;

    let onboardingDraftConversationId: string | null = null;
    if (searchParams.get("onboarding") === "1") {
      onboardingDraftConversationIdRef.current ??= createDraftConversationId();
      onboardingDraftConversationId = onboardingDraftConversationIdRef.current;
    }
    const key = resolveBootstrappedConversationId({
      queryParamKey: explicitConversationId,
      onboardingDraftConversationId,
      currentConversationId: useConversationStore.getState().activeConversationId,
      currentAssistantId: assistantIdRef.current,
      nextAssistantId: assistantId,
      storedConversationId: loadLastViewedConversationId(assistantId),
      defaultConversationId,
      conversations: queryConversations,
    });

    useConversationStore.getState().setActiveConversationId(key);
    if (key) {
      void navigate(routes.conversation(key), { replace: true });
    }
  }, [
    queryConversations,
    conversationListIsPending,
    assistantId,
    assistantStateKind,
    urlConversationId,
    searchParams,
    navigate,
    assistantIdRef,
    onboardingDraftConversationIdRef,
  ]);

  // -------------------------------------------------------------------------
  // conversationExistsOnServer
  // -------------------------------------------------------------------------
  const conversationExistsOnServer = useMemo(
    () => activeConversation != null && !activeConversation.draft,
    [activeConversation],
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
  });

  // -------------------------------------------------------------------------
  // switchConversation
  // -------------------------------------------------------------------------
  const switchConversation = useCallback(
    (key: string) => {
      useSubagentStore.getState().reset();
      useViewerStore.getState().setMainView("chat");
      if (key === useConversationStore.getState().activeConversationId) return;
      void navigate(routes.conversation(key));
    },
    [navigate],
  );

  // -------------------------------------------------------------------------
  // startNewConversation
  // -------------------------------------------------------------------------
  const startNewConversation = useCallback(
    ({ silent }: { silent?: boolean } = {}) => {
      if (!silent) haptic.light();
      useSubagentStore.getState().reset();
      useViewerStore.getState().setMainView("chat");
      const draftConversationId = startDraftConversation(queryClient, assistantId);
      void navigate(routes.conversation(draftConversationId));
      requestComposerFocus();
    },
    [navigate, assistantId, queryClient],
  );

  return {
    refreshConversations,
    scheduleConversationListRefetch,
    cancelScheduledRefetch,
    switchConversation,
    startNewConversation,
    conversationExistsOnServer,
    historyResult,
  };
}
