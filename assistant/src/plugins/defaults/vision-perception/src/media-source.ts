/**
 * Resolve a vision media reference (an attachment id) into a provider
 * `ImageContent` block.
 *
 * Reads the attachment row and bytes from the assistant's own attachment store,
 * validates that the reference points to an existing IMAGE (videos and other
 * kinds are rejected), and runs the bytes through `optimizeImageForTransport`
 * before building the base64 image block the vision call site sends.
 *
 * The attachment store is imported in-tree (relative) rather than from
 * `@vellumai/plugin-api`, which does not export it.
 */

import { optimizeImageForTransport } from "../../../../agent/image-optimize.js";
import {
  getAttachmentById,
  getAttachmentContent,
} from "../../../../memory/attachments-store.js";
import type { ImageContent } from "../../../../providers/types.js";

/**
 * Raised when a media reference cannot be resolved to a usable image — the
 * attachment is missing, has no readable bytes, or is not an image. Tools
 * convert this into a `{ isError: true }` result rather than throwing.
 */
export class VisionMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionMediaError";
  }
}

export interface ResolvedVisionMedia {
  block: ImageContent;
  mimeType: string;
  kind: string;
  filename: string;
}

/**
 * Resolve an attachment id to an optimized `ImageContent` block plus its
 * metadata. Throws {@link VisionMediaError} on a missing / non-image / unreadable
 * reference.
 */
export async function resolveVisionMedia(
  mediaRef: string,
): Promise<ResolvedVisionMedia> {
  const ref = mediaRef?.trim();
  if (!ref) {
    throw new VisionMediaError("No media reference was provided.");
  }

  const row = getAttachmentById(ref);
  if (!row) {
    throw new VisionMediaError(`No attachment found for media_ref "${ref}".`);
  }

  if (row.kind !== "image") {
    throw new VisionMediaError(
      `Attachment "${ref}" is a ${row.kind}, not an image. ` +
        "Only images can be read by the vision tools.",
    );
  }

  const bytes = getAttachmentContent(ref);
  if (!bytes || bytes.length === 0) {
    throw new VisionMediaError(
      `Attachment "${ref}" has no readable image content.`,
    );
  }

  const optimized = optimizeImageForTransport(
    bytes.toString("base64"),
    row.mimeType,
  );

  const block: ImageContent = {
    type: "image",
    source: {
      type: "base64",
      media_type: optimized.mediaType,
      data: optimized.data,
    },
  };

  return {
    block,
    mimeType: optimized.mediaType,
    kind: row.kind,
    filename: row.originalFilename,
  };
}
