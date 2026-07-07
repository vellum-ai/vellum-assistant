/**
 * Persist-time conversion of assistant/tool-generated media into workspace
 * references.
 *
 * Tool results (browser/computer-use screenshots, `image_read`, generated
 * images) and the occasional model-emitted top-level image arrive as inline
 * base64 `ContentBlock`s. Writing them verbatim into `messages.content` bloats
 * the row and the lexical index with bytes that belong on disk — the same
 * problem solved for user uploads (ATL-991).
 *
 * {@link referenceMediaBlocksForPersist} runs just before a tool-result or
 * assistant row is finalized: it materializes each base64 image/file into the
 * conversation's attachment store (linked to that row) and swaps the block's
 * `source` for an `attachment_ref`. The bytes are resolved back at the provider
 * send boundary (`resolveMediaReferences`) and by any stored-content reader
 * (`extractMediaBlocks`), both of which already understand references.
 *
 * On failure to materialize a block (e.g. invalid base64) the original inline
 * block is kept, so media is never silently dropped.
 */

import { parseImageDimensions } from "../context/image-dimensions.js";
import { attachInlineAttachmentToMessage } from "../persistence/attachments-store.js";
import type { ContentBlock } from "../providers/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("persist-media-references");

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

function extensionFor(mediaType: string): string {
  return IMAGE_EXTENSIONS[mediaType] ?? mediaType.split("/")[1] ?? "bin";
}

/** Materialize a base64 image block into an attachment and return a reference block. */
function referenceImageBlock(
  messageId: string,
  position: number,
  source: { media_type: string; data: string },
): ContentBlock | null {
  try {
    const filename = `image-${position}.${extensionFor(source.media_type)}`;
    const stored = attachInlineAttachmentToMessage(
      messageId,
      position,
      filename,
      source.media_type,
      source.data,
      { skipSizeLimit: true },
    );
    const dims = parseImageDimensions(source.data, source.media_type);
    return {
      type: "image",
      source: {
        type: "attachment_ref",
        media_type: source.media_type,
        attachmentId: stored.id,
        sizeBytes: stored.sizeBytes,
        ...(dims ? { width: dims.width, height: dims.height } : {}),
      },
    };
  } catch (err) {
    log.warn(
      { err, messageId, mediaType: source.media_type },
      "Failed to reference generated image; keeping inline base64",
    );
    return null;
  }
}

/** Materialize a base64 file block into an attachment and return a reference block. */
function referenceFileBlock(
  messageId: string,
  position: number,
  block: Extract<ContentBlock, { type: "file" }>,
): ContentBlock | null {
  if (block.source.type !== "base64") return null;
  const { media_type, data, filename } = block.source;
  try {
    const stored = attachInlineAttachmentToMessage(
      messageId,
      position,
      filename,
      media_type,
      data,
      { skipSizeLimit: true },
    );
    return {
      type: "file",
      source: {
        type: "attachment_ref",
        media_type,
        attachmentId: stored.id,
        filename,
        sizeBytes: stored.sizeBytes,
      },
      ...(block.extracted_text !== undefined
        ? { extracted_text: block.extracted_text }
        : {}),
      ...(block._attachmentId !== undefined
        ? { _attachmentId: block._attachmentId }
        : {}),
    };
  } catch (err) {
    log.warn(
      { err, messageId, filename },
      "Failed to reference generated file; keeping inline base64",
    );
    return null;
  }
}

/**
 * Return a copy of `blocks` with every inline base64 image/file (top-level or
 * nested in a `tool_result`) materialized into the attachment store — linked to
 * `messageId` — and replaced by an `attachment_ref` source. Blocks that already
 * carry references, or that fail to materialize, are left untouched.
 *
 * Must run at a single-writer persist point (a tool-result/assistant row
 * finalize) so attachment rows are not created twice for the same media.
 */
export function referenceMediaBlocksForPersist(
  messageId: string,
  blocks: ContentBlock[],
): ContentBlock[] {
  let position = 0;
  const convert = (input: ContentBlock[]): ContentBlock[] =>
    input.map((block) => {
      if (block.type === "image" && block.source.type === "base64") {
        const ref = referenceImageBlock(messageId, position, block.source);
        if (ref) {
          position++;
          return ref;
        }
        return block;
      }
      if (block.type === "file" && block.source.type === "base64") {
        const ref = referenceFileBlock(messageId, position, block);
        if (ref) {
          position++;
          return ref;
        }
        return block;
      }
      if (block.type === "tool_result" && block.contentBlocks?.length) {
        return { ...block, contentBlocks: convert(block.contentBlocks) };
      }
      return block;
    });
  return convert(blocks);
}
