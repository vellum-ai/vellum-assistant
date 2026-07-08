/**
 * Resolve persisted media references into inline base64 at the provider send
 * boundary.
 *
 * Image/file blocks are PERSISTED into `messages.content` as
 * {@link AttachmentRefMediaSource} references (attachment id + size/dimension
 * hints) rather than inline base64, keeping large blobs out of the DB row and
 * the lexical index. The reference bytes live in the workspace attachment
 * store. Just before a provider serializes a turn, {@link resolveMediaReferences}
 * walks the message content and swaps every reference source for a
 * {@link Base64MediaSource} loaded from disk, so each provider transform can
 * keep reading `block.source.data` exactly as before.
 *
 * Blocks that already carry base64 (a live, in-flight turn) pass through
 * untouched — no disk read — so only reloaded history pays the resolution cost,
 * and only on its first send after reload. The walk is pure: it returns fresh
 * block/message objects and never mutates the caller's in-memory history.
 */

import { optimizeImageForTransport } from "../agent/image-optimize.js";
import { getAttachmentContent } from "../persistence/attachments-store.js";
import { getLogger } from "../util/logger.js";
import type {
  Base64MediaSource,
  ContentBlock,
  FileContent,
  ImageContent,
  MediaSource,
  Message,
} from "./types.js";

const log = getLogger("media-resolve");

/**
 * Narrow a media source to its base64 arm. After {@link resolveMediaReferences}
 * runs, provider transforms only ever see base64 sources; this asserts that
 * invariant and gives call sites the concrete `data`/`media_type` fields
 * without an inline guard. Throwing (rather than emitting an empty payload)
 * surfaces a missed resolution as a loud failure.
 */
export function base64Source<T extends MediaSource>(
  source: T,
): Extract<T, { type: "base64" }> {
  if (source.type !== "base64") {
    throw new Error(
      `Unresolved attachment_ref media source reached the provider transform (attachmentId=${source.attachmentId}). ` +
        `resolveMediaReferences must run before serializing messages.`,
    );
  }
  return source as Extract<T, { type: "base64" }>;
}

/**
 * Raw byte length of a media source's payload, without reading the file back.
 * For a base64 source it is derived from the string length (4 chars → 3 bytes);
 * for a reference it is the `sizeBytes` hint captured at persist time. Lets
 * size-only consumers (the per-turn token estimator especially) cost a block
 * without decoding or a disk read.
 */
export function mediaSourceByteLength(source: MediaSource): number {
  if (source.type === "attachment_ref") return source.sizeBytes;
  return Math.floor((source.data.length * 3) / 4);
}

/**
 * Resolve a media source to inline base64, loading a reference source from the
 * attachment store. Returns `null` when a referenced attachment can no longer
 * be read. For consumers that hold an individual in-memory block (image
 * captioning, media retry) and need its bytes outside the provider transform.
 */
export function resolveMediaSourceData(
  source: MediaSource,
): { data: string; media_type: string } | null {
  if (source.type === "base64") {
    return { data: source.data, media_type: source.media_type };
  }
  const bytes = getAttachmentContent(source);
  if (!bytes) return null;
  return { data: bytes.toString("base64"), media_type: source.media_type };
}

function resolveImageBlock(block: ImageContent): ContentBlock {
  if (block.source.type === "base64") return block;
  const bytes = getAttachmentContent(block.source);
  if (!bytes) {
    log.warn(
      { attachmentId: block.source.attachmentId },
      "Image attachment reference could not be resolved; substituting a text note",
    );
    return {
      type: "text",
      text: "[Attachment unavailable: image could not be loaded]",
    };
  }
  // Apply the same transport optimization the inline-base64 path used, so a
  // reloaded (reference) turn sends the model the same bytes a live turn would.
  const { data, mediaType } = optimizeImageForTransport(
    bytes.toString("base64"),
    block.source.media_type,
  );
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data },
  };
}

function resolveFileBlock(block: FileContent): ContentBlock {
  if (block.source.type === "base64") return block;
  const { attachmentId, media_type, filename } = block.source;
  const bytes = getAttachmentContent(block.source);
  if (!bytes) {
    log.warn(
      { attachmentId, filename },
      "File attachment reference could not be resolved; falling back to extracted text",
    );
    // Providers render non-inline files as their extracted text anyway; when the
    // bytes are gone that text is the best remaining representation.
    return {
      type: "text",
      text:
        block.extracted_text ??
        `[Attachment unavailable: ${filename ?? attachmentId}]`,
    };
  }
  const source: Base64MediaSource = {
    type: "base64",
    media_type,
    data: bytes.toString("base64"),
    ...(filename !== undefined ? { filename } : {}),
  };
  return {
    type: "file",
    source,
    ...(block.extracted_text !== undefined
      ? { extracted_text: block.extracted_text }
      : {}),
    ...(block._attachmentId !== undefined
      ? { _attachmentId: block._attachmentId }
      : {}),
  };
}

function resolveBlock(block: ContentBlock): ContentBlock {
  switch (block.type) {
    case "image":
      return resolveImageBlock(block);
    case "file":
      return resolveFileBlock(block);
    case "tool_result": {
      // Nested media (e.g. a browser screenshot) may also carry references.
      if (!block.contentBlocks?.length) return block;
      return { ...block, contentBlocks: block.contentBlocks.map(resolveBlock) };
    }
    default:
      return block;
  }
}

function contentHasReference(content: ContentBlock[]): boolean {
  return content.some((block) => {
    if (block.type === "image" || block.type === "file") {
      return block.source.type === "attachment_ref";
    }
    if (block.type === "tool_result" && block.contentBlocks?.length) {
      return contentHasReference(block.contentBlocks);
    }
    return false;
  });
}

/**
 * Return a copy of `messages` with every {@link AttachmentRefMediaSource}
 * resolved to inline base64. Messages with no references are returned unchanged
 * (same object reference) so the common all-base64 live turn does no allocation
 * or disk I/O.
 */
export function resolveMediaReferences(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (!contentHasReference(message.content)) return message;
    return { ...message, content: message.content.map(resolveBlock) };
  });
}
