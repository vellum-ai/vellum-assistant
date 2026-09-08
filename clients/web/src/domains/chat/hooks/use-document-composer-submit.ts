/**
 * Submit logic for the composer pinned to a document editor
 * (`MobileDocumentOverlay`, and on mobile, the standalone document route).
 * Mirrors the shape of `useComposerSubmit`: assemble content/attachments,
 * clear draft state, send. Scoped to the `"document"` composer-store slot and
 * a fixed target conversation instead of whatever conversation is globally
 * "active".
 *
 * Deliberately thinner than `useComposerSubmit` + `useSendMessage`: this
 * surface has no transcript to reconcile against, so there is no optimistic
 * message row, no turn-store phase flip, and no SSE stream to fold, just a
 * direct POST and a local status the caller renders.
 *
 * Also raises the inline "Sent" toast with a "View conversation" action on
 * send. The follow-up "Assistant replied" toast is not owned here: this hook
 * lives inside `DocumentComposerPanel`, which unmounts when the host closes
 * the document (`MobileDocumentOverlay` returning `null`, or navigating off
 * the standalone document route), so a subscription kept here would drop a
 * reply that arrives afterward. This hook only records the conversation to
 * watch, via `document-composer-reply-store.ts`; the always-mounted
 * `DocumentComposerReplyWatcher` (in `RootLayout`) owns the subscription and
 * raises the toast.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import { toast } from "@vellumai/design-library/components/toast";

import { postChatMessage } from "@/domains/chat/api/messages";
import {
  selectUploadedIds,
  selectUploadingCount,
  useComposerStore,
} from "@/domains/chat/composer-store";
import { useDocumentComposerReplyStore } from "@/domains/chat/document-composer-reply-store";
import {
  linkDocumentConversationIfNeeded,
  persistDocumentConversationId,
  rekeyOpenedDocumentConversation,
  resolveDocumentConversationId,
  type DocumentConversationRef,
} from "@/domains/chat/utils/document-conversation";
import { resolvePostError } from "@/domains/chat/utils/send-message-utils";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { findConversation } from "@/utils/conversation-cache";
import { useConversationStore } from "@/stores/conversation-store";
import { resolveEditChatDraftConversationId } from "@/utils/edit-chat-session";
import { supportsServerMintedConversation } from "@/lib/backwards-compat/server-minted-conversation";
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
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<DocumentComposerSendStatus>("idle");

  // Auto-fade the "Sent" micro-state.
  useEffect(() => {
    if (status !== "sent") {
      return;
    }
    const id = setTimeout(() => setStatus("idle"), SENT_STATUS_MS);
    return () => clearTimeout(id);
  }, [status]);

  const submit = useCallback(async () => {
    if (!assistantId || !doc) {
      return;
    }

    const { documentInput, documentAttachments } = useComposerStore.getState();
    const content = documentInput.trim();
    const attachmentIds = selectUploadedIds(documentAttachments);
    // Mirrors `useComposerSubmit`'s empty-content guard (minus staged
    // quotes/channel reference, which have no equivalent on this surface: see
    // `chat-composer.tsx`'s `slot === "main"` gate on those two stores).
    if (!content && attachmentIds.length === 0) {
      return;
    }
    if (selectUploadingCount(documentAttachments) > 0) {
      return;
    }

    setStatus("sending");
    try {
      const resolvedId = resolveDocumentConversationId(doc, assistantId);
      // A fresh client-minted id (never sent to the server) can't be sent as
      // a strict-lookup `conversationId` on assistants >= 0.8.6, which 404s
      // on an id it has never minted. Mirrors the server-mint branch in
      // `use-send-message.ts`: omit the conversation id wire field entirely
      // and adopt whatever id the assistant mints in response. A reused
      // cached id is not fresh (it was already resolved, and either sent
      // successfully before or is the document's own id), so it always takes
      // the direct path regardless of assistant support.
      const isFreshDraft =
        useConversationStore.getState().draftConversationIds.has(resolvedId);
      const useServerMint = isFreshDraft && supportsServerMintedConversation();

      if (!useServerMint) {
        await linkDocumentConversationIfNeeded(doc, assistantId, resolvedId);
      }

      // The current `latestAssistantMessageAt` snapshot, seeded the same way
      // `use-send-message.ts` seeds it: without a snapshot, the graduation
      // sweep that clears the sidebar's processing indicator would compare a
      // real timestamp against `undefined` and graduate the key on its very
      // next pass, before the assistant has actually replied. `undefined` for
      // a conversation the client doesn't know about yet (a fresh draft),
      // same as the main send path.
      const snapshot = findConversation(queryClient, assistantId, resolvedId)
        ?.latestAssistantMessageAt;

      const result = await postChatMessage(
        assistantId,
        useServerMint ? null : resolvedId,
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

      const conversationId = result.conversationId;
      if (isFreshDraft) {
        // The row is confirmed to exist server-side now, whether via the
        // mint branch or the legacy conversationKey create-or-lookup, so the
        // client-side draft mark no longer applies.
        useConversationStore.getState().clearDraftConversationId(resolvedId);
      }
      if (useServerMint) {
        if (conversationId !== resolvedId) {
          resolveEditChatDraftConversationId(resolvedId, conversationId);
          // If the document open in the viewer store is the one this mint was
          // for, keep its conversation id in sync so a later submit does not
          // resolve back to the now-dead draft id (see
          // `resolveDocumentConversationId`'s fallback order).
          await rekeyOpenedDocumentConversation(
            assistantId,
            resolvedId,
            conversationId,
          );
        }
        await linkDocumentConversationIfNeeded(doc, assistantId, conversationId);
      }
      persistDocumentConversationId(doc, assistantId, conversationId);

      useConversationStore
        .getState()
        .addProcessingConversationId(conversationId, snapshot);
      useComposerStore.getState().setInput("", "document");
      useComposerStore.getState().resetAttachments("document");
      setStatus("sent");
      useDocumentComposerReplyStore.getState().startAwaitingReply(conversationId);
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
  }, [assistantId, doc, navigate, queryClient, t]);

  return { status, submit };
}
