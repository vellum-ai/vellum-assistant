
import type { FC } from "react";

import type { DisplayAttachment } from "@/domains/chat/types/types";

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
  const { openPreview, previewModal } = useAttachmentPreview(assistantId);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {attachments.map((att) => {
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
                className="max-h-[320px] max-w-full cursor-pointer rounded-lg object-contain"
              />
            );
          }

          return (
            <MessageAttachmentSquare
              key={att.id}
              filename={att.filename}
              mimeType={att.mimeType}
              sizeBytes={att.sizeBytes}
              previewUrl={att.previewUrl}
              onPreview={() => openPreview(att)}
            />
          );
        })}
      </div>
      {previewModal}
    </>
  );
};
