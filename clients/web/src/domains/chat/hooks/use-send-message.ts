/**
 * Handles sending user messages, managing the stream lifecycle, and
 * queue operations (cancel, delete, edit).
 *
 * Orchestrates: optimistic message insertion, draft key resolution,
 * stream creation via `postChatMessage`/`pollForResponse`, and
 * processing-key tracking.
 *
 * Composes `useMessageQueue` for queue management and imports pure
 * transforms from `send-message-utils`.
 */

import { captureError } from "@/lib/sentry/capture-error";
import {
  type MutableRefObject,
  useCallback,
  useRef,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "@vellumai/design-library/components/toast";
import { routes } from "@/utils/routes";
import { conversationsByIdSlashPost } from "@/generated/daemon/sdk.gen";
import { isLocalMetaCommand } from "@/domains/chat/components/chat-composer/slash-command-catalog";
import { saveContextWindowUsage } from "@/domains/chat/utils/context-window-storage";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator";

import type {
  DisplayAttachment,
  DisplayMessage,
} from "@/domains/chat/types/types";
import { conversationHistoryQueryKey } from "@/domains/chat/transcript/use-history-pagination";
import { patchTranscriptMessages } from "@/domains/chat/transcript/patch-transcript-messages";
import { recordLocalSeq } from "@/lib/streaming/local-seq";
import { isAsyncChatScopeCurrent } from "@/domains/chat/utils/conversation-scope";
import { resolveEditChatDraftConversationId } from "@/utils/edit-chat-session";
import { type DiskPressureChatBlockReason, getDiskPressureChatBlockMessage } from "@/assistant/disk-pressure";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { recordDiagnostic } from "@/lib/diagnostics";
import { saveDismissedSurfaceIds } from "@/domains/chat/utils/dismissed-surfaces-storage";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import { endTurn } from "@/domains/chat/turn-coordinator";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useConversationStore } from "@/stores/conversation-store";
import {
  prependConversation,
  removeConversation,
  resolveDraftKey,
  shouldSurfaceConversationOnUserSend,
  surfaceConversationInCaches,
} from "@/utils/conversation-cache-mutations";
import { findConversation, patchConversation } from "@/utils/conversation-cache";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import {
  consumePendingPreChatContext,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat";

import { clearQueueStatus } from "@/domains/chat/utils/stream-updaters/shared";
import { mapRuntimeToDisplayMessage } from "@/domains/chat/utils/map-runtime-message";
import { attachConfirmationToToolCall } from "@/domains/chat/utils/chat";
import type { ChatError } from "@/domains/chat/types";

import {
  clearPendingConfirmationsFromMessages,
  dismissInteractiveSurfaces,
  newTurnId,
  parsePendingConfirmationData,
  parsePendingSecretState,
  resolvePostError,
  shouldCleanupSupersededInteractions,
} from "@/domains/chat/utils/send-message-utils";
import type { UIContext } from "@/domains/chat/turn-selectors";
import { useComposerStore } from "@/domains/chat/composer-store";
import { getSoundManager } from "@/lib/sounds/sound-manager";
import { useMessageQueue } from "@/domains/chat/hooks/use-message-queue";
import { conversationsByIdCancelPost } from "@/generated/daemon/sdk.gen";
import type { Conversation } from "@/types/conversation-types";
import { getPendingInteractions } from "@/domains/chat/api/interactions";
import {
  fetchConversationMessages,
  postChatMessage,
  pollForResponse,
  RECONCILE_LATEST_PAGE_LIMIT,
} from "@/domains/chat/api/messages";
import { surfaceConversation } from "@/domains/chat/api/conversations";
import { supportsServerMintedConversation } from "@/lib/backwards-compat/server-minted-conversation";
import { resolveSupportsNewChatPlugins } from "@/lib/backwards-compat/use-supports-new-chat-plugins";
import {
  ConversationNotFoundError,
  fetchConversationDetail,
} from "@/utils/fetch-conversation-detail";

// ---------------------------------------------------------------------------
// Stream send result
// ---------------------------------------------------------------------------

/**
 * Tagged result of `sendMessageViaStream`. Surfaced to the caller so it can
 * differentiate clean success, in-flight scope changes (ignore), and POST
 * failures (which require optimistic-state rollback).
 *
 * Previously the hook returned `string | undefined` and called `setError`
 * directly, which made it impossible for the caller to roll back the
 * optimistic user-message bubble or remove the just-prepended draft
 * conversation from the sidebar.
 */
type SendStreamResult =
  | {
      status: "ok";
      resolvedConversationId?: string;
      /** Server-assigned user message id from the active POST resolve.
       *  Absent for the queued path (POST returns only `requestId`) and
       *  for scope-changed-mid-flight results. The optimistic send is no
       *  longer id-swapped against this — the snapshot's echoed row and the
       *  overlay's `clientMessageId` dedup own that — so this is retained only
       *  for diagnostics / callers that want the persisted id. */
      userMessageId?: string;
    }
  | { status: "ignored" }
  | { status: "failed"; error: ChatError };

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

interface UseSendMessageParams {
  // Identity
  assistantId: string | null;
  activeConversationId: string | null;
  diskPressureChatBlockReason: DiskPressureChatBlockReason | null;
  uiContextRef: MutableRefObject<UIContext | null>;

  // Onboarding refs (ChatPage-local, not per-conversation)
  pendingOnboardingContextRef: MutableRefObject<PreChatOnboardingContext | null>;
  onboardingDraftConversationIdRef: MutableRefObject<string | null>;

  // Callbacks
  startReconciliationLoop: (epoch: number) => void;
  cancelReconciliation: () => void;
  refreshConversations: () => Promise<void>;

}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSendMessage({
  assistantId,
  activeConversationId,
  diskPressureChatBlockReason,
  uiContextRef,
  pendingOnboardingContextRef,
  onboardingDraftConversationIdRef,
  startReconciliationLoop,
  cancelReconciliation,
  refreshConversations,
}: UseSendMessageParams) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const addOptimisticSend = useChatSessionStore.use.addOptimisticSend();
  const setOptimisticSends = useChatSessionStore.use.setOptimisticSends();
  const setError = useChatSessionStore.use.setError();
  const setNotice = useChatSessionStore.use.setNotice();

  // -------------------------------------------------------------------------
  // Server-mint in-flight gate
  // -------------------------------------------------------------------------
  // Holds the draft id of an in-flight server-mint POST (the FIRST
  // message in a brand-new conversation on an assistant that supports
  // `supportsServerMintedConversation()`). While set, `sendMessage`
  // refuses to start a new send — the POST 200s quickly so the window
  // is brief, and blocking is simpler than threading a deferred
  // through the queue path.
  //
  // Without this gate, a follow-up send during the window would post
  // the local draft key to a 0.8.6+ assistant's strict-lookup endpoint
  // and 404 (the assistant minted a different id).
  //
  // Cleared after the POST resolves or rejects. The draft-id check on
  // clear guards against re-mounts overwriting a newer mint.
  const pendingDraftMintRef = useRef<string | null>(null);
  const surfacingConversationIdsRef = useRef<Set<string>>(new Set());

  // -------------------------------------------------------------------------
  // Queue management (delegated to useMessageQueue)
  // -------------------------------------------------------------------------
  const {
    revertQueuedMessage,
    queuedMessages,
    handleCancelQueuedMessage,
    handleCancelAllQueued,
    handleSteerMessage,
    handleEditQueueTail,
  } = useMessageQueue({
    assistantId,
    activeConversationId,
  });

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  /**
   * Persist dismissed surface IDs to both the in-memory ref and local
   * storage. Extracted so optimistic-send updaters stay pure.
   */
  const persistDismissedSurfaces = useCallback(
    (dismissedIds: Set<string>) => {
      useChatSessionStore.getState().addDismissedSurfaceIds(dismissedIds);
      const streamCtx = useStreamStore.getState().streamContext;
      if (streamCtx) {
        saveDismissedSurfaceIds(
          streamCtx.assistantId,
          streamCtx.conversationId,
          useChatSessionStore.getState().dismissedSurfaceIds,
        );
      }
    },
    [],
  );

  const surfaceConversationAfterUserSend = useCallback(
    async (conversationId: string) => {
      if (!assistantId) return;
      if (surfacingConversationIdsRef.current.has(conversationId)) return;

      let conversation = findConversation(
        queryClient,
        assistantId,
        conversationId,
      );
      if (!conversation) {
        try {
          conversation = await fetchConversationDetail(
            queryClient,
            assistantId,
            conversationId,
          );
        } catch (err) {
          if (err instanceof ConversationNotFoundError) return;
          throw err;
        }
      }

      if (!shouldSurfaceConversationOnUserSend(conversation)) return;

      surfacingConversationIdsRef.current.add(conversationId);
      try {
        const surfacedAt = await surfaceConversation(assistantId, conversationId);
        surfaceConversationInCaches(
          queryClient,
          assistantId,
          conversation,
          surfacedAt,
        );
      } finally {
        surfacingConversationIdsRef.current.delete(conversationId);
      }
    },
    [assistantId, queryClient],
  );

  // -------------------------------------------------------------------------
  // sendMessageViaStream — low-level POST + polling fallback
  // -------------------------------------------------------------------------
  const sendMessageViaStream = useCallback(
    async (content: string, epoch: number, turnId: string, attachmentIds: string[] = [], isDraft = false, clientMessageId?: string, isHidden = false): Promise<SendStreamResult> => {
      if (!activeConversationId || !assistantId) {
        return {
          status: "failed",
          error: { message: "No active conversation. Please try again." },
        };
      }
      const requestAssistantId = assistantId;
      const requestConversationId = activeConversationId;
      const isCurrentSendScope = (resolvedConversationId?: string | null) =>
        isAsyncChatScopeCurrent({
          currentAssistantId: useResolvedAssistantsStore.getState().activeAssistantId,
          currentConversationId: useConversationStore.getState().activeConversationId,
          requestAssistantId,
          requestConversationId,
          resolvedConversationId,
        });

      const onboardingContext =
        pendingOnboardingContextRef.current ?? consumePendingPreChatContext();
      if (onboardingContext && !pendingOnboardingContextRef.current) {
        pendingOnboardingContextRef.current = onboardingContext;
      }
      // Server-minted flow: when the conversation is a fresh client-side
      // draft AND the assistant supports server-side minting, send the
      // POST without any conversation id wire field. The assistant mints
      // a row and returns its id as `postResult.conversationId`; the
      // existing draft-key-resolution code path below swaps the
      // optimistic state and navigates the URL. Falling back to the
      // assistant-known `requestConversationId` for non-drafts or
      // pre-0.8.6 assistants preserves the legacy `conversationKey`
      // create-or-lookup behavior through `pickConversationIdWireField()`.
      const useServerMint = isDraft && supportsServerMintedConversation();
      // While this POST is in flight, `sendMessage` rejects new sends
      // for this draft — see `pendingDraftMintRef` declaration above.
      if (useServerMint) {
        pendingDraftMintRef.current = requestConversationId;
      }
      // A model profile the user picked in the composer before this
      // conversation's row was available — a brand-new draft, or an existing
      // conversation opened by URL while still loading (see
      // `ComposerSettingsMenu`). Forward it so this turn, and the conversation's
      // per-conversation override, use the chosen profile instead of the global
      // default — covering the window before the menu's load-time promotion PUT
      // lands. Keyed by id, so only this conversation's own stash is read.
      const inferenceProfileForSend = useConversationStore
        .getState()
        .pendingDraftProfiles.get(requestConversationId);
      // A per-chat plugin set the user picked in the composer before this
      // conversation's row existed — mirrors `inferenceProfileForSend`. Only an
      // EXPLICIT selection (an entry in the map, including an empty set) is
      // forwarded; an untouched default has no entry and sends `undefined`.
      // Gated on resolved daemon support — older daemons silently drop the
      // field, so the version must hydrate before deciding (see
      // `use-supports-new-chat-plugins`).
      const draftPlugins = useConversationStore
        .getState()
        .pendingDraftPlugins.get(requestConversationId);
      const enabledPluginsForSend =
        draftPlugins && (await resolveSupportsNewChatPlugins())
          ? [...draftPlugins].sort()
          : undefined;
      const postResult = await postChatMessage(
        requestAssistantId,
        useServerMint ? null : requestConversationId,
        content,
        {
          attachmentIds,
          onboarding: onboardingContext ?? undefined,
          clientMessageId,
          inferenceProfile: inferenceProfileForSend,
          enabledPlugins: enabledPluginsForSend,
          hidden: isHidden,
        },
      );
      if (
        useServerMint &&
        pendingDraftMintRef.current === requestConversationId
      ) {
        // Clear only if we still own the gate. A re-mount or scope flip
        // during the await could have already replaced it with a newer
        // draft's mint.
        pendingDraftMintRef.current = null;
      }
      if (!postResult.ok) {
        if (!isCurrentSendScope()) {
          recordDiagnostic("send_error_ignored_inactive_conversation", {
            assistantId: requestAssistantId,
            conversationId: requestConversationId,
            activeAssistantId: useResolvedAssistantsStore.getState().activeAssistantId,
            activeConversationId: useConversationStore.getState().activeConversationId,
          });
          return { status: "ignored" };
        }
        const detail = resolvePostError(
          postResult.error.code,
          postResult.error.detail,
          "Something went wrong. Please try again.",
        );
        endTurn({ conversationId: requestConversationId, reason: "error" });
        return {
          status: "failed",
          error: {
            message: detail,
            ...(postResult.error.code ? { code: postResult.error.code } : {}),
          },
        };
      }
      // Success — drain the ref so subsequent messages omit the field.
      pendingOnboardingContextRef.current = null;
      // The draft's stashed profile (if any) has now been persisted on the
      // minted conversation; drop this draft's entry so it can't re-apply to a
      // later send. Cleared only on success — a failed draft send keeps the
      // stash so a retry still carries the chosen profile.
      if (inferenceProfileForSend) {
        useConversationStore
          .getState()
          .clearPendingDraftProfile(requestConversationId);
      }
      // Same lifecycle as the profile stash: the draft's plugin selection has
      // now been persisted on the minted conversation, so drop this draft's
      // entry. Cleared only on success — a failed send keeps the stash so a
      // retry still carries the chosen plugins.
      if (draftPlugins) {
        useConversationStore
          .getState()
          .clearPendingDraftPlugins(requestConversationId);
      }
      if (onboardingDraftConversationIdRef.current === activeConversationId) {
        onboardingDraftConversationIdRef.current = null;
      }

      if (isCurrentSendScope()) {
        useTurnStore.getState().acceptSend(turnId);
      }

      // `postChatMessage`'s success contract guarantees a non-empty
      // `conversationId` — the server-mint path explicitly returns a
      // failure when the assistant accepts the message without echoing
      // a conversation id back, so by the time we get here it must be
      // a real id. The typecheck enforces this; the explicit
      // `effectiveConversationId` alias preserves the existing names
      // used downstream.
      const effectiveConversationId = postResult.conversationId;

      if (!isCurrentSendScope(effectiveConversationId)) {
        recordDiagnostic("send_result_ignored_inactive_conversation", {
          assistantId: postResult.assistantId,
          conversationId: requestConversationId,
          resolvedConversationId: effectiveConversationId,
          activeAssistantId: useResolvedAssistantsStore.getState().activeAssistantId,
          activeConversationId: useConversationStore.getState().activeConversationId,
        });
        return {
          status: "ok",
          resolvedConversationId: postResult.conversationId,
        };
      }

      void surfaceConversationAfterUserSend(effectiveConversationId).catch(
        (err) => {
          captureError(err, { context: "surface_conversation_after_send" });
        },
      );

      const streamState = useStreamStore.getState();
      const existingStreamContext = streamState.streamContext;
      const hasMatchingActiveStream =
        !!streamState.stream &&
        existingStreamContext?.assistantId === postResult.assistantId &&
        existingStreamContext.conversationId === effectiveConversationId;

      streamState.setStreamContext({
        assistantId: postResult.assistantId,
        conversationId: effectiveConversationId,
      });

      if (postResult.queued) {
        // The client believed the conversation was idle (so it took the
        // active-send path), but the assistant was still processing and
        // queued this message instead. Reflect the queued state on the
        // optimistic row so it renders with queued affordances rather than
        // as a normal in-flight send: tag it `queueStatus: "queued"`, track
        // it in the pending-queue FIFO so the `message_queued` SSE event can
        // assign its real position, and register the request id eagerly so
        // steer/cancel work before the event arrives. Mirrors the
        // willQueue path in `sendMessage`.
        if (clientMessageId) {
          useChatSessionStore
            .getState()
            .pushPendingQueuedMessageId(clientMessageId);
          setOptimisticSends((prev) =>
            prev.map((m) =>
              m.id === clientMessageId
                ? {
                    ...m,
                    queueStatus: "queued" as const,
                    queuePosition: m.queuePosition ?? 0,
                  }
                : m,
            ),
          );
          if (postResult.requestId) {
            useChatSessionStore
              .getState()
              .setRequestIdMapping(postResult.requestId, clientMessageId);
          }
        }
        return {
          status: "ok",
          resolvedConversationId: postResult.conversationId,
        };
      }
      if (hasMatchingActiveStream) {
        return {
          status: "ok",
          userMessageId: postResult.messageId,
          resolvedConversationId: postResult.conversationId,
        };
      }

      if (isHidden) {
        // Hidden sends (e.g. the onboarding "Let's chat" kickoff) never
        // materialize a user row in `/messages` — the daemon suppresses it
        // (see `conversation-routes.ts`) — so `pollForResponse`'s causal
        // boundary (find the user message, then the assistant reply after it)
        // can never match: the poll would spin the full timeout and then
        // fire a spurious "Assistant did not respond in time." error even
        // though the proactive greeting streamed in fine over SSE. Skip the
        // poll entirely and lean on the reconciliation loop, which pulls the
        // latest snapshot without needing a user-message boundary and folds
        // the greeting in if the SSE stream dropped it.
        startReconciliationLoop(epoch);
        return {
          status: "ok",
          userMessageId: postResult.messageId,
          resolvedConversationId: postResult.conversationId,
        };
      }

      pollForResponse(postResult.assistantId, postResult.messageId, effectiveConversationId)
        .then(async (reply) => {
          if (!isCurrentSendScope(effectiveConversationId)) {
            recordDiagnostic("poll_response_ignored_inactive_conversation", {
              assistantId: postResult.assistantId,
              conversationId: requestConversationId,
              resolvedConversationId: effectiveConversationId,
              activeAssistantId: useResolvedAssistantsStore.getState().activeAssistantId,
              activeConversationId: useConversationStore.getState().activeConversationId,
            });
            return;
          }
          let restoredConfData: Parameters<typeof attachConfirmationToToolCall>[1] | null = null;
          try {
            const interactions = await getPendingInteractions(
              postResult.assistantId,
              effectiveConversationId,
            );
            if (!isCurrentSendScope(effectiveConversationId)) return;
            if (interactions.pendingSecret) {
              useInteractionStore.getState().showSecret(parsePendingSecretState(interactions.pendingSecret));
              if (!reply) return;
            }
            if (interactions.pendingConfirmation) {
              const { confData, state } = parsePendingConfirmationData(interactions.pendingConfirmation);
              restoredConfData = confData;
              useInteractionStore.getState().showConfirmation(state);
              if (!reply) return;
            }
          } catch {
            // Best-effort
          }

          if (!reply) {
            setError({ message: "Assistant did not respond in time." });
            return;
          }
          let serverSeq: number | null = null;
          try {
            const snapshot = await fetchConversationMessages(
              postResult.assistantId,
              effectiveConversationId,
              { latestPageLimit: RECONCILE_LATEST_PAGE_LIMIT },
            );
            serverSeq = snapshot?.seq ?? null;
          } catch {
            // Reconciliation is best-effort
          }
          if (!isCurrentSendScope(effectiveConversationId)) return;
          // Advance the local seq frontier — we've observed this snapshot.
          recordLocalSeq(effectiveConversationId, serverSeq);
          // No active SSE stream delivered this turn (poll fallback): fold the
          // polled reply onto the materialized snapshot immediately, then pull
          // the authoritative server view into the history cache, which reseeds
          // the snapshot. Upsert by id so a reply a late event already folded
          // isn't duplicated.
          useChatSessionStore.getState().patchSnapshotMessages((prev) => {
            const mapped = mapRuntimeToDisplayMessage(reply);
            const existingIdx = prev.findIndex((m) => m.id === reply.id);
            if (existingIdx >= 0) {
              const existing = prev[existingIdx];
              const updated = [...prev];
              updated[existingIdx] = {
                ...mapped,
                timestamp: existing?.timestamp ?? mapped.timestamp ?? Date.now(),
              };
              return updated;
            }
            return [
              ...prev,
              { ...mapped, timestamp: mapped.timestamp ?? Date.now() },
            ];
          });
          void queryClient.invalidateQueries({
            queryKey: conversationHistoryQueryKey(
              postResult.assistantId,
              effectiveConversationId,
            ),
          });
          if (restoredConfData && isCurrentSendScope(effectiveConversationId)) {
            const capturedConfData = restoredConfData;
            // Zustand set() is synchronous — the snapshot already reflects the
            // patch above, so getState() gives us fresh messages.
            const currentMessages =
              useChatSessionStore.getState().snapshot?.messages ?? [];
            const result = attachConfirmationToToolCall(currentMessages, capturedConfData);
            if (result.attachedToolCallId) {
              useInteractionStore.getState().setInlineConfirmationToolCallId(result.attachedToolCallId);
              useChatSessionStore.getState().setConfirmationToolCall(capturedConfData.requestId, result.attachedToolCallId);
            } else {
              useInteractionStore.getState().setInlineConfirmationToolCallId(null);
            }
            useChatSessionStore.getState().patchSnapshotMessages(() => result.updatedMessages);
          }
          startReconciliationLoop(epoch);
        })
        .catch((err) => {
          if (!isCurrentSendScope(effectiveConversationId)) return;
          captureError(err, { context: "send_message_stream" });
          setError({ message: "Connection lost. Please try again." });
        })
        .finally(() => {
          if (!isCurrentSendScope(effectiveConversationId)) return;
          // Defense-in-depth: settle the turn if SSE didn't already.
          // `onPollReconciled` no-ops when the turn is already idle, so
          // this is safe to call alongside the SSE terminal handlers.
          endTurn({
            conversationId: effectiveConversationId,
            reason: "rescued",
            rescuedTurnId: turnId,
          });
        });

      return {
        status: "ok",
        userMessageId: postResult.messageId,
        resolvedConversationId: postResult.conversationId,
      };
    },
    [
      activeConversationId,
      assistantId,
      startReconciliationLoop,
      surfaceConversationAfterUserSend,
    ],
  );

  // -------------------------------------------------------------------------
  // runLocalMetaCommand — resolve a local meta slash command without a turn
  // -------------------------------------------------------------------------
  const runLocalMetaCommand = useCallback(
    async (
      command: string,
      conversationId: string,
      activeAssistantId: string,
    ) => {
      try {
        const { data, error } = await conversationsByIdSlashPost({
          path: { assistant_id: activeAssistantId, id: conversationId },
          body: { command: command.trim() },
          throwOnError: false,
        });
        if (error || !data) {
          toast.error("Couldn't run that command. Please try again.");
          return;
        }
        useChatSessionStore.getState().addEphemeralMetaResult({
          id: crypto.randomUUID(),
          kind: data.kind,
          text: data.text,
        });
        if (data.contextUsage) {
          const usage: ContextWindowUsage = {
            tokens: data.contextUsage.tokens,
            maxTokens: data.contextUsage.maxTokens,
            fillRatio: data.contextUsage.fillRatio,
          };
          useChatSessionStore
            .getState()
            .setContextWindowUsageForConversation(conversationId, usage);
          useChatSessionStore.getState().setContextWindowUsage(usage);
          saveContextWindowUsage(activeAssistantId, conversationId, usage);
        }
      } catch (err) {
        captureError(err, { context: "run_local_meta_command" });
        toast.error("Couldn't run that command. Please try again.");
      }
    },
    [],
  );

  // -------------------------------------------------------------------------
  // sendMessage — high-level send with UI state, queuing, draft resolution
  // -------------------------------------------------------------------------
  const sendMessage = useCallback(
    async (
      content: string,
      attachments: DisplayAttachment[] = [],
      opts: { hidden?: boolean } = {},
    ) => {
      // A hidden send (e.g. the onboarding "Let's chat" kickoff) drives a turn
      // and the assistant's reply, but renders NO user bubble: skip the
      // optimistic row here and the daemon suppresses the echo. Hidden sends are
      // always a fresh first message (conversation idle), so they never take the
      // queue path below.
      const isHidden = opts.hidden === true;
      if (!activeConversationId || !assistantId) {
        setError({ message: "No active conversation. Please try again." });
        return;
      }
      // Block any send while a server-mint POST is in flight for the
      // active draft. The POST 200s quickly so this window is brief;
      // rejecting is simpler than threading the unresolved id through
      // the queue path. See `pendingDraftMintRef` declaration.
      if (pendingDraftMintRef.current === activeConversationId) {
        setError({
          message: "Setting up your conversation. Please try again in a moment.",
        });
        return;
      }
      if (diskPressureChatBlockReason) {
        setError({
          message: getDiskPressureChatBlockMessage(
            diskPressureChatBlockReason,
          ),
        });
        return;
      }
      setError(null);
      setNotice(null);
      // Local meta commands (/clean, /status, /commands, /models) never start a
      // turn: resolve them via the daemon and render an ephemeral card.
      if (isLocalMetaCommand(content)) {
        await runLocalMetaCommand(content, activeConversationId, assistantId);
        return;
      }
      // A real send supersedes any ephemeral meta-command cards.
      useChatSessionStore.getState().clearEphemeralMetaResults();
      useInteractionStore.getState().resetSecretAndConfirmation();
      useChatSessionStore.getState().clearConfirmationToolCallMap();
      // Clear pending confirmations and dismiss interactive surfaces in a
      // single functional updater so the two transforms compose correctly
      // within React 18's batched state updates. Side effects (ref mutation,
      // localStorage persist) are kept outside the updater to stay pure.
      // Scan the full rendered transcript — the materialized snapshot, which
      // holds both persisted history and the just-streamed turn — for
      // superseded interactive surfaces and pending confirmations, so a
      // resubmit can't act on a request the daemon already resolved. The
      // clear + dismiss transform is applied via patchTranscriptMessages (a
      // no-op for rows it doesn't match) to both the snapshot and the history
      // cache, and the dismissed-id list that drives the hide set is computed
      // over the same view.
      if (shouldCleanupSupersededInteractions(uiContextRef.current)) {
        const transcriptForScan =
          useChatSessionStore.getState().snapshot?.messages ?? [];

        patchTranscriptMessages((prev) => {
          const cleared = clearPendingConfirmationsFromMessages(prev);
          const { updatedMessages, dismissedIds } = dismissInteractiveSurfaces(
            cleared,
            transcriptForScan,
          );
          return dismissedIds.size > 0 ? updatedMessages : cleared;
        });

        // Persist dismissed surfaces outside the updater (side effect).
        const { dismissedIds } = dismissInteractiveSurfaces(
          transcriptForScan,
          transcriptForScan,
        );
        if (dismissedIds.size > 0) {
          persistDismissedSurfaces(dismissedIds);
          useTurnStore.getState().dismissSurface();
        }
      }

      const willQueue = isSending(useTurnStore.getState().phase);
      const clientMessageId = crypto.randomUUID();
      const userMessage: DisplayMessage = {
        id: clientMessageId,
        clientMessageId,
        isOptimistic: true,
        role: "user",
        textSegments: [content],
        contentOrder: [{ type: "text", id: "0" }],
        contentBlocks:
          content.trim().length > 0 ? [{ type: "text", text: content }] : [],
        timestamp: Date.now(),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(willQueue ? { queueStatus: "queued" as const, queuePosition: 0 } : {}),
      };
      if (!isHidden) addOptimisticSend(userMessage);
      void getSoundManager().play("message_sent");

      // Queue path: POST to assistant (it queues internally) but don't
      // disrupt the active turn.
      if (willQueue) {
        useChatSessionStore.getState().pushPendingQueuedMessageId(userMessage.id);
        const attachmentIds = attachments.map((att) => att.id);
        try {
          const postResult = await postChatMessage(
            assistantId,
            activeConversationId,
            content,
            { attachmentIds, clientMessageId },
          );
          if (!postResult.ok) {
            revertQueuedMessage(userMessage.id);
            const detail = resolvePostError(
              postResult.error.code,
              postResult.error.detail,
              "Failed to queue message. Please try again.",
            );
            setError({ message: detail, code: postResult.error.code ?? undefined });
            return;
          }
          void surfaceConversationAfterUserSend(postResult.conversationId).catch(
            (err) => {
              captureError(err, {
                context: "surface_queued_conversation_after_send",
              });
            },
          );
          if (!postResult.queued) {
            // The daemon processed the message directly (turn finished
            // between the client-side isSending check and the POST
            // arriving). Clear the optimistic queue status and let the
            // existing SSE stream deliver the response.
            const queueIds = useChatSessionStore.getState().pendingQueuedMessageIds;
            const idx = queueIds.indexOf(userMessage.id);
            if (idx !== -1) queueIds.splice(idx, 1);
            setOptimisticSends((prev) =>
              clearQueueStatus(prev, userMessage.id),
            );
            const fallbackTurnId = newTurnId();
            useTurnStore.getState().requestSend(fallbackTurnId);
            useTurnStore.getState().acceptSend(fallbackTurnId);
            {
              const currentConv = findConversation(
                queryClient,
                assistantId,
                activeConversationId,
              );
              useConversationStore
                .getState()
                .addProcessingConversationId(
                  activeConversationId,
                  currentConv?.latestAssistantMessageAt,
                );
            }
            return;
          }
          if (postResult.requestId) {
            useChatSessionStore.getState().setRequestIdMapping(postResult.requestId, userMessage.id);
          }
        } catch (err) {
          captureError(err, { context: "send_message_queue" });
          revertQueuedMessage(userMessage.id);
          setError({ message: "Failed to queue message. Please try again." });
        }
        return;
      }

      const turnId = newTurnId();
      useTurnStore.getState().requestSend(turnId);

      const currentConv = findConversation(
        queryClient,
        assistantId,
        activeConversationId,
      );
      useConversationStore
        .getState()
        .addProcessingConversationId(
          activeConversationId,
          currentConv?.latestAssistantMessageAt,
        );

      // Optimistically add a stub conversation to the sidebar for draft
      // conversations that don't exist on the server yet.
      if (!currentConv) {
        prependConversation(queryClient, assistantId, { conversationId: activeConversationId, lastMessageAt: Date.now(), draft: true } as Conversation);
      }

      cancelReconciliation();

      const isDraft = !currentConv;
      let resolvedId: string | undefined;

      try {
        const result = await sendMessageViaStream(
          content,
          useStreamStore.getState().streamEpoch,
          turnId,
          attachments.map((att) => att.id),
          isDraft,
          clientMessageId,
          isHidden,
        );

        if (result.status === "failed") {
          // Roll back every piece of optimistic state we just set up: the
          // optimistic send, the processing flag on the conversation, the
          // prepended draft conversation in the sidebar, and the cleared
          // composer input. Then surface the error.
          setOptimisticSends((prev) =>
            prev.filter((m) => m.id !== userMessage.id),
          );
          useConversationStore
            .getState()
            .removeProcessingConversationId(activeConversationId);
          if (isDraft) {
            removeConversation(queryClient, assistantId, activeConversationId);
            setError({
              message: result.error.message,
              ...(result.error.code ? { code: result.error.code } : {}),
              displayAs: "modal",
              restoreContent: content,
            });
          } else {
            useComposerStore.getState().setInput(content);
            setError(result.error);
          }
          return;
        }

        if (result.status === "ignored") {
          // Scope changed mid-flight; the new scope owns UI state from here.
          return;
        }

        resolvedId = result.resolvedConversationId;

        // Resolve draft key -> server-assigned conversation ID.
        if (resolvedId && resolvedId !== activeConversationId) {
          const newConversationId = resolvedId;
          useConversationStore
            .getState()
            .transferProcessingConversationId(activeConversationId, newConversationId);
          resolveDraftKey(queryClient, assistantId, activeConversationId, newConversationId);
          resolveEditChatDraftConversationId(activeConversationId, newConversationId);

          // Only update active view state if the user is still on this conversation.
          if (useConversationStore.getState().activeConversationId === activeConversationId) {
            useChatSessionStore.getState().markDraftResolution();
            useChatSessionStore.setState({ previousConversationId: newConversationId });
            useConversationStore.getState().setActiveConversationId(newConversationId);
            void navigate(routes.conversation(newConversationId), { replace: true });
          }
        }

        void refreshConversations();
      } catch (err) {
        captureError(err, { context: "send_chat_message" });
        setError({ message: "Something went wrong. Please try again." });
        // Multi-key processing-key cleanup: when a send is retargeted
        // (e.g. draft → new conversation), both the original active key
        // and the resolved key may have processing markers. `endTurn`
        // covers the single-conversation pairing; this catch-all clears
        // every key the send touched and fires `onStreamError` once.
        useTurnStore.getState().onStreamError();
        const keysToClean = [activeConversationId, resolvedId].filter(Boolean) as string[];
        if (keysToClean.length > 0) {
          useConversationStore.getState().removeMultipleProcessingConversationIds(keysToClean);
        }
        if (isDraft) {
          removeConversation(queryClient, assistantId, activeConversationId);
        }
      }
    },
    [
      activeConversationId,
      assistantId,
      diskPressureChatBlockReason,
      uiContextRef,
      runLocalMetaCommand,
      sendMessageViaStream,
      refreshConversations,
      revertQueuedMessage,
      persistDismissedSurfaces,
      queryClient,
      surfaceConversationAfterUserSend,
    ],
  );

  // -------------------------------------------------------------------------
  // handleStopGenerating — cancel the active generation
  // -------------------------------------------------------------------------
  const handleStopGenerating = useCallback(async () => {
    if (!assistantId || !activeConversationId) return;
    useStreamStore.getState().bumpEpoch();
    patchConversation(queryClient, assistantId, activeConversationId, {
      isProcessing: false,
    });
    endTurn({ conversationId: activeConversationId, reason: "cancelled" });
    // Per-row clear (no-op for non-matching rows) → snapshot + history cache.
    patchTranscriptMessages(clearPendingConfirmationsFromMessages);
    useInteractionStore.getState().resetAll();
    useSubagentStore.getState().reset();
    useWorkflowStore.getState().reset();
    useChatSessionStore.getState().clearConfirmationToolCallMap();
    try {
      await conversationsByIdCancelPost({
        path: { assistant_id: assistantId, id: activeConversationId },
        throwOnError: true,
      });
    } catch {
      // Best-effort — the daemon may have already finished
    }
  }, [assistantId, activeConversationId, queryClient]);

  return {
    sendMessage,
    handleStopGenerating,
    queuedMessages,
    handleCancelQueuedMessage,
    handleCancelAllQueued,
    handleSteerMessage,
    handleEditQueueTail,
  };
}
