/**
 * Conversation secondary actions — fork, analyze, inspect, open-in-new-window,
 * copy transcript, and share-feedback modal state.
 *
 * These are the "utility" actions surfaced in the conversation header chevron
 * menu and sidebar context menu. The primary CRUD-like actions (archive,
 * unarchive, pin, rename, mark read/unread) live in `useConversationActions`.
 *
 * Framework-agnostic: Next.js routing is abstracted behind the `pushRoute` /
 * `pushConversationKeyParam` adapters so this hook can move to a Vite + React
 * Router SPA without changes.
 */

import * as Sentry from "@sentry/react";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useState,
} from "react";

import type { Conversation } from "@/domains/chat/lib/conversations.js";
import { analyzeConversation, forkConversation } from "@/domains/chat/lib/conversations.js";
import { routes } from "@/utils/routes.js";
import { haptic } from "@/utils/haptics.js";
import type { DisplayMessage } from "@/domains/chat/lib/reconcile.js";
import type { ChatError } from "@/domains/chat/types.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface UseConversationSecondaryActionsParams {
  assistantId: string | null;
  activeConversationKey: string | null;
  activeConversation: Conversation | null | undefined;
  assistantIdentityName: string | undefined;
  messagesRef: MutableRefObject<DisplayMessage[]>;
  refreshConversations: () => void;
  switchConversation: (key: string) => void;
  setError: (error: ChatError | null) => void;
  /** Navigate to a conversation key (sets `?conversationKey=<key>` in URL). */
  pushConversationKeyParam: (key: string) => void;
  /** Generic route push — framework adapter for `router.push`. */
  pushRoute: (url: string) => void;
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
  activeConversationKey,
  activeConversation,
  assistantIdentityName,
  messagesRef,
  refreshConversations,
  switchConversation,
  setError,
  pushConversationKeyParam,
  pushRoute,
}: UseConversationSecondaryActionsParams): UseConversationSecondaryActionsReturn {
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const handleForkConversation = useCallback(
    async (throughMessageId: string) => {
      if (!assistantId || !activeConversationKey) {
        return;
      }
      haptic.light();

      try {
        const { conversationId: newConversationId } = await forkConversation(
          assistantId,
          activeConversationKey,
          throughMessageId,
        );
        refreshConversations();
        pushConversationKeyParam(newConversationId);
      } catch (err) {
        Sentry.captureException(err, {
          tags: { context: "fork_conversation" },
        });
      }
    },
    [activeConversationKey, assistantId, refreshConversations, pushConversationKeyParam],
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
          conversation.conversationKey,
        );
        await refreshConversations();
        switchConversation(result.conversationKey);
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
      const params = new URLSearchParams(window.location.search);
      params.set("conversationKey", conversation.conversationKey);
      window.open(`${window.location.pathname}?${params.toString()}`, "_blank");
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
      params.set("conversationKey", conversation.conversationKey);
      const isActiveConversation =
        conversation.conversationKey === activeConversation?.conversationKey;
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
      pushRoute(`${routes.inspect}?${params.toString()}`);
    },
    [pushRoute, activeConversation?.conversationKey],
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
    handleCopyConversation,
    feedbackOpen,
    setFeedbackOpen,
    handleShareFeedback,
  };
}
