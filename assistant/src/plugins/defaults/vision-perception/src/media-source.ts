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
  isAttachmentInConversation,
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
 * Reject a model-supplied `media_ref` that is not linked to the current
 * conversation. `media_ref` is supplied by the model, so a crafted or
 * previously-seen id from ANOTHER conversation/channel must never resolve to
 * bytes — that would be a cross-conversation data leak. Fails closed: bytes are
 * only read once the id is confirmed to belong to {@link conversationId}.
 */
function assertMediaRefInConversation(
  ref: string,
  conversationId: string,
): void {
  if (!isAttachmentInConversation(ref, conversationId)) {
    throw new VisionMediaError(`No attachment found for media_ref "${ref}".`);
  }
}

/**
 * Resolve an attachment id to an optimized `ImageContent` block plus its
 * metadata. The `conversationId` (from the tool's `ToolContext`) scopes the
 * lookup: an id not linked to the current conversation is rejected before any
 * bytes are read. Throws {@link VisionMediaError} on a missing / non-image /
 * unreadable / out-of-conversation reference.
 */
export async function resolveVisionMedia(
  mediaRef: string,
  conversationId: string,
): Promise<ResolvedVisionMedia> {
  const ref = mediaRef?.trim();
  if (!ref) {
    throw new VisionMediaError("No media reference was provided.");
  }

  assertMediaRefInConversation(ref, conversationId);

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
 * metadata. The `conversationId` (from the tool's `ToolContext`) scopes the
 * lookup: an id not linked to the current conversation is rejected before any
 * bytes are read or frames are sampled. Delegates frame extraction to
 * `video-frames.ts`, which relies on ffmpeg/ffprobe and fails gracefully when
 * those are unavailable. Throws {@link VisionMediaError} on a missing /
 * non-video / out-of-conversation reference, and re-raises a
 * {@link VideoFramesError} as a {@link VisionMediaError} so callers convert
 * either into a single `{ isError: true }` result.
 */
export async function resolveVisionVideo(
  mediaRef: string,
  conversationId: string,
  options?: SampleVideoOptions,
): Promise<{ video: SampledVideo; filename: string }> {
  const ref = mediaRef?.trim();
  if (!ref) {
    throw new VisionMediaError("No media reference was provided.");
  }

  assertMediaRefInConversation(ref, conversationId);

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
