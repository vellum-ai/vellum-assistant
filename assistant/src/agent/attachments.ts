import type { ContentBlock } from "../providers/types.js";

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
