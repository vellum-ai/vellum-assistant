/**
 * Conversation secondary actions — fork, analyze, inspect, open-in-new-window,
 * copy transcript, and share-feedback modal state.
 *
 * These are the "utility" actions surfaced in the conversation header chevron
 * menu and sidebar context menu. The primary CRUD-like actions (archive,
 * unarchive, pin, rename, mark read/unread) live in `useConversationActions`.
 */

import * as Sentry from "@sentry/react";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useState,
} from "react";

import type { NavigateFunction } from "react-router";

import type { Conversation } from "@/domains/chat/api/conversations.js";
import { analyzeConversation, forkConversation } from "@/domains/chat/api/conversations.js";
import { routes } from "@/utils/routes.js";
import { haptic } from "@/utils/haptics.js";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import type { ChatError } from "@/domains/chat/types.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface UseConversationSecondaryActionsParams {
  assistantId: string | null;
  activeConversationId: string | null;
  activeConversation: Conversation | null | undefined;
  assistantIdentityName: string | undefined;
  messagesRef: MutableRefObject<DisplayMessage[]>;
  refreshConversations: () => void;
  switchConversation: (key: string) => void;
  setError: (error: ChatError | null) => void;
  /** Navigate to a conversation by key (path-based routing). */
  navigateToConversation: (key: string) => void;
  /** React Router navigate function for non-conversation navigation. */
  navigate: NavigateFunction;
}

// ---------------------------------------------------------------------------
// Return
// ---------------------------------------------------------------------------

export interface UseConversationSecondaryActionsReturn {
  handleForkConversation: (throughMessageId: string) => Promise<void>;
  handleForkConversationFromMenu: () => void;
  handleAnalyzeConversation: (conversation: Conversation) => Promise<void>;
  handleOpenInNewWindow: (conversation: Conversation) => void;
  handleInspectConversation: (conversation: Conversation) => void;
  handleInspectMessage: (messageId: string) => void;
  handleCopyConversation: () => void;
  feedbackOpen: boolean;
  setFeedbackOpen: Dispatch<SetStateAction<boolean>>;
  handleShareFeedback: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useConversationSecondaryActions({
  assistantId,
  activeConversationId,
  activeConversation,
  assistantIdentityName,
  messagesRef,
  refreshConversations,
  switchConversation,
  setError,
  navigateToConversation,
  navigate,
}: UseConversationSecondaryActionsParams): UseConversationSecondaryActionsReturn {
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const handleForkConversation = useCallback(
    async (throughMessageId: string) => {
      if (!assistantId || !activeConversationId) {
        return;
      }
      haptic.light();

      try {
        const { conversationId: newConversationId } = await forkConversation(
          assistantId,
          activeConversationId,
          throughMessageId,
        );
        refreshConversations();
        navigateToConversation(newConversationId);
      } catch (err) {
        Sentry.captureException(err, {
          tags: { context: "fork_conversation" },
        });
      }
    },
    [activeConversationId, assistantId, refreshConversations, navigateToConversation],
  );

  const handleForkConversationFromMenu = useCallback(() => {
    const latestPersisted = messagesRef.current.findLast(
      (m) => m.daemonMessageId != null || m.id != null,
    );
    const throughMessageId =
      latestPersisted?.daemonMessageId ?? latestPersisted?.id;
    if (!throughMessageId) return;
    void handleForkConversation(throughMessageId);
  }, [handleForkConversation]);

  const handleAnalyzeConversation = useCallback(
    async (conversation: Conversation) => {
      if (!assistantId) return;
      try {
        const result = await analyzeConversation(
          assistantId,
          conversation.conversationId,
        );
        await refreshConversations();
        switchConversation(result.conversationId);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to analyze conversation.";
        setError({ message });
        Sentry.captureException(err, {
          tags: { context: "analyzeConversation" },
        });
      }
    },
    [assistantId, refreshConversations, switchConversation],
  );

  const handleOpenInNewWindow = useCallback(
    (conversation: Conversation) => {
      window.open(routes.conversation(conversation.conversationId), "_blank");
    },
    [],
  );

  // Navigate to the per-conversation LLM context inspector (web port of
  // macOS's `MessageInspectorView`). The page reads `?conversationKey=`
  // and `?messageId=`. We default messageId to the most recent assistant
  // message, but only when the target conversation is the currently active
  // one — messagesRef always holds the active transcript, so using it for
  // a different conversation would produce a mismatched (conversationKey,
  // messageId) pair and show the wrong LLM context in the inspector.
  const handleInspectConversation = useCallback(
    (conversation: Conversation) => {
      const params = new URLSearchParams();
      params.set("conversationId", conversation.conversationId);
      const isActiveConversation =
        conversation.conversationId === activeConversation?.conversationId;
      if (isActiveConversation) {
        const latestAssistant = messagesRef.current.findLast(
          (m) => m.role === "assistant" && (m.daemonMessageId ?? m.id),
        );
        const messageId =
          latestAssistant?.daemonMessageId ?? latestAssistant?.id;
        if (messageId) {
          params.set("messageId", messageId);
        }
      }
      void navigate(`${routes.inspect}?${params.toString()}`);
    },
    [navigate, activeConversation?.conversationId],
  );

  const handleInspectMessage = useCallback(
    (messageId: string) => {
      if (!activeConversationId) return;
      const params = new URLSearchParams();
      params.set("conversationId", activeConversationId);
      params.set("messageId", messageId);
      void navigate(`${routes.inspect}?${params.toString()}`);
    },
    [activeConversationId, navigate],
  );

  const handleShareFeedback = useCallback(() => {
    setFeedbackOpen(true);
  }, []);

  const handleCopyConversation = useCallback(() => {
    const name = assistantIdentityName ?? "Assistant";
    const parts: string[] = [];
    if (activeConversation?.title) {
      parts.push(`# ${activeConversation.title}`);
    }
    for (const msg of messagesRef.current) {
      if (!msg.content.trim()) continue;
      const sender = msg.role === "user" ? "You" : name;
      parts.push(`### ${sender}\n${msg.content}`);
    }
    if (parts.length === 0) return;
    const markdown = parts.join("\n\n---\n\n");
    void navigator.clipboard.writeText(markdown);
  }, [assistantIdentityName, activeConversation?.title]);

  return {
    handleForkConversation,
    handleForkConversationFromMenu,
    handleAnalyzeConversation,
    handleOpenInNewWindow,
    handleInspectConversation,
    handleInspectMessage,
    handleCopyConversation,
    feedbackOpen,
    setFeedbackOpen,
    handleShareFeedback,
  };
}
