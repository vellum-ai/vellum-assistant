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

import * as Sentry from "@sentry/react";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { NavigateFunction } from "react-router";
import { routes } from "@/utils/routes.js";

import {
  type DisplayAttachment,
  type DisplayMessage,
  reconcileMessages,
} from "@/domains/chat/utils/reconcile.js";
import { isAsyncChatScopeCurrent } from "@/domains/chat/utils/conversation-scope.js";
import { resolveEditChatDraftKey } from "@/domains/chat/utils/edit-chat-session.js";
import { type DiskPressureChatBlockReason, getDiskPressureChatBlockMessage } from "@/assistant/disk-pressure.js";
import { recordChatDiagnostic } from "@/domains/chat/utils/diagnostics.js";
import { newStableId } from "@/domains/chat/utils/stable-id.js";
import { saveDismissedSurfaceIds } from "@/domains/chat/utils/dismissed-surfaces-storage.js";
import { isSending, useTurnStore } from "@/domains/messaging/turn-store.js";
import { useInteractionStore } from "@/domains/interactions/interaction-store.js";
import { useConversationStore } from "@/domains/conversations/conversation-store.js";
import {
  findConversation,
  prependConversation,
  removeConversation,
  resolveDraftKey,
} from "@/domains/conversations/conversation-queries.js";
import { useSubagentStore } from "@/domains/subagents/subagent-store.js";
import {
  consumePendingPreChatContext,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat.js";

import { clearQueueStatus } from "@/domains/chat/hooks/stream-message-updaters.js";
import { attachConfirmationToToolCall } from "@/domains/chat/utils/chat-utils.js";
import type { ChatError } from "@/domains/chat/types.js";

import {
  clearPendingConfirmationsFromMessages,
  dismissInteractiveSurfaces,
  newTurnId,
  parsePendingConfirmationData,
  parsePendingSecretState,
  resolvePostError,
  stopStreamingAndClearConfirmations,
} from "@/domains/chat/hooks/send-message-utils.js";
import { useMessageQueue } from "@/domains/chat/hooks/use-message-queue.js";
import { type Conversation, cancelGeneration } from "@/domains/chat/api/conversations.js";
import { getPendingInteractions } from "@/domains/chat/api/interactions.js";
import { type RuntimeMessage, fetchConversationMessages, postChatMessage, pollForResponse } from "@/domains/chat/api/messages.js";
import type { ChatEventStream } from "@/domains/chat/api/stream.js";

// Re-export pure utilities so existing consumers don't break.
export {
  clearPendingConfirmationsFromMessages,
  dismissInteractiveSurfaces,
  resolvePostError,
  stopStreamingAndClearConfirmations,
  parsePendingSecretState,
  parsePendingConfirmationData,
} from "@/domains/chat/hooks/send-message-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

interface UseSendMessageParams {
  // Identity
  assistantId: string | null;
  activeConversationKey: string | null;
  diskPressureChatBlockReason: DiskPressureChatBlockReason | null;
  messages: DisplayMessage[];

  // Refs
  assistantIdRef: MutableRefObject<string | null>;
  activeConversationKeyRef: MutableRefObject<string | null>;

  messagesRef: MutableRefObject<DisplayMessage[]>;
  streamRef: MutableRefObject<ChatEventStream | null>;
  streamContextRef: MutableRefObject<{
    assistantId: string;
    conversationId: string;
  } | null>;
  streamEpochRef: MutableRefObject<number>;
  needsNewBubbleRef: MutableRefObject<boolean>;
  dismissedSurfaceIdsRef: MutableRefObject<Set<string>>;
  pendingOnboardingContextRef: MutableRefObject<PreChatOnboardingContext | null>;
  onboardingDraftConversationKeyRef: MutableRefObject<string | null>;
  draftKeyResolutionRef: MutableRefObject<boolean>;
  previousConversationKeyRef: MutableRefObject<string | null>;
  pendingQueuedStableIdsRef: MutableRefObject<string[]>;
  requestIdToStableIdRef: MutableRefObject<Map<string, string>>;
  pendingLocalDeletionsRef: MutableRefObject<Set<string>>;
  confirmationToolCallMapRef: MutableRefObject<Map<string, string>>;

  // State setters
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  setError: Dispatch<SetStateAction<ChatError | null>>;
  setInput: Dispatch<SetStateAction<string>>;

  // Callbacks
  startReconciliationLoop: (epoch: number) => void;
  cancelReconciliation: () => void;
  refreshConversations: () => Promise<void>;

  // Routing adapter
  navigate: NavigateFunction;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSendMessage({
  assistantId,
  activeConversationKey,
  diskPressureChatBlockReason,
  messages,
  assistantIdRef,
  activeConversationKeyRef,
  messagesRef,
  streamRef,
  streamContextRef,
  streamEpochRef,
  needsNewBubbleRef,
  dismissedSurfaceIdsRef,
  pendingOnboardingContextRef,
  onboardingDraftConversationKeyRef,
  draftKeyResolutionRef,
  previousConversationKeyRef,
  pendingQueuedStableIdsRef,
  requestIdToStableIdRef,
  pendingLocalDeletionsRef,
  confirmationToolCallMapRef,
  setMessages,
  setError,
  setInput,
  startReconciliationLoop,
  cancelReconciliation,
  refreshConversations,
  navigate,
}: UseSendMessageParams) {
  const queryClient = useQueryClient();

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
    activeConversationKey,
    messages,
    pendingQueuedStableIdsRef,
    requestIdToStableIdRef,
    pendingLocalDeletionsRef,
    setMessages,
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
      for (const id of dismissedIds) {
        dismissedSurfaceIdsRef.current.add(id);
      }
      const streamCtx = streamContextRef.current;
      if (streamCtx) {
        saveDismissedSurfaceIds(
          streamCtx.assistantId,
          streamCtx.conversationId,
          dismissedSurfaceIdsRef.current,
        );
      }
    },
    [],
  );

  // -------------------------------------------------------------------------
  // sendMessageViaStream — low-level POST + polling fallback
  // -------------------------------------------------------------------------
  const sendMessageViaStream = useCallback(
    async (content: string, epoch: number, turnId: string, attachmentIds: string[] = []): Promise<string | undefined> => {
      if (!activeConversationKey || !assistantId) {
        setError({ message: "No active conversation. Please try again." });
        useTurnStore.getState().onStreamError();
        return undefined;
      }
      const requestAssistantId = assistantId;
      const requestConversationKey = activeConversationKey;
      const isCurrentSendScope = (resolvedConversationKey?: string | null) =>
        isAsyncChatScopeCurrent({
          currentAssistantId: assistantIdRef.current,
          currentConversationKey: activeConversationKeyRef.current,
          requestAssistantId,
          requestConversationKey,
          resolvedConversationKey,
        });

      const onboardingContext =
        pendingOnboardingContextRef.current ?? consumePendingPreChatContext();
      if (onboardingContext && !pendingOnboardingContextRef.current) {
        pendingOnboardingContextRef.current = onboardingContext;
      }
      const postResult = await postChatMessage(
        requestAssistantId,
        requestConversationKey,
        content,
        attachmentIds,
        onboardingContext ?? undefined,
      );
      if (!postResult.ok) {
        if (!isCurrentSendScope()) {
          recordChatDiagnostic("send_error_ignored_inactive_conversation", {
            assistantId: requestAssistantId,
            conversationId: requestConversationKey,
            activeAssistantId: assistantIdRef.current,
            activeConversationKey: activeConversationKeyRef.current,
          });
          return undefined;
        }
        const detail = resolvePostError(
          postResult.error.code,
          postResult.error.detail,
          "Something went wrong. Please try again.",
        );
        setError({ message: detail, code: postResult.error.code ?? undefined });
        useTurnStore.getState().onStreamError();
        return undefined;
      }
      // Success — drain the ref so subsequent messages omit the field.
      pendingOnboardingContextRef.current = null;
      if (onboardingDraftConversationKeyRef.current === activeConversationKey) {
        onboardingDraftConversationKeyRef.current = null;
      }

      if (isCurrentSendScope()) {
        useTurnStore.getState().acceptSend(turnId);
      }

      const effectiveConversationKey =
        postResult.resolvedConversationId ?? postResult.conversationId;

      if (!isCurrentSendScope(effectiveConversationKey)) {
        recordChatDiagnostic("send_result_ignored_inactive_conversation", {
          assistantId: postResult.assistantId,
          conversationId: requestConversationKey,
          resolvedConversationKey: effectiveConversationKey,
          activeAssistantId: assistantIdRef.current,
          activeConversationKey: activeConversationKeyRef.current,
        });
        return postResult.resolvedConversationId;
      }

      const existingStreamContext = streamContextRef.current;
      const hasMatchingActiveStream =
        !!streamRef.current &&
        existingStreamContext?.assistantId === postResult.assistantId &&
        existingStreamContext.conversationId === effectiveConversationKey;

      streamContextRef.current = {
        assistantId: postResult.assistantId,
        conversationId: effectiveConversationKey,
      };

      if (postResult.queued) return postResult.resolvedConversationId;
      if (hasMatchingActiveStream) return postResult.resolvedConversationId;

      pollForResponse(postResult.assistantId, postResult.messageId, effectiveConversationKey)
        .then(async (reply) => {
          if (!isCurrentSendScope(effectiveConversationKey)) {
            recordChatDiagnostic("poll_response_ignored_inactive_conversation", {
              assistantId: postResult.assistantId,
              conversationId: requestConversationKey,
              resolvedConversationKey: effectiveConversationKey,
              activeAssistantId: assistantIdRef.current,
              activeConversationKey: activeConversationKeyRef.current,
            });
            return;
          }
          let restoredConfData: Parameters<typeof attachConfirmationToToolCall>[1] | null = null;
          try {
            const interactions = await getPendingInteractions(
              postResult.assistantId,
              effectiveConversationKey,
            );
            if (!isCurrentSendScope(effectiveConversationKey)) return;
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
              effectiveConversationKey,
            );
          } catch {
            // Reconciliation is best-effort
          }
          if (!isCurrentSendScope(effectiveConversationKey)) return;
          setMessages((prev) => {
            if (!isCurrentSendScope(effectiveConversationKey)) return prev;
            if (serverMessages.length > 0) {
              return reconcileMessages(prev, serverMessages);
            }
            const existingIdx = prev.findIndex((m) => m.id === reply.id);
            if (existingIdx >= 0) {
              const existing = prev[existingIdx];
              const updated = [...prev];
              updated[existingIdx] = {
                stableId: existing?.stableId ?? newStableId("assistant-poll"),
                id: reply.id,
                daemonMessageId:
                  reply.daemonMessageId ?? existing?.daemonMessageId,
                role: "assistant",
                content: reply.content,
                timestamp: existing?.timestamp ?? Date.now(),
              };
              return updated;
            }
            return [
              ...prev,
              {
                stableId: newStableId("assistant-poll"),
                id: reply.id,
                ...(reply.daemonMessageId ? { daemonMessageId: reply.daemonMessageId } : {}),
                role: "assistant",
                content: reply.content,
                timestamp: Date.now(),
              },
            ];
          });
          if (restoredConfData) {
            const capturedConfData = restoredConfData;
            setMessages((prev) => {
              if (!isCurrentSendScope(effectiveConversationKey)) return prev;
              const result = attachConfirmationToToolCall(prev, capturedConfData);
              if (result.attachedToolCallId) {
                useInteractionStore.getState().setInlineConfirmationToolCallId(result.attachedToolCallId);
                confirmationToolCallMapRef.current.set(capturedConfData.requestId, result.attachedToolCallId);
              } else {
                useInteractionStore.getState().setInlineConfirmationToolCallId(null);
              }
              return result.updatedMessages;
            });
          }
          startReconciliationLoop(epoch);
        })
        .catch(() => {
          if (!isCurrentSendScope(effectiveConversationKey)) return;
          setError({ message: "Connection lost. Please try again." });
        })
        .finally(() => {
          if (!isCurrentSendScope(effectiveConversationKey)) return;
          useTurnStore.getState().onPollReconciled(turnId);
        });

      return postResult.resolvedConversationId;
    },
    [activeConversationKey, assistantId, startReconciliationLoop],
  );

  // -------------------------------------------------------------------------
  // sendMessage — high-level send with UI state, queuing, draft resolution
  // -------------------------------------------------------------------------
  const sendMessage = useCallback(
    async (content: string, attachments: DisplayAttachment[] = []) => {
      if (!activeConversationKey || !assistantId) {
        setError({ message: "No active conversation. Please try again." });
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
      confirmationToolCallMapRef.current.clear();
      // Clear pending confirmations and dismiss interactive surfaces in a
      // single functional updater so the two transforms compose correctly
      // within React 18's batched state updates. Side effects (ref mutation,
      // localStorage persist) are kept outside the updater to stay pure.
      const messagesForScan = messagesRef.current;
      setMessages((prev) => {
        const cleared = clearPendingConfirmationsFromMessages(prev);
        const { updatedMessages, dismissedIds } =
          dismissInteractiveSurfaces(cleared, messagesForScan);
        return dismissedIds.size > 0 ? updatedMessages : cleared;
      });

      // Persist dismissed surfaces outside the updater (side effect).
      const { dismissedIds } = dismissInteractiveSurfaces(
        messagesRef.current,
        messagesForScan,
      );
      if (dismissedIds.size > 0) {
        persistDismissedSurfaces(dismissedIds);
        useTurnStore.getState().dismissSurface();
      }

      const willQueue = isSending(useTurnStore.getState());
      const userMessage: DisplayMessage = {
        stableId: newStableId("user"),
        role: "user",
        content,
        timestamp: Date.now(),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(willQueue ? { queueStatus: "queued" as const, queuePosition: 0 } : {}),
      };
      setMessages((prev) => [...prev, userMessage]);

      // Queue path: POST to daemon (it queues internally) but don't
      // disrupt the active turn.
      if (willQueue) {
        pendingQueuedStableIdsRef.current.push(userMessage.stableId);
        const attachmentIds = attachments.map((att) => att.id);
        try {
          const postResult = await postChatMessage(
            assistantId,
            activeConversationKey,
            content,
            attachmentIds,
          );
          if (!postResult.ok) {
            revertQueuedMessage(userMessage.stableId);
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
            pendingQueuedStableIdsRef.current =
              pendingQueuedStableIdsRef.current.filter(
                (id) => id !== userMessage.stableId,
              );
            setMessages((prev) =>
              clearQueueStatus(prev, userMessage.stableId),
            );
            needsNewBubbleRef.current = true;
            const fallbackTurnId = newTurnId();
            useTurnStore.getState().requestSend(fallbackTurnId);
            useTurnStore.getState().acceptSend(fallbackTurnId);
            {
              const currentConv = findConversation(
                queryClient,
                assistantId,
                activeConversationKey,
              );
              useConversationStore
                .getState()
                .addProcessingKey(
                  activeConversationKey,
                  currentConv?.latestAssistantMessageAt as string | undefined,
                );
            }
            return;
          }
          if (postResult.requestId) {
            requestIdToStableIdRef.current.set(postResult.requestId, userMessage.stableId);
          }
        } catch {
          revertQueuedMessage(userMessage.stableId);
          setError({ message: "Failed to queue message. Please try again." });
        }
        return;
      }

      const turnId = newTurnId();
      useTurnStore.getState().requestSend(turnId);

      const currentConv = findConversation(
        queryClient,
        assistantId,
        activeConversationKey,
      );
      useConversationStore
        .getState()
        .addProcessingKey(
          activeConversationKey,
          currentConv?.latestAssistantMessageAt as string | undefined,
        );

      // Optimistically add a stub conversation to the sidebar for draft
      // conversations that don't exist on the server yet.
      if (!currentConv) {
        prependConversation(queryClient, assistantId, { conversationId: activeConversationKey, lastMessageAt: new Date().toISOString(), draft: true } as Conversation);
      }

      cancelReconciliation();
      needsNewBubbleRef.current = true;

      const isDraft = !currentConv;
      let resolvedId: string | undefined;

      try {
        resolvedId = await sendMessageViaStream(
          content,
          streamEpochRef.current,
          turnId,
          attachments.map((att) => att.id),
        );

        // Resolve draft key -> server-assigned conversation ID.
        if (resolvedId && resolvedId !== activeConversationKey) {
          const newKey = resolvedId;
          useConversationStore
            .getState()
            .transferProcessingKey(activeConversationKey, newKey);
          resolveDraftKey(queryClient, assistantId, activeConversationKey, newKey);
          resolveEditChatDraftKey(activeConversationKey, newKey);

          // Only update active view state if the user is still on this conversation.
          if (activeConversationKeyRef.current === activeConversationKey) {
            draftKeyResolutionRef.current = true;
            previousConversationKeyRef.current = newKey;
            useConversationStore.getState().setActiveKey(newKey);
            void navigate(routes.conversation(newKey), { replace: true });
          }
        }

        void refreshConversations();
      } catch (err) {
        Sentry.captureException(err, {
          tags: { context: "send_chat_message" },
        });
        setError({ message: "Something went wrong. Please try again." });
        useTurnStore.getState().onStreamError();
        const keysToClean = [activeConversationKey, resolvedId].filter(Boolean) as string[];
        if (keysToClean.length > 0) {
          useConversationStore.getState().removeMultipleProcessingKeys(keysToClean);
        }
        if (isDraft) {
          removeConversation(queryClient, assistantId, activeConversationKey);
        }
      }
    },
    [
      activeConversationKey,
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
    if (!assistantId || !activeConversationKey) return;
    streamEpochRef.current++;
    useTurnStore.getState().cancelGeneration();
    setMessages(stopStreamingAndClearConfirmations);
    needsNewBubbleRef.current = true;
    useInteractionStore.getState().resetAll();
    useSubagentStore.getState().reset();
    confirmationToolCallMapRef.current.clear();
    useConversationStore.getState().removeProcessingKey(activeConversationKey);
    try {
      await cancelGeneration(assistantId, activeConversationKey);
    } catch {
      // Best-effort — the daemon may have already finished
    }
  }, [assistantId, activeConversationKey]);

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
