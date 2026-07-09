
import { useCallback, useState } from "react";
import type { FC } from "react";

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { downloadAttachment } from "@/domains/chat/components/chat-attachments/download-attachment";
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
 * In-bubble attachment renderer for sent user messages. Image attachments with
 * a usable `previewUrl` render as large inline previews; every other
 * attachment (non-images, plus images whose preview is missing) renders as a
 * compact {@link MessageAttachmentSquare} chip. Both kinds are clickable and
 * open the full-screen {@link AttachmentPreviewModal}.
 *
 * Distinct from {@link MessageAttachments}, the legacy separate-strip renderer
 * still used for assistant messages, which renders every attachment as a chip.
 */
export const BubbleAttachments: FC<BubbleAttachmentsProps> = ({
  attachments,
  assistantId,
}) => {
  const { openPreview, previewModal } = useAttachmentPreview(assistantId, attachments);

  // Ids whose previewUrl the browser failed to decode (e.g. a HEIC blob on a
  // Chromium renderer). Those fall back to the chip instead of the browser's
  // broken-image glyph.
  const [failedImageIds, setFailedImageIds] = useState<ReadonlySet<string>>(new Set());
  const markImageFailed = useCallback((id: string) => {
    setFailedImageIds((prev) => new Set(prev).add(id));
  }, []);

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
        {attachments.map((att) => {
          const imageFailed = failedImageIds.has(att.id);
          const isInlineImage =
            classifyAttachment(att.mimeType, att.filename) === "image" &&
            att.previewUrl != null &&
            !imageFailed;

          if (isInlineImage) {
            return (
              <img
                key={att.id}
                src={att.previewUrl ?? undefined}
                alt={att.filename}
                role="button"
                aria-label={att.filename}
                title={att.filename}
                tabIndex={0}
                onClick={() => openPreview(att)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openPreview(att);
                  }
                }}
                onError={() => markImageFailed(att.id)}
                className="max-h-[320px] max-w-full cursor-pointer rounded-lg object-contain"
              />
            );
          }

          // A failed inline decode leaves a dead previewUrl (e.g. an
          // undecodable HEIC blob on Chromium). Sanitize it so the chip and
          // the full-screen modal both fall back to fetching stored bytes
          // instead of reusing the broken blob.
          const previewAttachment = imageFailed
            ? { ...att, previewUrl: null }
            : att;

          return (
            <MessageAttachmentSquare
              key={att.id}
              filename={att.filename}
              mimeType={att.mimeType}
              sizeBytes={att.sizeBytes}
              previewUrl={previewAttachment.previewUrl}
              thumbnailUrl={att.thumbnailUrl}
              onPreview={() => openPreview(previewAttachment)}
              onDownload={() => handleDownload(att)}
            />
          );
        })}
      </div>
      {previewModal}
    </>
  );
};
