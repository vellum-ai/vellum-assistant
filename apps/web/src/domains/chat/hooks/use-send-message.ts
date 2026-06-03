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
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useRef,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { routes } from "@/utils/routes";

import {
  type DisplayAttachment,
  type DisplayMessage,
  reconcileMessages,
} from "@/domains/chat/utils/reconcile";
import { isAsyncChatScopeCurrent } from "@/domains/chat/utils/conversation-scope";
import { resolveEditChatDraftConversationId } from "@/utils/edit-chat-session";
import { type DiskPressureChatBlockReason, getDiskPressureChatBlockMessage } from "@/assistant/disk-pressure";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useAssistantSelectionStore } from "@/assistant/selection-store";
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
} from "@/utils/conversation-cache-mutations";
import { findConversation, patchConversation } from "@/utils/conversation-cache";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import {
  consumePendingPreChatContext,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat";

import { clearQueueStatus } from "@/domains/chat/hooks/stream-message-updaters";
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
} from "@/domains/chat/hooks/send-message-utils";
import { useMessageQueue } from "@/domains/chat/hooks/use-message-queue";
import { conversationsByIdCancelPost } from "@/generated/daemon/sdk.gen";
import type { Conversation } from "@/types/conversation-types";
import { getPendingInteractions } from "@/domains/chat/api/interactions";
import { type RuntimeMessage, fetchConversationMessages, postChatMessage, pollForResponse } from "@/domains/chat/api/messages";
import { supportsServerMintedConversation } from "@/lib/backwards-compat/server-minted-conversation";

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
       *  for scope-changed-mid-flight results. Used by `sendMessage` to
       *  swap the optimistic user row's client id for the server id and
       *  clear `isOptimistic`. */
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
  messages: DisplayMessage[];

  // Onboarding refs (ChatPage-local, not per-conversation)
  pendingOnboardingContextRef: MutableRefObject<PreChatOnboardingContext | null>;
  onboardingDraftConversationIdRef: MutableRefObject<string | null>;

  // State setters (non-store)
  setInput: Dispatch<SetStateAction<string>>;

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
  messages,
  pendingOnboardingContextRef,
  onboardingDraftConversationIdRef,
  setInput,
  startReconciliationLoop,
  cancelReconciliation,
  refreshConversations,
}: UseSendMessageParams) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setMessages = useChatSessionStore.use.setMessages();
  const setError = useChatSessionStore.use.setError();

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
    messages,
    setInput,
  });

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  /**
   * Persist dismissed surface IDs to both the in-memory ref and local
   * storage. Extracted so `setMessages` updaters stay pure.
   */
  const persistDismissedSurfaces = useCallback(
    (dismissedIds: Set<string>) => {
      const store = useChatSessionStore.getState();
      for (const id of dismissedIds) {
        store.dismissedSurfaceIds.add(id);
      }
      const streamCtx = useStreamStore.getState().streamContext;
      if (streamCtx) {
        saveDismissedSurfaceIds(
          streamCtx.assistantId,
          streamCtx.conversationId,
          store.dismissedSurfaceIds,
        );
      }
    },
    [],
  );

  // -------------------------------------------------------------------------
  // sendMessageViaStream — low-level POST + polling fallback
  // -------------------------------------------------------------------------
  const sendMessageViaStream = useCallback(
    async (content: string, epoch: number, turnId: string, attachmentIds: string[] = [], isDraft = false): Promise<SendStreamResult> => {
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
          currentAssistantId: useAssistantSelectionStore.getState().activeAssistantId,
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
      const postResult = await postChatMessage(
        requestAssistantId,
        useServerMint ? null : requestConversationId,
        content,
        attachmentIds,
        onboardingContext ?? undefined,
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
            activeAssistantId: useAssistantSelectionStore.getState().activeAssistantId,
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
          activeAssistantId: useAssistantSelectionStore.getState().activeAssistantId,
          activeConversationId: useConversationStore.getState().activeConversationId,
        });
        return {
          status: "ok",
          resolvedConversationId: postResult.conversationId,
        };
      }

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

      pollForResponse(postResult.assistantId, postResult.messageId, effectiveConversationId)
        .then(async (reply) => {
          if (!isCurrentSendScope(effectiveConversationId)) {
            recordDiagnostic("poll_response_ignored_inactive_conversation", {
              assistantId: postResult.assistantId,
              conversationId: requestConversationId,
              resolvedConversationId: effectiveConversationId,
              activeAssistantId: useAssistantSelectionStore.getState().activeAssistantId,
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
          let serverMessages: RuntimeMessage[] = [];
          try {
            serverMessages = await fetchConversationMessages(
              postResult.assistantId,
              effectiveConversationId,
            );
          } catch {
            // Reconciliation is best-effort
          }
          if (!isCurrentSendScope(effectiveConversationId)) return;
          setMessages((prev) => {
            if (!isCurrentSendScope(effectiveConversationId)) return prev;
            if (serverMessages.length > 0) {
              return reconcileMessages(prev, serverMessages);
            }
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
          if (restoredConfData) {
            const capturedConfData = restoredConfData;
            setMessages((prev) => {
              if (!isCurrentSendScope(effectiveConversationId)) return prev;
              const result = attachConfirmationToToolCall(prev, capturedConfData);
              if (result.attachedToolCallId) {
                useInteractionStore.getState().setInlineConfirmationToolCallId(result.attachedToolCallId);
                useChatSessionStore.getState().confirmationToolCallMap.set(capturedConfData.requestId, result.attachedToolCallId);
              } else {
                useInteractionStore.getState().setInlineConfirmationToolCallId(null);
              }
              return result.updatedMessages;
            });
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
    [activeConversationId, assistantId, startReconciliationLoop],
  );

  // -------------------------------------------------------------------------
  // sendMessage — high-level send with UI state, queuing, draft resolution
  // -------------------------------------------------------------------------
  const sendMessage = useCallback(
    async (content: string, attachments: DisplayAttachment[] = []) => {
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
      useInteractionStore.getState().resetSecretAndConfirmation();
      useChatSessionStore.getState().confirmationToolCallMap.clear();
      // Clear pending confirmations and dismiss interactive surfaces in a
      // single functional updater so the two transforms compose correctly
      // within React 18's batched state updates. Side effects (ref mutation,
      // localStorage persist) are kept outside the updater to stay pure.
      const messagesForScan = useChatSessionStore.getState().messages;
      setMessages((prev) => {
        const cleared = clearPendingConfirmationsFromMessages(prev);
        const { updatedMessages, dismissedIds } =
          dismissInteractiveSurfaces(cleared, messagesForScan);
        return dismissedIds.size > 0 ? updatedMessages : cleared;
      });

      // Persist dismissed surfaces outside the updater (side effect).
      const { dismissedIds } = dismissInteractiveSurfaces(
        useChatSessionStore.getState().messages,
        messagesForScan,
      );
      if (dismissedIds.size > 0) {
        persistDismissedSurfaces(dismissedIds);
        useTurnStore.getState().dismissSurface();
      }

      const willQueue = isSending(useTurnStore.getState());
      const optimisticUserId = crypto.randomUUID();
      const userMessage: DisplayMessage = {
        id: optimisticUserId,
        isOptimistic: true,
        role: "user",
        textSegments: [content],
        contentOrder: [{ type: "text", id: "0" }],
        timestamp: Date.now(),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(willQueue ? { queueStatus: "queued" as const, queuePosition: 0 } : {}),
      };
      setMessages((prev) => [...prev, userMessage]);

      // Queue path: POST to assistant (it queues internally) but don't
      // disrupt the active turn.
      if (willQueue) {
        useChatSessionStore.getState().pendingQueuedMessageIds.push(userMessage.id);
        const attachmentIds = attachments.map((att) => att.id);
        try {
          const postResult = await postChatMessage(
            assistantId,
            activeConversationId,
            content,
            attachmentIds,
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
          if (!postResult.queued) {
            // The daemon processed the message directly (turn finished
            // between the client-side isSending check and the POST
            // arriving). Clear the optimistic queue status and let the
            // existing SSE stream deliver the response.
            const queueIds = useChatSessionStore.getState().pendingQueuedMessageIds;
            const idx = queueIds.indexOf(userMessage.id);
            if (idx !== -1) queueIds.splice(idx, 1);
            setMessages((prev) =>
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
            useChatSessionStore.getState().requestIdToMessageId.set(postResult.requestId, userMessage.id);
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
        );

        if (result.status === "failed") {
          // Roll back every piece of optimistic state we just set up: the
          // bubble in the transcript, the processing flag on the conversation,
          // the prepended draft conversation in the sidebar, and the cleared
          // composer input. Then surface the error.
          setMessages((prev) =>
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
            setInput(content);
            setError(result.error);
          }
          return;
        }

        if (result.status === "ignored") {
          // Scope changed mid-flight; the new scope owns UI state from here.
          return;
        }

        resolvedId = result.resolvedConversationId;

        // POST resolve — swap the optimistic user row's client id for the
        // server's. Gate on `isOptimistic` so a reconcile that already
        // swapped this row doesn't get clobbered. Queued sends skip this
        // and keep their optimistic id until a later reconcile
        // content-matches.
        if (result.userMessageId) {
          const serverUserMessageId = result.userMessageId;
          setMessages((prev) =>
            prev.map((m) =>
              m.isOptimistic && m.id === optimisticUserId
                ? { ...m, id: serverUserMessageId, isOptimistic: false }
                : m,
            ),
          );
        }

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
      sendMessageViaStream,
      refreshConversations,
      revertQueuedMessage,
      persistDismissedSurfaces,
      queryClient,
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
    setMessages(clearPendingConfirmationsFromMessages);
    useInteractionStore.getState().resetAll();
    useSubagentStore.getState().reset();
    useChatSessionStore.getState().confirmationToolCallMap.clear();
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
