import type { ContentBlock, Message } from "../providers/types.js";
import { optimizeImageForTransport } from "./image-optimize.js";

export interface MessageAttachmentInput {
  id?: string;
  filename: string;
  mimeType: string;
  data: string;
  extractedText?: string;
  filePath?: string;
}

export function attachmentsToContentBlocks(
  attachments: MessageAttachmentInput[],
): ContentBlock[] {
  return attachments.map((attachment) => {
    if (attachment.mimeType.toLowerCase().startsWith("image/")) {
      const { data, mediaType } = optimizeImageForTransport(
        attachment.data,
        attachment.mimeType,
      );
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data,
        },
        ...(attachment.id ? { _attachmentId: attachment.id } : {}),
      } as ContentBlock;
    }

    return {
      type: "file",
      source: {
        type: "base64",
        media_type: attachment.mimeType,
        data: attachment.data,
        filename: attachment.filename,
      },
      extracted_text: attachment.extractedText,
      ...(attachment.id ? { _attachmentId: attachment.id } : {}),
    } as ContentBlock;
  });
}

/**
 * Backfill an attachment id onto the in-memory content block for the
 * `attachmentIndex`-th uploaded attachment.
 *
 * Inline (data-only) uploads have no attachment id when the message body is
 * built — the id is minted later, when the attachment row is created and linked
 * to the persisted message. Without this backfill the image/file block sent to
 * the model never carries `_attachmentId`, so downstream consumers (notably the
 * vision-perception media markers) cannot correlate the block back to a usable
 * `media_ref`.
 *
 * Attachment blocks are appended to `message.content` in attachment order by
 * {@link attachmentsToContentBlocks}, after any leading text block and before
 * any trailing source-path annotation, so the `attachmentIndex`-th `image`/
 * `file` block is the one to tag. Mutates the block in place (the caller holds
 * the same reference the model loop reads). A no-op if the target block is
 * missing or already carries an id.
 */
export function backfillAttachmentId(
  message: Message,
  attachmentIndex: number,
  attachmentId: string,
): void {
  let seen = 0;
  for (const block of message.content) {
    if (block.type !== "image" && block.type !== "file") continue;
    if (seen === attachmentIndex) {
      if (!block._attachmentId) block._attachmentId = attachmentId;
      return;
    }
    seen++;
  }
}

/**
 * Return a copy of the message with text annotations for image source paths.
 * The annotations are appended as a text content block so the LLM knows where
 * the images came from on disk. The caller should persist the ORIGINAL message
 * (without annotations) so the UI stays clean.
 */
export function enrichMessageWithSourcePaths(
  message: Message,
  attachments: MessageAttachmentInput[],
): Message {
  const imageAttachments = attachments.filter(
    (a) => a.mimeType.toLowerCase().startsWith("image/") && a.filePath,
  );
  if (imageAttachments.length === 0) return message;

  const annotation = imageAttachments
    .map((a) => `[Attached image source: ${a.filePath}]`)
    .join("\n");

  return {
    ...message,
    content: [...message.content, { type: "text" as const, text: annotation }],
  };
}
