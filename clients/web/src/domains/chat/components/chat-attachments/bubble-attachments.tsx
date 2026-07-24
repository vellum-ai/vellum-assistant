import { useCallback, useMemo, useState } from "react";
import type { FC } from "react";

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { downloadAttachment } from "@/domains/chat/components/chat-attachments/download-attachment";
import { LazyAttachmentImage } from "@/domains/chat/components/chat-attachments/lazy-attachment-image";
import { MessageAttachmentSquare } from "@/domains/chat/components/chat-attachments/message-attachment-square";
import { useAttachmentPreview } from "@/domains/chat/components/chat-attachments/use-attachment-preview";
import { classifyAttachment } from "@/domains/chat/components/chat-attachments/utils";

interface BubbleAttachmentsProps {
  attachments: DisplayAttachment[];
  /** Forwarded to {@link AttachmentPreviewModal} so it can lazily fetch
   *  attachment content when `previewUrl` is missing. */
  assistantId?: string | null;
}

/**
 * In-bubble attachment renderer for sent user messages. Image attachments
 * reserve a large stable preview slot and load missing display bytes near the
 * viewport. Non-images and failed image previews render as compact
 * {@link MessageAttachmentSquare} chips. Both kinds are clickable and open the
 * full-screen {@link AttachmentPreviewModal}.
 *
 * Distinct from {@link MessageAttachments}, the legacy separate-strip renderer
 * still used for assistant messages, which renders every attachment as a chip.
 */
export const BubbleAttachments: FC<BubbleAttachmentsProps> = ({
  attachments,
  assistantId,
}) => {
  // Ids whose previewUrl the browser failed to decode (e.g. a HEIC blob on a
  // Chromium renderer). Those fall back to the chip instead of the browser's
  // broken-image glyph.
  const [failedImageIds, setFailedImageIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const markImageFailed = useCallback((id: string) => {
    setFailedImageIds((prev) => new Set(prev).add(id));
  }, []);

  // A failed inline decode leaves a dead previewUrl (e.g. an undecodable HEIC
  // blob on Chromium). Nulling it by id across the whole array — which is also
  // forwarded as the modal's `siblingAttachments` — makes the chip, the modal,
  // and gallery navigation all refetch stored bytes instead of the broken blob.
  const previewAttachments = useMemo(
    () =>
      attachments.map((att) =>
        failedImageIds.has(att.id) ? { ...att, previewUrl: null } : att,
      ),
    [attachments, failedImageIds],
  );

  const { openPreview, previewModal } = useAttachmentPreview(
    assistantId,
    previewAttachments,
  );

  const handleDownload = useCallback(
    (att: DisplayAttachment) => {
      void downloadAttachment(att, assistantId);
    },
    [assistantId],
  );

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {previewAttachments.map((att, index) => {
          const isInlineImage =
            classifyAttachment(att.mimeType, att.filename) === "image" &&
            !failedImageIds.has(att.id);

          if (isInlineImage) {
            return (
              <button
                key={att.id}
                type="button"
                aria-label={att.filename}
                title={att.filename}
                onClick={() => openPreview(att)}
                className="w-fit max-w-full cursor-pointer rounded-lg text-left"
              >
                <LazyAttachmentImage
                  assistantId={assistantId}
                  attachmentId={att.id}
                  filename={att.filename}
                  inlinePreviewUrl={att.previewUrl}
                  size="inline"
                  onDecodeError={() => markImageFailed(att.id)}
                />
              </button>
            );
          }

          return (
            <MessageAttachmentSquare
              key={att.id}
              attachmentId={att.id}
              assistantId={assistantId}
              filename={att.filename}
              mimeType={att.mimeType}
              sizeBytes={att.sizeBytes}
              previewUrl={att.previewUrl}
              thumbnailUrl={att.thumbnailUrl}
              onPreview={() => openPreview(att)}
              // Download falls back to previewUrl when the daemon content fetch
              // is unavailable, so it takes the unsanitized attachment — a blob
              // that can't be *rendered* is still valid bytes to save.
              onDownload={() => handleDownload(attachments[index]!)}
            />
          );
        })}
      </div>
      {previewModal}
    </>
  );
};
