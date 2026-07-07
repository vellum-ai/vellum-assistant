import { parseImageDimensions } from "../context/image-dimensions.js";
import type { ContentBlock, Message } from "../providers/types.js";
import { optimizeImageForTransport } from "./image-optimize.js";

export interface MessageAttachmentInput {
  id?: string;
  filename: string;
  mimeType: string;
  data: string;
  extractedText?: string;
  filePath?: string;
  /**
   * Path of the canonical copy in the conversation's attachments/ directory,
   * known once the attachment is linked to a message. Name collisions are
   * resolved with a -2/-3 suffix, so this may differ from `filename` — and
   * from `filePath`, which is where the upload originally came from.
   */
  storedPath?: string;
}

/**
 * A user attachment that has been linked to a message and is ready to be
 * PERSISTED as a reference block (see {@link attachmentsToReferenceBlocks}).
 * Unlike {@link MessageAttachmentInput}, `attachmentId` is the final linked
 * attachment-row id, and `data` is present only so image pixel dimensions can
 * be derived at persist time — it is never stored.
 */
export interface AttachmentReferenceInput {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Base64 payload, used only to derive image dimensions; not persisted. */
  data?: string;
  extractedText?: string;
}

/**
 * Build the PERSISTED content blocks for a user message's attachments as
 * workspace references — no inline base64. Mirrors the block shape of
 * {@link attachmentsToContentBlocks} (image vs file) but the `source` is an
 * `attachment_ref` addressing the workspace attachment store, carrying
 * size/dimension hints so size-only consumers (the token estimator) need not
 * read the file. The bytes are resolved back at the provider boundary via
 * `resolveMediaReferences`.
 */
export function attachmentsToReferenceBlocks(
  attachments: AttachmentReferenceInput[],
): ContentBlock[] {
  return attachments.map((attachment) => {
    if (attachment.mimeType.toLowerCase().startsWith("image/")) {
      const dims = attachment.data
        ? parseImageDimensions(attachment.data, attachment.mimeType)
        : null;
      return {
        type: "image",
        source: {
          type: "attachment_ref",
          media_type: attachment.mimeType,
          attachmentId: attachment.attachmentId,
          sizeBytes: attachment.sizeBytes,
          ...(dims ? { width: dims.width, height: dims.height } : {}),
        },
      } as ContentBlock;
    }

    return {
      type: "file",
      source: {
        type: "attachment_ref",
        media_type: attachment.mimeType,
        attachmentId: attachment.attachmentId,
        filename: attachment.filename,
        sizeBytes: attachment.sizeBytes,
      },
      ...(attachment.extractedText
        ? { extracted_text: attachment.extractedText }
        : {}),
      _attachmentId: attachment.attachmentId,
    } as ContentBlock;
  });
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
 * Annotation line for where an attached image originally came from (e.g. a
 * desktop client path). Shared with the history-reload reinjection so the
 * reloaded content block stays byte-identical to the one built at persist
 * time (prefix-cache parity).
 */
export function formatImageSourceAnnotation(filePath: string): string {
  return `[Attached image source: ${filePath}]`;
}

/**
 * Annotation line binding an attachment's user-facing filename to its
 * canonical on-disk copy. The stored path is the one the model must use to
 * read the attachment — the plain filename in the attachments/ directory may
 * belong to an older upload with the same name. Shared with the
 * history-reload reinjection (prefix-cache parity).
 */
export function formatStoredPathAnnotation(
  filename: string,
  storedPath: string,
): string {
  return `[Attachment "${filename}" is stored at: ${storedPath}]`;
}

/**
 * Return a copy of the message with text annotations for attachment paths:
 * source paths for images (where the file came from) and stored paths for
 * any attachment whose canonical copy in the conversation's attachments/
 * directory is known. The annotations are appended as a text content block
 * so the LLM knows where to find the files on disk. The caller should
 * persist the ORIGINAL message (without annotations) so the UI stays clean.
 */
export function enrichMessageWithSourcePaths(
  message: Message,
  attachments: MessageAttachmentInput[],
): Message {
  const lines: string[] = [];
  for (const a of attachments) {
    if (a.mimeType.toLowerCase().startsWith("image/") && a.filePath) {
      lines.push(formatImageSourceAnnotation(a.filePath));
    }
  }
  for (const a of attachments) {
    if (a.storedPath) {
      lines.push(formatStoredPathAnnotation(a.filename, a.storedPath));
    }
  }
  if (lines.length === 0) {
    return message;
  }

  return {
    ...message,
    content: [
      ...message.content,
      { type: "text" as const, text: lines.join("\n") },
    ],
  };
}
