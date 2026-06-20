/**
 * Resolve a vision media reference (an attachment id) into provider content.
 *
 * Reads the attachment row and bytes from the assistant's own attachment store.
 * Images resolve to a single optimized `ImageContent` block via
 * {@link resolveVisionMedia}; videos resolve to a set of timestamped keyframes
 * via {@link resolveVisionVideo} (delegating to `video-frames.ts`). Other kinds
 * are rejected.
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
import { toImageBlock } from "./image-block.js";
import {
  type SampledVideo,
  sampleVideoFrames,
  type SampleVideoOptions,
  VideoFramesError,
} from "./video-frames.js";

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

  return {
    block: toImageBlock(optimized),
    mimeType: optimized.mediaType,
    kind: row.kind,
    filename: row.originalFilename,
  };
}

/**
 * Resolve a video attachment id to a set of timestamped keyframes plus its
 * metadata. Delegates frame extraction to `video-frames.ts`, which relies on
 * ffmpeg/ffprobe and fails gracefully when those are unavailable. Throws
 * {@link VisionMediaError} on a missing / non-video reference, and re-raises a
 * {@link VideoFramesError} as a {@link VisionMediaError} so callers convert
 * either into a single `{ isError: true }` result.
 */
export async function resolveVisionVideo(
  mediaRef: string,
  options?: SampleVideoOptions,
): Promise<{ video: SampledVideo; filename: string }> {
  const ref = mediaRef?.trim();
  if (!ref) {
    throw new VisionMediaError("No media reference was provided.");
  }

  const row = getAttachmentById(ref);
  if (!row) {
    throw new VisionMediaError(`No attachment found for media_ref "${ref}".`);
  }
  if (row.kind !== "video") {
    throw new VisionMediaError(
      `Attachment "${ref}" is a ${row.kind}, not a video. ` +
        "Only videos can be read by vlm_video_log.",
    );
  }

  try {
    const video = await sampleVideoFrames(ref, options);
    return { video, filename: row.originalFilename };
  } catch (err) {
    if (err instanceof VideoFramesError) {
      throw new VisionMediaError(err.message);
    }
    throw err;
  }
}
