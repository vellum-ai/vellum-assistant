/**
 * Submit logic for the composer pinned to the mobile document editor
 * (`MobileDocumentOverlay`). Mirrors the shape of `useComposerSubmit` —
 * assemble content/attachments, clear draft state, send — but scoped to the
 * `"document"` composer-store slot and a fixed target conversation instead of
 * whatever conversation is globally "active".
 *
 * Deliberately thinner than `useComposerSubmit` + `useSendMessage`: this
 * surface has no transcript to reconcile against, so there is no optimistic
 * message row, no turn-store phase flip, and no SSE stream to fold — just a
 * direct POST and a local status the caller renders (see LUM-3384 plan §2,
 * "Option A").
 *
 * Also owns the reply/confirmation surface (plan §3): a "Sent" toast with a
 * "View conversation" action on send, and a follow-up "Assistant replied"
 * toast once `processingConversationIds` clears for the conversation the
 * message landed in — the same primitive that already drives sidebar
 * "processing" spinners for background conversations, so this surface picks
 * up reply status for free rather than polling or duplicating SSE handling.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { toast } from "@vellumai/design-library/components/toast";

import { postChatMessage } from "@/domains/chat/api/messages";
import {
  selectUploadedIds,
  selectUploadingCount,
  useComposerStore,
} from "@/domains/chat/composer-store";
import {
  linkDocumentConversationIfNeeded,
  resolveDocumentConversationId,
  type DocumentConversationRef,
} from "@/domains/chat/utils/document-conversation";
import { resolvePostError } from "@/domains/chat/utils/send-message-utils";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranslation } from "@/i18n";

export type DocumentComposerSendStatus = "idle" | "sending" | "sent" | "error";

export interface UseDocumentComposerSubmitParams {
  assistantId: string | null;
  doc: DocumentConversationRef | null;
}

export interface DocumentComposerSubmitResult {
  /** Drives the composer's disabled state and the inline "Sent" micro-state. */
  status: DocumentComposerSendStatus;
  /** Sends whatever is currently in the `"document"` composer slot. */
  submit: () => Promise<void>;
}

/** How long the inline "Sent" micro-state stays up before fading, mirroring
 *  the autosave "saved" pattern in `document-viewer-container.tsx`. */
const SENT_STATUS_MS = 1500;

export function useDocumentComposerSubmit({
  assistantId,
  doc,
}: UseDocumentComposerSubmitParams): DocumentComposerSubmitResult {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  const [status, setStatus] = useState<DocumentComposerSendStatus>("idle");
  // Conversation to watch for a reply, independent of `doc`/`status`: the
  // user may close the document (unmounting nothing here — `MobileDocumentOverlay`
  // stays mounted and just renders `null`, see its docstring) before the
  // assistant answers, and the "Assistant replied" toast must still fire.
  const [awaitingReplyFor, setAwaitingReplyFor] = useState<string | null>(null);

  // Auto-fade the "Sent" micro-state.
  useEffect(() => {
    if (status !== "sent") {
      return;
    }
    const id = setTimeout(() => setStatus("idle"), SENT_STATUS_MS);
    return () => clearTimeout(id);
  }, [status]);

  // Follow-up "Assistant replied" toast once the conversation stops processing.
  useEffect(() => {
    if (!awaitingReplyFor) {
      return;
    }
    const conversationId = awaitingReplyFor;
    const unsubscribe = useConversationStore.subscribe((state, prev) => {
      if (
        prev.processingConversationIds.has(conversationId) &&
        !state.processingConversationIds.has(conversationId)
      ) {
        toast.success(t("documentComposer.assistantRepliedToast"), {
          action: {
            label: t("documentComposer.viewReply"),
            onClick: () => navigateToConversation(navigate, conversationId),
          },
        });
        setAwaitingReplyFor(null);
      }
    });
    return unsubscribe;
  }, [awaitingReplyFor, navigate, t]);

  const submit = useCallback(async () => {
    if (!assistantId || !doc) {
      return;
    }

    const { documentInput, documentAttachments } = useComposerStore.getState();
    const content = documentInput.trim();
    const attachmentIds = selectUploadedIds(documentAttachments);
    // Mirrors `useComposerSubmit`'s empty-content guard (minus staged
    // quotes/channel reference, which have no equivalent on this surface —
    // see `chat-composer.tsx`'s `slot === "main"` gate on those two stores).
    if (!content && attachmentIds.length === 0) {
      return;
    }
    if (selectUploadingCount(documentAttachments) > 0) {
      return;
    }

    setStatus("sending");
    try {
      const conversationId = resolveDocumentConversationId(doc, assistantId);
      await linkDocumentConversationIfNeeded(doc, assistantId, conversationId);

      const result = await postChatMessage(
        assistantId,
        conversationId,
        content,
        { attachmentIds },
      );

      if (!result.ok) {
        setStatus("error");
        toast.error(
          resolvePostError(
            result.error.code,
            result.error.detail,
            t("documentComposer.sendFailed"),
          ),
        );
        return;
      }

      useConversationStore
        .getState()
        .addProcessingConversationId(conversationId);
      useComposerStore.getState().setInput("", "document");
      useComposerStore.getState().resetAttachments("document");
      setStatus("sent");
      setAwaitingReplyFor(conversationId);
      toast.info(t("documentComposer.messageSentToast"), {
        action: {
          label: t("documentComposer.viewConversation"),
          onClick: () => navigateToConversation(navigate, conversationId),
        },
      });
    } catch {
      setStatus("error");
      toast.error(t("documentComposer.sendFailed"));
    }
  }, [assistantId, doc, navigate, t]);

  return { status, submit };
}
