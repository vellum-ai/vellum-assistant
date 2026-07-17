/**
 * Convert inline base64 media blocks to workspace references at persist time —
 * the inverse of `providers/media-resolve.ts` (`resolveMediaReferences`, which
 * re-inflates references to base64 at the provider send boundary).
 *
 * Tool results carry generated media (browser screenshots, image generation)
 * as base64 `image`/`file` blocks nested in a `tool_result`'s `contentBlocks`.
 * Persisting that base64 into `messages.content` bloats the row and the lexical
 * index. Just before the finalized tool-result row is written,
 * {@link referenceMediaBlocksForPersist} materializes each base64 media block
 * into an attachment-store row and swaps its `source` for a
 * {@link WorkspaceRefMediaSource}, keeping the blob in the attachment store.
 *
 * A block whose materialization fails is left as inline base64 so media is
 * never lost. The walk descends into `tool_result.contentBlocks`; every other
 * block passes through untouched.
 */

import { optimizeImageForTransport } from "../agent/image-optimize.js";
import { parseImageDimensions } from "../context/image-dimensions.js";
import {
  createInlineAttachment,
  linkAttachmentToMessage,
} from "../persistence/attachments-store.js";
import type {
  ContentBlock,
  FileContent,
  ImageContent,
  WorkspaceRefMediaSource,
} from "../providers/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("persist-media-references");

/** A filename for an unnamed image block, derived from its MIME subtype. */
function imageFilename(mediaType: string): string {
  const subtype = mediaType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
  return `image.${subtype}`;
}

/**
 * Dimensions to hint on an image reference. The model receives the
 * transport-optimized image (`resolveMediaReferences` applies the same
 * optimization at send time), so hint the optimized dimensions.
 */
function optimizedImageDimensions(
  dataBase64: string,
  mediaType: string,
): { width: number; height: number } | null {
  const optimized = optimizeImageForTransport(dataBase64, mediaType);
  return parseImageDimensions(optimized.data, optimized.mediaType);
}

/**
 * Materialize one base64 media block into an attachment row linked to
 * `messageId`, returning the block with a `workspace_ref` source — or null when
 * the store write fails (caller keeps the inline base64 block).
 */
function referenceMediaBlock(
  conversationId: string,
  conversationCreatedAt: number,
  messageId: string,
  block: ImageContent | FileContent,
  position: number,
): ContentBlock | null {
  if (block.source.type !== "base64") return block;
  const { data, media_type } = block.source;
  const filename =
    block.source.filename ??
    (block.type === "image" ? imageFilename(media_type) : "attachment");

  let stored: { id: string; sizeBytes: number };
  try {
    stored = createInlineAttachment(
      conversationId,
      conversationCreatedAt,
      filename,
      media_type,
      data,
    );
    linkAttachmentToMessage(messageId, stored.id, position);
  } catch (err) {
    log.warn(
      { err, mediaType: media_type, messageId },
      "Failed to store tool-result media; persisting inline",
    );
    return null;
  }

  const source: WorkspaceRefMediaSource = {
    type: "workspace_ref",
    media_type,
    attachmentId: stored.id,
    sizeBytes: stored.sizeBytes,
    ...(block.source.filename !== undefined
      ? { filename: block.source.filename }
      : {}),
  };
  if (block.type === "image") {
    const dims = optimizedImageDimensions(data, media_type);
    if (dims) {
      source.width = dims.width;
      source.height = dims.height;
    }
    return { type: "image", source };
  }
  return {
    type: "file",
    source,
    ...(block.extracted_text !== undefined
      ? { extracted_text: block.extracted_text }
      : {}),
  };
}

/**
 * Return a copy of `blocks` with every inline base64 `image`/`file` media block
 * (including those nested in a `tool_result`'s `contentBlocks`) materialized
 * into an attachment row linked to `messageId` and swapped for a
 * `workspace_ref`. Blocks that are already references, carry no media, or fail
 * to store are returned unchanged.
 */
export function referenceMediaBlocksForPersist(
  conversationId: string,
  conversationCreatedAt: number,
  messageId: string,
  blocks: ContentBlock[],
): ContentBlock[] {
  // A single link position counter across all attachments in the message so
  // their `message_attachments` rows keep content order.
  let position = 0;
  const convert = (block: ContentBlock): ContentBlock => {
    if (block.type === "image" || block.type === "file") {
      if (block.source.type !== "base64") return block;
      return (
        referenceMediaBlock(
          conversationId,
          conversationCreatedAt,
          messageId,
          block,
          position++,
        ) ?? block
      );
    }
    if (block.type === "tool_result" && block.contentBlocks?.length) {
      return { ...block, contentBlocks: block.contentBlocks.map(convert) };
    }
    return block;
  };
  return blocks.map(convert);
}
