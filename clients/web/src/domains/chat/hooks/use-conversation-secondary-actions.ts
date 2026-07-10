/**
 * Conversation secondary actions — fork, inspect, open-in-new-window,
 * copy transcript, and share-feedback modal state.
 *
 * These are the "utility" actions surfaced in the conversation header chevron
 * menu and sidebar context menu. The primary CRUD-like actions (archive,
 * unarchive, pin, rename, mark read/unread) live in `useConversationActions`.
 */

import { captureError } from "@/lib/sentry/capture-error";
import {
  useCallback,
  useEffect,
  useRef,
} from "react";

import { useNavigate } from "react-router";
import { toast } from "@vellumai/design-library";

import type { Conversation } from "@/types/conversation-types";
import {
  conversationsForkPost,
  conversationsSummarizePost,
} from "@/generated/daemon/sdk.gen";
import { ApiError } from "@/utils/api-errors";
import { isElectron } from "@/runtime/is-electron";
import { openPopoutWindow } from "@/runtime/popout-window";
import { routes } from "@/utils/routes";
import { haptic } from "@/utils/haptics";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface UseConversationSecondaryActionsParams {
  activeConversation: Conversation | null | undefined;
  refreshConversations: () => void;
}

// ---------------------------------------------------------------------------
// Return
// ---------------------------------------------------------------------------

export interface UseConversationSecondaryActionsReturn {
  handleForkConversation: (throughMessageId: string) => Promise<void>;
  handleForkConversationFromMenu: () => void;
  handleSummarizeUpToMessage: (beforeMessageId: string) => Promise<void>;
  handleOpenInNewWindow: (conversation: Conversation) => void;
  handleInspectConversation: (conversation: Conversation) => void;
  handleInspectMessage: (messageId: string) => void;
  handleCopyConversation: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A turn is headed by its user message: the user message plus the
// assistant responses it produced share one group of LLM calls. Maps any
// message in the active transcript to its turn's heading user message so
// the inspector scope always matches an entry in its filter dropdown.
function turnHeadMessageId(
  messageId: string,
  messages: DisplayMessage[],
): string {
  const index = messages.findIndex((m) => m.id === messageId);
  if (index === -1) {
    return messageId;
  }
  for (let i = index; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === "user" && m.id != null) {
      return m.id;
    }
  }
  return messageId;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useConversationSecondaryActions({
  activeConversation,
  refreshConversations,
}: UseConversationSecondaryActionsParams): UseConversationSecondaryActionsReturn {
  const navigate = useNavigate();

  // Fork / inspect / copy operate on the whole conversation. Mirror the derived
  // transcript into a ref so these callbacks can read the latest at call time
  // without taking it as a dependency (that would re-create them — and
  // re-register the header menu — on every streamed token).
  const transcript = useTranscriptMessages();
  const transcriptRef = useRef(transcript);
  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  const handleForkConversation = useCallback(
    async (throughMessageId: string) => {
      const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
      const activeConversationId = useConversationStore.getState().activeConversationId;
      if (!assistantId || !activeConversationId) {
        return;
      }
      haptic.light();

      try {
        const { data } = await conversationsForkPost({
          path: { assistant_id: assistantId },
          body: { conversationId: activeConversationId, throughMessageId },
          throwOnError: true,
        });
        refreshConversations();
        void navigate(routes.conversation(data.conversation.id));
      } catch (err) {
        captureError(err, { context: "fork_conversation" });
      }
    },
    [refreshConversations, navigate],
  );

  // Asks the daemon to summarize everything before `beforeMessageId` in the
  // assistant's working memory. Fire-and-forget from the client's point of
  // view: the daemon acknowledges with 202 and progress/result arrive through
  // the existing turn SSE events, so there is no navigation, list refresh, or
  // history invalidation here.
  const handleSummarizeUpToMessage = useCallback(
    async (beforeMessageId: string) => {
      const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
      const activeConversationId = useConversationStore.getState().activeConversationId;
      if (!assistantId || !activeConversationId) {
        return;
      }
      haptic.light();

      try {
        await conversationsSummarizePost({
          path: { assistant_id: assistantId },
          body: { conversationId: activeConversationId, beforeMessageId },
          throwOnError: true,
        });
      } catch (err) {
        captureError(err, { context: "summarize_up_to_here" });
        toast.error(
          err instanceof ApiError && err.status === 409
            ? "The assistant is busy — try again when the current response finishes"
            : "Couldn't summarize the conversation",
        );
      }
    },
    [],
  );

  const handleForkConversationFromMenu = useCallback(() => {
    const latestPersisted = transcriptRef.current.findLast(
      (m) => m.id != null,
    );
    const throughMessageId = latestPersisted?.id;
    if (!throughMessageId) return;
    void handleForkConversation(throughMessageId);
  }, [handleForkConversation]);

  const handleOpenInNewWindow = useCallback(
    (conversation: Conversation) => {
      if (isElectron()) {
        void openPopoutWindow(conversation.conversationId);
      } else {
        window.open(routes.conversation(conversation.conversationId), "_blank");
      }
    },
    [],
  );

  // Navigate to the per-conversation LLM context inspector. The
  // conversation lives in the path;
  // `?messageId=` scopes to one turn. A turn is headed by its user
  // message, so we always seed the scope with a user message id — the
  // inspector's filter dropdown only lists user-headed turns. We default
  // to the most recent turn, but only when the target conversation is
  // the currently active one — the chat session store always holds the
  // active transcript, so using it for a different conversation would
  // produce a mismatched (conversationId, messageId) pair and show the
  // wrong LLM context in the inspector.
  const handleInspectConversation = useCallback(
    (conversation: Conversation) => {
      const params = new URLSearchParams();
      const currentActiveId = useConversationStore.getState().activeConversationId;
      if (conversation.conversationId === currentActiveId) {
        const latestUser = transcriptRef.current.findLast(
          (m) => m.role === "user" && m.id != null,
        );
        const messageId = latestUser?.id;
        if (messageId) {
          params.set("messageId", messageId);
        }
      }
      const qs = params.toString();
      const base = routes.inspect(conversation.conversationId);
      void navigate(qs ? `${base}?${qs}` : base);
    },
    [navigate],
  );

  const handleInspectMessage = useCallback(
    (messageId: string) => {
      const activeConversationId = useConversationStore.getState().activeConversationId;
      if (!activeConversationId) return;
      const params = new URLSearchParams();
      params.set("messageId", turnHeadMessageId(messageId, transcriptRef.current));
      void navigate(
        `${routes.inspect(activeConversationId)}?${params.toString()}`,
      );
    },
    [navigate],
  );

  const handleCopyConversation = useCallback(() => {
    const name = useAssistantIdentityStore.getState().name ?? "Assistant";
    const parts: string[] = [];
    if (activeConversation?.title) {
      parts.push(`# ${activeConversation.title}`);
    }
    for (const msg of transcriptRef.current) {
      const text = messagePlainText(msg);
      if (!text.trim()) continue;
      const sender = msg.role === "user" ? "You" : name;
      parts.push(`### ${sender}\n${text}`);
    }
    if (parts.length === 0) return;
    const markdown = parts.join("\n\n---\n\n");
    void navigator.clipboard.writeText(markdown);
  }, [activeConversation?.title]);

  return {
    handleForkConversation,
    handleForkConversationFromMenu,
    handleSummarizeUpToMessage,
    handleOpenInNewWindow,
    handleInspectConversation,
    handleInspectMessage,
    handleCopyConversation,
  };
}
