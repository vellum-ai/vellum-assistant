import type { FC } from "react";

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { useAttachmentSquares } from "@/domains/chat/components/chat-attachments/use-attachment-squares";
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
 * Every attachment renders - this surface is deliberately uncapped, unlike the
 * assistant strip ({@link MessageAttachments}), which collapses past a limit
 * behind an overflow tile.
 */
export const BubbleAttachments: FC<BubbleAttachmentsProps> = ({
  attachments,
  assistantId,
}) => {
  const {
    displayAttachments,
    renderSquare,
    openPreview,
    markImageFailed,
    previewModal,
  } = useAttachmentSquares({ attachments, assistantId });

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {displayAttachments.map((att, index) => {
          const isInlineImage =
            classifyAttachment(att.mimeType, att.filename) === "image" &&
            att.previewUrl != null;

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

          return renderSquare(att, index);
        })}
      </div>
      {previewModal}
    </>
  );
};
