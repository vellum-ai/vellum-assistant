import type { ContentBlock, Message } from "../providers/types.js";

export interface MessageAttachmentInput {
  id?: string;
  filename: string;
  mimeType: string;
  data: string;
  extractedText?: string;
}

export function attachmentsToContentBlocks(attachments: MessageAttachmentInput[]): ContentBlock[] {
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

export function createUserMessageWithAttachments(text: string, attachments: MessageAttachmentInput[]): Message {
  const contentBlocks: ContentBlock[] = [];
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    contentBlocks.push({ type: "text", text: trimmed });
  }
  contentBlocks.push(...attachmentsToContentBlocks(attachments));
  return { role: "user", content: contentBlocks };
}
