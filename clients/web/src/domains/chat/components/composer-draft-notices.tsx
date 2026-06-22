import { useEffect } from "react";

import { Notice } from "@vellumai/design-library";

import {
  selectUploadedIds,
  selectUploadingCount,
  useComposerStore,
} from "@/domains/chat/composer-store";
import { useConversationStore } from "@/stores/conversation-store";

/**
 * Composer-owned notice stack, rendered at the top of the composer above the
 * orchestration banners. Self-sources everything it needs from `composer-store`
 * (plus the active conversation id) so the chat orchestrator never subscribes to
 * draft/attachment state — attaching a file or restoring a draft re-renders only
 * this component, not the transcript.
 *
 * Owns the restored-draft notice lifecycle: it auto-dismisses after a few
 * seconds and clears when the active conversation no longer matches the
 * conversation whose draft was restored.
 */
export function ComposerDraftNotices() {
  const hasText = useComposerStore((s) => s.input.trim().length > 0);
  const attachments = useComposerStore.use.attachments();
  const attachmentLastError = useComposerStore.use.attachmentLastError();
  const restoredDraftConversationId =
    useComposerStore.use.restoredDraftConversationId();
  const activeConversationId = useConversationStore.use.activeConversationId();

  const uploadingCount = selectUploadingCount(attachments);
  const showUploadBlocked =
    uploadingCount > 0 && (hasText || selectUploadedIds(attachments).length > 0);
  const showRestoredDraft =
    restoredDraftConversationId !== null &&
    restoredDraftConversationId === activeConversationId;

  // Auto-dismiss the restored-draft notice after a few seconds.
  useEffect(() => {
    if (!showRestoredDraft) return;
    const id = window.setTimeout(
      () => useComposerStore.getState().clearRestoredDraftNotice(),
      5000,
    );
    return () => window.clearTimeout(id);
  }, [showRestoredDraft]);

  // Drop a stale restored-draft marker carried over from a previous conversation.
  useEffect(() => {
    if (
      restoredDraftConversationId !== null &&
      restoredDraftConversationId !== activeConversationId
    ) {
      useComposerStore.getState().clearRestoredDraftNotice();
    }
  }, [activeConversationId, restoredDraftConversationId]);

  return (
    <>
      {showUploadBlocked && (
        <div className="mb-2">
          <Notice tone="info">
            {uploadingCount === 1
              ? "Waiting for the attachment to finish uploading before sending."
              : `Waiting for ${uploadingCount} attachments to finish uploading before sending.`}
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
            Draft restored from your previous session.
          </Notice>
        </div>
      )}
      {attachmentLastError && (
        <div className="mb-2">
          <Notice
            tone="error"
            onDismiss={() =>
              useComposerStore.getState().dismissAttachmentError()
            }
          >
            {attachmentLastError}
          </Notice>
        </div>
      )}
    </>
  );
}
