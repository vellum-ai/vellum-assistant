import type { ContentBlock, Message } from "../providers/types.js";

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
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType,
          data: attachment.data,
        },
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
    } as ContentBlock;
  });
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
