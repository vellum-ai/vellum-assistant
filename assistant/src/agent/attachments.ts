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
 * A user attachment that has already been materialized into an attachment-store
 * row, described by the fields needed to build a persisted `workspace_ref`
 * content block: the row id, the stored (post-normalization) MIME type and byte
 * size, and — for images — the pixel dimensions the model will receive. The raw
 * bytes are NOT carried here; they live in the attachment store and are read
 * back only at the provider send boundary.
 */
export interface AttachmentReferenceInput {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  extractedText?: string;
}

/**
 * Build the persisted content blocks for user attachments as workspace
 * references (`workspace_ref`) rather than inline base64, so the large blob
 * stays in the attachment store instead of the `messages.content` row and the
 * lexical index. The bytes are resolved back to base64 at the provider send
 * boundary (`resolveMediaReferences`) and fetched by clients on render.
 */
export function attachmentsToReferenceBlocks(
  refs: AttachmentReferenceInput[],
): ContentBlock[] {
  return refs.map((ref) => {
    if (ref.mimeType.toLowerCase().startsWith("image/")) {
      return {
        type: "image",
        source: {
          type: "workspace_ref",
          media_type: ref.mimeType,
          attachmentId: ref.attachmentId,
          sizeBytes: ref.sizeBytes,
          ...(ref.width != null ? { width: ref.width } : {}),
          ...(ref.height != null ? { height: ref.height } : {}),
        },
      } as ContentBlock;
    }

    return {
      type: "file",
      source: {
        type: "workspace_ref",
        media_type: ref.mimeType,
        attachmentId: ref.attachmentId,
        sizeBytes: ref.sizeBytes,
        filename: ref.filename,
      },
      extracted_text: ref.extractedText,
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
