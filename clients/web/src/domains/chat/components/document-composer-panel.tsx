import { Check } from "lucide-react";
import { useEffect, useRef } from "react";

import { Typography } from "@vellumai/design-library";

import { partitionAttachableFiles } from "@/utils/attachment-utils";
import { ChatComposer } from "@/domains/chat/components/chat-composer/chat-composer";
import { useComposerStore } from "@/domains/chat/composer-store";
import {
  heldMessageFor,
  useDocumentComposerReplyStore,
} from "@/domains/chat/document-composer-reply-store";
import { useDocumentComposerSubmit } from "@/domains/chat/hooks/use-document-composer-submit";
import { useImageAttachmentsAllowed } from "@/domains/chat/hooks/use-image-attachments-allowed";
import {
  peekDocumentConversationRow,
  type DocumentConversationRef,
} from "@/domains/chat/utils/document-conversation";
import { useTranslation } from "@/i18n";
import { useConversationStore } from "@/stores/conversation-store";

export interface DocumentComposerPanelProps {
  assistantId: string | null;
  doc: DocumentConversationRef | null;
}

/**
 * The composer pinned below a document editor, wired to
 * `useDocumentComposerSubmit` and the `"document"` composer-store slot.
 * Shared by `MobileDocumentOverlay` (the in-chat overlay) and, on mobile,
 * `DocumentViewerPage` (the standalone `/documents/:surfaceId` route), so the
 * two entry points send through one wiring rather than two. Both hosts sit in
 * a shell that already pads the bottom safe area, so the panel adds none.
 */
export function DocumentComposerPanel({
  assistantId,
  doc,
}: DocumentComposerPanelProps) {
  const { t } = useTranslation("chat");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // These attachments go to the row the next send targets, which can differ
  // from the id the document was opened against: a draft the daemon retired,
  // or a row a previous send minted for this document. The image gate reads
  // that row's model, not the chat route's. A live draft has no row yet and
  // reads the global profile, and a null is that model still loading, which
  // holds an image back until it is known.
  const ownIsDraft = useConversationStore(
    (s) => doc !== null && s.draftConversationIds.has(doc.conversationId),
  );
  const targetConversationId =
    doc !== null && assistantId !== null
      ? peekDocumentConversationRow(doc, assistantId, ownIsDraft)
      : undefined;
  const imageAttachmentsAllowed = useImageAttachmentsAllowed(
    assistantId,
    targetConversationId,
  );
  const { status, submit } = useDocumentComposerSubmit({
    assistantId,
    doc,
    imageAttachmentsAllowed,
  });

  // Clear the document slot's staged text/attachments whenever the target
  // document changes or the panel unmounts, so a draft typed for one
  // document never carries into another. A host that remounts this panel
  // per document (`MobileDocumentOverlay`'s `key` prop) gets this for free
  // from React, but a host that reuses one panel instance across documents
  // (the standalone `/documents/:surfaceId` route, whose route params can
  // change without remounting `DocumentViewerPage`) has no other hook to
  // clear on, so the cleanup lives here where both hosts share it.
  const surfaceId = doc?.surfaceId ?? null;
  useEffect(() => {
    return () => {
      useComposerStore.getState().setInput("", "document");
      useComposerStore.getState().fullReset("document");
    };
  }, [surfaceId]);

  // The document slot is shared by both document hosts. Register its current
  // owner so a delayed acceptance can retract only a recovery still shown in
  // the same assistant's same document.
  useEffect(() => {
    if (assistantId === null || surfaceId === null) {
      return;
    }
    const replyStore = useDocumentComposerReplyStore.getState();
    replyStore.setActiveDocumentComposer(assistantId, surfaceId);
    return () => {
      useDocumentComposerReplyStore
        .getState()
        .clearActiveDocumentComposer(assistantId, surfaceId);
    };
  }, [assistantId, surfaceId]);

  // A send the daemon reports as failed is held under the assistant it went to
  // and the surface it was composed for, and the panel showing that document
  // for that assistant takes it once the whole document slot is empty: the
  // failure can arrive while the document is open or long after it was
  // closed, and the message waits either way. A draft typed or staged since is
  // never replaced, and never carries half of the failed message into it; the
  // slot empties when that draft is sent or cleared, and the message is taken
  // then.
  const failedSend = useDocumentComposerReplyStore((s) =>
    assistantId === null || surfaceId === null
      ? undefined
      : heldMessageFor(s, assistantId, surfaceId),
  );
  const slotEmpty = useComposerStore(
    (s) => s.documentInput.trim() === "" && s.documentAttachments.length === 0,
  );
  useEffect(() => {
    if (
      assistantId === null ||
      surfaceId === null ||
      failedSend === undefined ||
      !slotEmpty
    ) {
      return;
    }
    const composer = useComposerStore.getState();
    // Re-read at effect time: the slot may have been filled since this render.
    if (
      composer.documentInput.trim() !== "" ||
      composer.documentAttachments.length > 0
    ) {
      return;
    }
    const payload = useDocumentComposerReplyStore
      .getState()
      .takeFailedSend(assistantId, surfaceId);
    if (payload === null) {
      return;
    }
    composer.setInput(payload.content, "document");
    composer.restoreAttachmentsIfEmpty(payload.attachments, "document");
  }, [assistantId, surfaceId, failedSend, slotEmpty]);

  if (!assistantId) {
    return null;
  }

  // A null `doc` is a host with no document for the composer to target, which
  // `useDocumentComposerSubmit` refuses to send against. The panel keeps its
  // place in the layout so nothing jumps, inert until a document arrives.
  const disabled = status === "sending" || !doc;

  return (
    <div className="shrink-0 px-3 pt-2">
      {status === "sent" && (
        <div className="flex items-center justify-center gap-1 pb-1 text-[var(--content-tertiary)]">
          <Check size={12} className="shrink-0" />
          <Typography
            variant="label-small-default"
            className="text-[var(--content-tertiary)]"
          >
            {t("documentComposer.sent")}
          </Typography>
        </div>
      )}
      <ChatComposer
        slot="document"
        assistantId={assistantId}
        placeholder={t("documentComposer.placeholder")}
        inputRef={inputRef}
        typingDisabled={disabled}
        sendDisabled={disabled}
        isAssistantBusy={false}
        onStopGenerating={() => {}}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onAddAttachmentFiles={(files) => {
          const { allowed, droppedImages } = partitionAttachableFiles(
            files,
            imageAttachmentsAllowed === true,
          );
          if (allowed.length > 0) {
            useComposerStore
              .getState()
              .addFiles(allowed, assistantId, "document");
          }
          // Set after `addFiles`, which clears the slot's error on a clean queue.
          if (droppedImages > 0) {
            useComposerStore.setState({
              documentAttachmentLastError:
                imageAttachmentsAllowed === null
                  ? t("composerAttachments.imageGateResolving")
                  : t("composerAttachments.imageNotSupported"),
            });
          }
        }}
      />
    </div>
  );
}
