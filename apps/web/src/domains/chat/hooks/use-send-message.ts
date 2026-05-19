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

import {
  type ChatEventStream,
  type Conversation,
  type RuntimeMessage,
  cancelGeneration,
  fetchConversationMessages,
  getPendingInteractions,
  postChatMessage,
  pollForResponse,
} from "@/domains/chat/lib/api.js";
import {
  type DisplayAttachment,
  type DisplayMessage,
  reconcileMessages,
} from "@/domains/chat/lib/reconcile.js";
import { isAsyncChatScopeCurrent } from "@/domains/chat/lib/conversation-scope.js";
import { resolveEditChatDraftKey } from "@/domains/chat/lib/edit-chat-session.js";
import { type DiskPressureChatBlockReason, getDiskPressureChatBlockMessage } from "@/domains/assistant/disk-pressure.js";
import { recordChatDiagnostic } from "@/domains/chat/lib/diagnostics.js";
import { newStableId } from "@/domains/chat/lib/stable-id.js";
import { saveDismissedSurfaceIds } from "@/domains/chat/lib/dismissedSurfacesStorage.js";
import { isSending, type TurnState, type DomainEvent } from "@/domains/messaging/turn-store.js";
import type { InteractionEvent } from "@/domains/interactions/interaction-store.js";
import type { ConversationListAction } from "@/domains/conversations/conversation-list-store.js";
import type { SubagentAction } from "@/domains/subagents/subagent-store.js";
import type { PreChatOnboardingContext } from "@/lib/onboarding/prechat.js";

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
  turnStateRef: MutableRefObject<TurnState>;
  messagesRef: MutableRefObject<DisplayMessage[]>;
  conversationsRef: MutableRefObject<Conversation[]>;
  streamRef: MutableRefObject<ChatEventStream | null>;
  streamContextRef: MutableRefObject<{
    assistantId: string;
    conversationKey: string;
  } | null>;
  streamEpochRef: MutableRefObject<number>;
  needsNewBubbleRef: MutableRefObject<boolean>;
  processingSnapshotsRef: MutableRefObject<Map<string, string | undefined>>;
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
  dispatchConversationList: Dispatch<ConversationListAction>;
  dispatchInteraction: Dispatch<InteractionEvent>;
  setStreamRetryNonce: Dispatch<SetStateAction<number>>;
  setInput: Dispatch<SetStateAction<string>>;
  dispatchTurn: Dispatch<DomainEvent>;
  dispatchSubagent: Dispatch<SubagentAction>;

  // Callbacks
  startReconciliationLoop: (epoch: number) => void;
  cancelReconciliation: () => void;
  refreshConversations: () => Promise<void>;
  navRemapKey: (oldKey: string, newKey: string) => void;

  // Routing adapter
  replaceUrl: (url: string) => void;
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
  turnStateRef,
  messagesRef,
  conversationsRef,
  streamRef,
  streamContextRef,
  streamEpochRef,
  needsNewBubbleRef,
  processingSnapshotsRef,
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
  dispatchConversationList,
  dispatchInteraction,
  setStreamRetryNonce,
  setInput,
  dispatchTurn,
  dispatchSubagent,
  startReconciliationLoop,
  cancelReconciliation,
  refreshConversations,
  navRemapKey,
  replaceUrl,
}: UseSendMessageParams) {
  // -------------------------------------------------------------------------
  // Queue management (delegated to useMessageQueue)
  // -------------------------------------------------------------------------
  const {
    revertQueuedMessage,
    queuedMessages,
    handleCancelQueuedMessage,
    handleCancelAllQueued,
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
    dispatchTurn,
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
          streamCtx.conversationKey,
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
        dispatchTurn({ type: "STREAM_ERROR" });
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

      const onboardingContext = pendingOnboardingContextRef.current;
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
            conversationKey: requestConversationKey,
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
        dispatchTurn({ type: "STREAM_ERROR" });
        return undefined;
      }
      // Success — drain the ref so subsequent messages omit the field.
      pendingOnboardingContextRef.current = null;
      if (onboardingDraftConversationKeyRef.current === activeConversationKey) {
        onboardingDraftConversationKeyRef.current = null;
      }

      if (isCurrentSendScope()) {
        dispatchTurn({ type: "USER_SEND_ACCEPTED", turnId });
      }

      const effectiveConversationKey =
        postResult.resolvedConversationId ?? postResult.conversationKey;

      if (!isCurrentSendScope(effectiveConversationKey)) {
        recordChatDiagnostic("send_result_ignored_inactive_conversation", {
          assistantId: postResult.assistantId,
          conversationKey: requestConversationKey,
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
        existingStreamContext.conversationKey === effectiveConversationKey;

      streamContextRef.current = {
        assistantId: postResult.assistantId,
        conversationKey: effectiveConversationKey,
      };

      if (postResult.queued) return postResult.resolvedConversationId;
      if (hasMatchingActiveStream) return postResult.resolvedConversationId;

      pollForResponse(postResult.assistantId, postResult.messageId, effectiveConversationKey)
        .then(async (reply) => {
          if (!isCurrentSendScope(effectiveConversationKey)) {
            recordChatDiagnostic("poll_response_ignored_inactive_conversation", {
              assistantId: postResult.assistantId,
              conversationKey: requestConversationKey,
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
              dispatchInteraction({ type: "SHOW_SECRET", payload: parsePendingSecretState(interactions.pendingSecret) });
              if (!reply) return;
            }
            if (interactions.pendingConfirmation) {
              const { confData, state } = parsePendingConfirmationData(interactions.pendingConfirmation);
              restoredConfData = confData;
              dispatchInteraction({ type: "SHOW_CONFIRMATION", payload: state });
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
                dispatchInteraction({ type: "SET_INLINE_CONFIRMATION_TOOL_CALL_ID", toolCallId: result.attachedToolCallId });
                confirmationToolCallMapRef.current.set(capturedConfData.requestId, result.attachedToolCallId);
              } else {
                dispatchInteraction({ type: "SET_INLINE_CONFIRMATION_TOOL_CALL_ID", toolCallId: null });
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
          dispatchTurn({ type: "POLL_RECONCILED", turnId });
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
      dispatchInteraction({ type: "RESET_SECRET_AND_CONFIRMATION" });
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
        dispatchTurn({ type: "UI_SURFACE_DISMISS" });
      }

      const willQueue = isSending(turnStateRef.current);
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
            dispatchTurn({ type: "USER_SEND_REQUESTED", turnId: fallbackTurnId });
            dispatchTurn({ type: "USER_SEND_ACCEPTED", turnId: fallbackTurnId });
            dispatchConversationList({ type: "ADD_PROCESSING_KEY", key: activeConversationKey });
            const currentConv = conversationsRef.current.find(
              (c) => c.conversationKey === activeConversationKey,
            );
            processingSnapshotsRef.current.set(
              activeConversationKey,
              currentConv?.latestAssistantMessageAt as string | undefined,
            );
            return;
          }
        } catch {
          revertQueuedMessage(userMessage.stableId);
          setError({ message: "Failed to queue message. Please try again." });
        }
        return;
      }

      const turnId = newTurnId();
      dispatchTurn({ type: "USER_SEND_REQUESTED", turnId });

      dispatchConversationList({ type: "ADD_PROCESSING_KEY", key: activeConversationKey });
      const currentConv = conversationsRef.current.find(c => c.conversationKey === activeConversationKey);
      processingSnapshotsRef.current.set(
        activeConversationKey,
        currentConv?.latestAssistantMessageAt as string | undefined,
      );

      // Optimistically add a stub conversation to the sidebar for draft
      // conversations that don't exist on the server yet.
      if (!currentConv) {
        dispatchConversationList({ type: "PREPEND_CONVERSATION", conversation: { conversationKey: activeConversationKey, lastMessageAt: new Date().toISOString(), draft: true } as Conversation });
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
          dispatchConversationList({ type: "TRANSFER_PROCESSING_KEY", oldKey: activeConversationKey, newKey });
          const snapshot = processingSnapshotsRef.current.get(activeConversationKey);
          processingSnapshotsRef.current.delete(activeConversationKey);
          if (snapshot !== undefined) {
            processingSnapshotsRef.current.set(newKey, snapshot);
          }
          navRemapKey(activeConversationKey, newKey);
          dispatchConversationList({ type: "RESOLVE_DRAFT_KEY", oldKey: activeConversationKey, newKey });
          resolveEditChatDraftKey(activeConversationKey, newKey);

          // Only update active view state if the user is still on this conversation.
          if (activeConversationKeyRef.current === activeConversationKey) {
            draftKeyResolutionRef.current = true;
            previousConversationKeyRef.current = newKey;
            dispatchConversationList({ type: "SET_ACTIVE_KEY", key: newKey });
            const params = new URLSearchParams(window.location.search);
            params.set("conversationKey", newKey);
            replaceUrl(`?${params.toString()}`);
          }
        }

        if (!streamRef.current) {
          setStreamRetryNonce((n) => n + 1);
        }
        await refreshConversations();
      } catch (err) {
        Sentry.captureException(err, {
          tags: { context: "send_chat_message" },
        });
        setError({ message: "Something went wrong. Please try again." });
        dispatchTurn({ type: "STREAM_ERROR" });
        const keysToClean = [activeConversationKey, resolvedId].filter(Boolean) as string[];
        for (const k of keysToClean) processingSnapshotsRef.current.delete(k);
        if (keysToClean.length > 0) {
          dispatchConversationList({ type: "REMOVE_MULTIPLE_PROCESSING_KEYS", keys: keysToClean });
        }
        if (isDraft) {
          dispatchConversationList({ type: "REMOVE_CONVERSATION", key: activeConversationKey });
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
    ],
  );

  // -------------------------------------------------------------------------
  // handleStopGenerating — cancel the active generation
  // -------------------------------------------------------------------------
  const handleStopGenerating = useCallback(async () => {
    if (!assistantId || !activeConversationKey) return;
    streamEpochRef.current++;
    dispatchTurn({ type: "GENERATION_CANCELLED" });
    setMessages(stopStreamingAndClearConfirmations);
    needsNewBubbleRef.current = true;
    dispatchInteraction({ type: "RESET_ALL" });
    dispatchSubagent({ type: "SUBAGENT_RESET" });
    confirmationToolCallMapRef.current.clear();
    dispatchConversationList({ type: "REMOVE_PROCESSING_KEY", key: activeConversationKey });
    processingSnapshotsRef.current.delete(activeConversationKey);
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
    handleEditQueueTail,
  };
}
