import { t } from "@/i18n";
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
  resolvePreselectedConversationId,
  shouldMintNewChatDraft,
} from "@/domains/chat/utils/conversation-selection";
import {
  loadLastViewedConversationId,
  saveLastViewedConversationId,
} from "@/utils/last-viewed-conversation-storage";
import { toast } from "@vellumai/design-library";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { isNativeMobile } from "@/runtime/platform-detection";
import { useConversationStore } from "@/stores/conversation-store";
import { haptic } from "@/utils/haptics";
import { revealConversationView } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";
import { useNavigate } from "react-router";

import { useConversationHistory } from "@/domains/chat/hooks/use-conversation-history";
import { useTurnTimeout } from "@/domains/chat/hooks/use-turn-timeout";
import type { AssistantStateKind } from "@/domains/chat/types";
import { shouldSuppressGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";
import { useQueryClient } from "@tanstack/react-query";

import {
  useCanQueryDaemon,
  useConversationListQuery,
} from "@/hooks/conversation-queries";
import { useResumeGrace } from "@/hooks/use-resume-grace";
import { groupsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { resolveLandingConversation } from "@/domains/chat/utils/landing-conversation";
import type { Conversation } from "@/types/conversation-types";
import { ApiError } from "@/utils/api-errors";
import { invalidateConversationQueries } from "@/utils/conversation-cache";

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

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

  // Epochs
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
 * transcript. Returns `startNewConversation` and `refreshConversations` for
 * use by sibling hooks.
 *
 * Delegates to:
 * - `useConversationHistory` -- conversation switch, cache, and history loading
 * - `useTurnTimeout` -- terminates a turn whose stream went silent
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
  const queryClient = useQueryClient();

  // -------------------------------------------------------------------------
  // refreshConversations -- invalidate the cached conversation list + groups
  // so subscribed query consumers refetch. The active list query is mounted
  // by `ChatLayout` and `ChatPage`, so invalidation triggers a background
  // refetch through the same `conversationListOptions` queryFn used at boot.
  // -------------------------------------------------------------------------
  const refreshConversations = useCallback(async () => {
    if (!assistantId) {
      return;
    }
    try {
      await invalidateConversationQueries(queryClient, assistantId);
    } catch (err) {
      captureError(err, { context: "refresh_conversations" });
    }
    void queryClient
      .invalidateQueries({
        queryKey: groupsGetQueryKey({ path: { assistant_id: assistantId } }),
      })
      .catch((err) => {
        captureError(err, { context: "refreshGroups", level: "warning" });
      });
  }, [assistantId, queryClient]);

  // -------------------------------------------------------------------------
  // Conversation list query subscription
  //
  // The conversation list is owned by `useConversationListQuery`, which
  // fetches the foreground conversations for the given `assistantId`.
  // Background and scheduled jobs load separately via
  // `useBackgroundConversationListQuery`, gated on the sidebar revealing
  // those sections, so a large background backlog never blocks the initial
  // render. Sibling consumers in `ChatLayout` and `ChatPage` mount the same
  // foreground query; they all share one cache entry under
  // `conversationListQueryKey(assistantId)`, so dedupe and structural-sharing
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
    if (assistantStateKind !== "active" || !assistantId) {
      return;
    }
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
    if (
      conversationListError instanceof ApiError &&
      conversationListError.status === 401
    ) {
      toast.error(t("chat:useConversationLoader.authFailed"));
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
  //
  // A failure inside the resume grace window is held back: the refetch that
  // fires when the client returns from the background often fails transiently
  // against a still-waking pod. The banner surfaces once the window expires
  // and the query is still in error with nothing cached.
  // -------------------------------------------------------------------------
  const isResumeGraceActive = useResumeGrace();
  useEffect(() => {
    if (assistantStateKind !== "active") {
      return;
    }
    const isAuthFail =
      conversationListError instanceof ApiError &&
      conversationListError.status === 401;
    const hasUsableData = queryConversations.length > 0;

    if (conversationListIsError && !hasUsableData && !isAuthFail) {
      captureError(conversationListError, {
        context: "conversationList.bootstrap",
        level: "warning",
      });
      if (isResumeGraceActive) {
        return;
      }
      useChatSessionStore.getState().setError((prev) => {
        if (shouldSuppressGenericChatErrorNotice(prev)) {
          return prev;
        }
        const status =
          conversationListError instanceof ApiError
            ? conversationListError.status
            : 0;
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
      useChatSessionStore
        .getState()
        .setError((prev) =>
          prev?.code === CONVERSATION_LIST_LOAD_FAILED_CODE ? null : prev,
        );
    }
  }, [
    assistantStateKind,
    queryConversations,
    conversationListError,
    conversationListIsError,
    isResumeGraceActive,
    shouldSuppressGenericChatErrorNotice,
  ]);

  // -------------------------------------------------------------------------
  // Bootstrap routing
  //
  // Resolve the bootstrap conversation key and write it into the URL +
  // client store. An explicit URL key, an onboarding draft, the existing
  // in-memory selection, or a new-chat draft resolve synchronously. Only the
  // cold-load fallbacks (resume last-viewed, else land on newest) need the
  // server, and they ask it two single-row questions rather than waiting on
  // the drained conversation list, whose length grows with the account. The
  // async branch discards its answer if the assistant or the URL moved on
  // while it was in flight.
  //
  // This effect intentionally does not raise the banner; error handling
  // lives in the banner-consumer effect above.
  // -------------------------------------------------------------------------
  const lastAppliedUrlConversationIdRef = useRef<string | null>(null);
  /* The same gate every daemon query honors: org header available and the
     pod serving. A waking pod 503s every request, so the landing lookups
     wait for the gate rather than spend their retries against it; the
     effect re-runs when the gate opens. */
  const canQueryDaemon = useCanQueryDaemon(assistantId);
  useEffect(() => {
    if (assistantStateKind !== "active") {
      return;
    }
    if (!assistantId) {
      return;
    }

    const explicitConversationId = urlConversationId;
    const currentConversationId =
      useConversationStore.getState().activeConversationId;

    // Native mobile shells cold-launch into a fresh draft instead of
    // resuming a conversation. A draft is minted only while nothing is selected
    // in the URL or the store, and the minting pass writes the key to the store
    // in the same body, so the gate closes for the rest of the session.
    const newChatDraftConversationId = shouldMintNewChatDraft({
      platformStartsInNewChat: isNativeMobile(),
      urlConversationId: explicitConversationId,
      currentConversationId,
    })
      ? createDraftConversationId()
      : null;

    // A programmatic navigate() may be in flight for the key already applied
    // from the URL; trust the store's activeConversationId and let the URL
    // catch up.
    if (
      explicitConversationId != null &&
      explicitConversationId === lastAppliedUrlConversationIdRef.current &&
      assistantIdRef.current === assistantId
    ) {
      return;
    }
    lastAppliedUrlConversationIdRef.current = explicitConversationId;

    let onboardingDraftConversationId: string | null = null;
    if (searchParams.get("onboarding") === "1") {
      onboardingDraftConversationIdRef.current ??= createDraftConversationId();
      onboardingDraftConversationId = onboardingDraftConversationIdRef.current;
    }

    const apply = (key: string) => {
      useConversationStore.getState().setActiveConversationId(key);
      void navigate(routes.conversation(key), { replace: true });
    };
    const preselected = {
      queryParamKey: explicitConversationId,
      onboardingDraftConversationId,
      newChatDraftConversationId,
      currentConversationId,
      currentAssistantId: assistantIdRef.current,
      nextAssistantId: assistantId,
    };
    const preselectedId = resolvePreselectedConversationId(preselected);
    if (preselectedId) {
      apply(preselectedId);
      return;
    }
    if (!canQueryDaemon) {
      /* Nothing to decide yet; the deps re-run this once the daemon is
         reachable, and with no URL key applied the fallback is reached
         again rather than frozen behind an explicit one. */
      return;
    }

    let stale = false;
    void resolveLandingConversation(
      queryClient,
      assistantId,
      loadLastViewedConversationId(assistantId),
    )
      .then((landing) => {
        if (stale) {
          return;
        }
        /* Something selected a conversation while the lookups ran (a deep
           link, a draft); it outranks both fallbacks. */
        if (useConversationStore.getState().activeConversationId != null) {
          return;
        }
        apply(
          resolveBootstrappedConversationId({
            ...preselected,
            storedConversation: landing.storedConversation,
            // Background/scheduled conversations live behind a
            // collapsed-by-default sidebar section and must never be selected
            // implicitly, so the newest *foreground* row is the default, and
            // the assistant itself when it has none.
            defaultConversationId: landing.latestForegroundId ?? assistantId,
          }),
        );
      })
      .catch((error: unknown) => {
        if (stale) {
          return;
        }
        /* The list-load banner reports the outage; landing on the
           assistant itself is the same terminal fallback the drained list
           reaches when it cannot load. */
        captureError(error, {
          context: "conversationList.landing",
          bestEffort: true,
        });
        if (useConversationStore.getState().activeConversationId == null) {
          apply(assistantId);
        }
      });
    return () => {
      stale = true;
    };
  }, [
    assistantId,
    assistantStateKind,
    canQueryDaemon,
    urlConversationId,
    searchParams,
    navigate,
    queryClient,
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
    if (!assistantId || !activeConversationId) {
      return;
    }
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
  // Delegate: stranded-turn watchdog. Terminates a turn whose stream went
  // silent and revalidates history so the UI settles on server truth.
  // -------------------------------------------------------------------------
  useTurnTimeout({ assistantId, activeConversationId });

  // -------------------------------------------------------------------------
  // startNewConversation
  // -------------------------------------------------------------------------
  const startNewConversation = useCallback(
    ({ silent }: { silent?: boolean } = {}) => {
      if (!silent) {
        haptic.light();
      }
      useSubagentStore.getState().reset();
      useWorkflowStore.getState().reset();
      useViewerStore.getState().clearTranscriptPanelPayloads();
      const draftConversationId = createDraftConversationId();
      revealConversationView(draftConversationId);
      useConversationStore
        .getState()
        .setActiveConversationId(draftConversationId);
      void navigate(routes.conversation(draftConversationId));
      requestComposerFocus();
    },
    [navigate],
  );

  return {
    refreshConversations,
    startNewConversation,
    conversationExistsOnServer,
    historyResult,
  };
}
