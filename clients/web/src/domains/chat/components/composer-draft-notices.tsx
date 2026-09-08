import { useEffect } from "react";

import { useTranslation } from "@/i18n";

import { Notice } from "@vellumai/design-library";

import {
  type ComposerSlot,
  selectUploadedIds,
  selectUploadingCount,
  useComposerStore,
} from "@/domains/chat/composer-store";
import { useConversationStore } from "@/stores/conversation-store";

export interface ComposerDraftNoticesProps {
  /** Which `composer-store` slot to source notices from. Defaults to `"main"`. */
  slot?: ComposerSlot;
}

/**
 * Composer-owned notice stack, rendered at the top of the composer above the
 * orchestration banners. Self-sources everything it needs from `composer-store`
 * (plus the active conversation id) so the chat orchestrator never subscribes to
 * draft/attachment state — attaching a file or restoring a draft re-renders only
 * this component, not the transcript.
 *
 * Owns the restored-draft notice lifecycle: it auto-dismisses after a few
 * seconds and clears when the active conversation no longer matches the
 * conversation whose draft was restored. That lifecycle is a "main"-slot-only
 * concern — the document composer has no draft persistence (see
 * `ComposerSlot`), so a `"document"` instance never shows the restored-draft
 * notice.
 */
export function ComposerDraftNotices({
  slot = "main",
}: ComposerDraftNoticesProps) {
  const { t } = useTranslation("chat");
  const hasText = useComposerStore(
    (s) => (slot === "document" ? s.documentInput : s.input).trim().length > 0,
  );
  const attachments = useComposerStore((s) =>
    slot === "document" ? s.documentAttachments : s.attachments,
  );
  const attachmentLastError = useComposerStore((s) =>
    slot === "document" ? s.documentAttachmentLastError : s.attachmentLastError,
  );
  const restoredDraftConversationId =
    useComposerStore.use.restoredDraftConversationId();
  const activeConversationId = useConversationStore.use.activeConversationId();

  const uploadingCount = selectUploadingCount(attachments);
  const showUploadBlocked =
    uploadingCount > 0 &&
    (hasText || selectUploadedIds(attachments).length > 0);
  const showRestoredDraft =
    slot === "main" &&
    restoredDraftConversationId !== null &&
    restoredDraftConversationId === activeConversationId;

  // Auto-dismiss the restored-draft notice after a few seconds.
  useEffect(() => {
    if (!showRestoredDraft) {
      return;
    }
    const id = window.setTimeout(
      () => useComposerStore.getState().clearRestoredDraftNotice(),
      5000,
    );
    return () => window.clearTimeout(id);
  }, [showRestoredDraft]);

  // Drop a stale restored-draft marker carried over from a previous conversation.
  useEffect(() => {
    if (
      slot === "main" &&
      restoredDraftConversationId !== null &&
      restoredDraftConversationId !== activeConversationId
    ) {
      useComposerStore.getState().clearRestoredDraftNotice();
    }
  }, [activeConversationId, restoredDraftConversationId, slot]);

  return (
    <>
      {showUploadBlocked && (
        <div className="mb-2">
          <Notice tone="info">
            {t("composerDraftNotices.waitingUpload", { count: uploadingCount })}
          </Notice>
        </div>
      )}
      {showRestoredDraft && (
        <div className="mb-2">
          <Notice
            tone="info"
            onDismiss={() =>
              useComposerStore.getState().clearRestoredDraftNotice()
            }
          >
            {t("composerDraftNotices.draftRestored")}
          </Notice>
        </div>
      )}
      {attachmentLastError && (
        <div className="mb-2">
          <Notice
            tone="error"
            onDismiss={() =>
              useComposerStore.getState().dismissAttachmentError(slot)
            }
          >
            {attachmentLastError}
          </Notice>
        </div>
      )}
    </>
  );
}
