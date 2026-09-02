/**
 * Resolve persisted media references into inline base64 at the provider send
 * boundary.
 *
 * Image/file blocks are PERSISTED into `messages.content` as
 * {@link WorkspaceRefMediaSource} references (an attachment id + size/dimension
 * hints) rather than inline base64, keeping large blobs out of the DB row and
 * the lexical index. The reference bytes live in the workspace attachment
 * store. Just before a provider serializes a turn, {@link resolveMediaReferences}
 * walks the message content and swaps every reference source for a
 * {@link Base64MediaSource} loaded from the store, so each provider transform
 * can keep reading `block.source.data` exactly as before.
 *
 * Blocks that already carry base64 (a live, in-flight turn) pass through
 * untouched (no disk read) so only reloaded history pays the resolution cost,
 * and only on its first send after reload. The walk is pure: it returns fresh
 * block/message objects and never mutates the caller's in-memory history.
 *
 * The walk is also the last place an image block can be checked before a
 * provider serializes it, so it is where an image the provider cannot decode
 * is replaced by a text note: see {@link UNSENDABLE_IMAGE_FORMAT_NOTE}.
 */

import { optimizeImageForTransport } from "../agent/image-optimize.js";
import { getAttachmentContent } from "../persistence/attachments-store.js";
import {
  heifImageMimeType,
  sniffImageMimeType,
} from "../util/image-conversion.js";
import { getLogger } from "../util/logger.js";
import {
  attachmentIdFragment,
  type Base64MediaSource,
  type ContentBlock,
  type FileContent,
  type ImageContent,
  type MediaSource,
  type Message,
} from "./types.js";

const log = getLogger("media-resolve");

/**
 * Raw bytes for any media source: an inline base64 payload decoded in place, or
 * a workspace reference read back from the attachment store. Returns `null`
 * when a reference can no longer be resolved.
 */
export function mediaSourceBytes(source: MediaSource): Buffer | null {
  if (source.type === "base64") {
    return Buffer.from(source.data, "base64");
  }
  return getAttachmentContent(source.attachmentId);
}

/**
 * Whether an image source's bytes are not one of the formats providers accept,
 * so {@link resolveMediaReferences} replaces the block with
 * {@link UNSENDABLE_IMAGE_FORMAT_NOTE} instead of sending it. Applies the same
 * rule as {@link resolveImageBlock}, including its treatment of a reference
 * whose payload is gone: that is an unavailable attachment, not an unreadable
 * format. Lets a caller holding a persisted block ask whether the model will
 * see the image.
 *
 * Answers for the formats every provider reads, so HEIF counts as unsendable
 * even though a Gemini turn ({@link MediaResolveOptions}) would carry it.
 */
export function isUnsendableImageSource(source: MediaSource): boolean {
  const bytes =
    source.type === "base64"
      ? imageHeadBytes(source.data)
      : getAttachmentContent(source.attachmentId);
  return bytes != null && sendableImageMimeType(bytes, {}) === null;
}

/**
 * Media types a provider accepts for an image block beyond the four every
 * provider reads (PNG, JPEG, GIF, WebP).
 *
 * HEIF is the one format where providers genuinely disagree: Gemini decodes
 * `image/heic` and `image/heif` directly
 * (https://ai.google.dev/gemini-api/docs/image-understanding), while
 * OpenAI-compatible and Anthropic endpoints answer HTTP 400 for the whole
 * request. HEIF bytes reach a provider whenever transcoding cannot decode the
 * input, so Gemini depends on them passing through.
 */
export interface MediaResolveOptions {
  acceptsHeif?: boolean;
}

// 16 base64 chars decode to the 12 bytes the longest signature needs.
function imageHeadBytes(dataBase64: string): Buffer {
  return Buffer.from(dataBase64.slice(0, 16), "base64");
}

/**
 * Media type the provider should be told an image is, or null when it cannot
 * read the bytes at all.
 */
function sendableImageMimeType(
  bytes: Uint8Array,
  options: MediaResolveOptions,
): string | null {
  const sniffed = sniffImageMimeType(bytes);
  if (sniffed) {
    return sniffed;
  }
  if (options.acceptsHeif) {
    return heifImageMimeType(bytes);
  }
  return null;
}

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
      `Unresolved workspace_ref media source reached the provider transform ` +
        `(attachmentId=${source.attachmentId}). ` +
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
  if (source.type === "workspace_ref") {
    return source.sizeBytes;
  }
  return Math.floor((source.data.length * 3) / 4);
}

/**
 * What a media source was, as the text that stands in for it once the bytes are
 * gone: its media type and payload size.
 *
 * Every path that replaces a media block with a text stub naming what it
 * dropped reports these same two facts, so they are derived once here. Each
 * stub keeps its own surrounding sentence (which path dropped it, and why) and
 * embeds this for the what. Reads the size through
 * {@link mediaSourceByteLength}, so a reference and an inline block describe
 * themselves the same way.
 */
export function mediaSourceDescriptor(source: MediaSource): string {
  return `${source.media_type}, ${mediaSourceByteLength(source)} bytes`;
}

/**
 * Resolve a media source to inline base64, reading a reference source back from
 * its workspace location. Returns `null` when a reference can no longer be
 * read. For consumers that hold an individual in-memory block (image
 * captioning, media retry) and need its bytes outside the provider transform.
 */
export function resolveMediaSourceData(
  source: MediaSource,
): { data: string; media_type: string } | null {
  if (source.type === "base64") {
    return { data: source.data, media_type: source.media_type };
  }
  const bytes = getAttachmentContent(source.attachmentId);
  if (!bytes) {
    return null;
  }
  return { data: bytes.toString("base64"), media_type: source.media_type };
}

/**
 * Note that replaces an image block whose bytes are not one of the formats
 * providers accept (PNG, JPEG, GIF, WebP). Sending the block instead costs the
 * user the whole turn: an OpenAI-compatible endpoint answers HTTP 400 ("The
 * image data you provided does not represent a valid image") for the entire
 * request, so one unreadable image in a batch of eight blocks the reply to all
 * of them. The note keeps the turn alive and tells the model what it is
 * missing, and the daemon posts a system card naming the file so the user
 * knows too.
 */
export const UNSENDABLE_IMAGE_FORMAT_NOTE =
  "[Image omitted: its format is not one the model can read (PNG, JPEG, GIF, and WebP are)]";

/**
 * Resolve an image block into one the provider can accept, keyed on the bytes
 * rather than on the declared media type.
 *
 * The declaration is only a claim: web clients derive it from the filename
 * extension, so a HEIC photo saved as `.png` arrives declared `image/png`. One
 * sniff covers both failure modes that claim produces. Bytes that sniff as
 * nothing the target provider reads are unsendable (a corrupt head, or a format
 * outside both the universal four and the provider's own extras: AVIF, BMP,
 * TIFF, SVG) and become {@link UNSENDABLE_IMAGE_FORMAT_NOTE}. Bytes that sniff
 * as something other than the declaration are relabeled, since a mismatch is
 * fatal on its own (Anthropic answers "image does not match the provided media
 * type").
 *
 * The sniff runs ahead of the transport optimization so sendability cannot
 * depend on an unrelated size threshold: optimization rewrites only the images
 * it decides to rescale.
 */
async function resolveImageBlock(
  block: ImageContent,
  options: MediaResolveOptions,
): Promise<ContentBlock> {
  if (block.source.type === "base64") {
    const sniffed = sendableImageMimeType(
      imageHeadBytes(block.source.data),
      options,
    );
    if (!sniffed) {
      log.warn(
        { declaredMediaType: block.source.media_type },
        "Inline image is not in a provider-readable format; substituting a text note",
      );
      return { type: "text", text: UNSENDABLE_IMAGE_FORMAT_NOTE };
    }
    return {
      type: "image",
      source: { type: "base64", media_type: sniffed, data: block.source.data },
    };
  }
  const bytes = getAttachmentContent(block.source.attachmentId);
  if (!bytes) {
    log.warn(
      { attachmentId: block.source.attachmentId },
      "Image workspace reference could not be resolved; substituting a text note",
    );
    return {
      type: "text",
      text: "[Attachment unavailable: image could not be loaded]",
    };
  }
  const sniffed = sendableImageMimeType(bytes, options);
  if (!sniffed) {
    log.warn(
      {
        attachmentId: block.source.attachmentId,
        declaredMediaType: block.source.media_type,
      },
      "Referenced image is not in a provider-readable format; substituting a text note",
    );
    return { type: "text", text: UNSENDABLE_IMAGE_FORMAT_NOTE };
  }
  // Apply the same transport optimization the inline-base64 path used, so a
  // reloaded (reference) turn sends the model the same bytes a live turn would.
  const { data, mediaType } = await optimizeImageForTransport(
    bytes.toString("base64"),
    sniffed,
  );
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data },
  };
}

function resolveFileBlock(block: FileContent): ContentBlock {
  if (block.source.type === "base64") {
    return block;
  }
  const { attachmentId, media_type, filename } = block.source;
  const bytes = getAttachmentContent(attachmentId);
  if (!bytes) {
    log.warn(
      { attachmentId, filename },
      "File workspace reference could not be resolved; falling back to extracted text",
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
    ...attachmentIdFragment(block._attachmentId),
  };
}

async function resolveBlock(
  block: ContentBlock,
  options: MediaResolveOptions,
): Promise<ContentBlock> {
  switch (block.type) {
    case "image":
      return resolveImageBlock(block, options);
    case "file":
      return resolveFileBlock(block);
    case "tool_result": {
      // Nested media (e.g. a browser screenshot) may also carry references.
      if (!block.contentBlocks?.length) {
        return block;
      }
      return {
        ...block,
        contentBlocks: await Promise.all(
          block.contentBlocks.map((nested) => resolveBlock(nested, options)),
        ),
      };
    }
    default:
      return block;
  }
}

/**
 * Whether an inline image needs rebuilding before it can be sent: its payload
 * is unreadable, or its declared media type is not exactly what the bytes are.
 * The comparison is exact so a non-canonical spelling of a real format is
 * rewritten too (`image/jpg` is not in any provider's accepted set, and clients
 * derive it from a `.jpg` extension). Sniffing here, rather than rebuilding
 * every inline block unconditionally, keeps the clean live turn on the identity
 * fast path below at the cost of decoding a 12-byte head per image.
 */
function base64ImageNeedsRewrite(
  source: Base64MediaSource,
  options: MediaResolveOptions,
): boolean {
  return (
    sendableImageMimeType(imageHeadBytes(source.data), options) !==
    source.media_type
  );
}

function contentNeedsResolution(
  content: ContentBlock[],
  options: MediaResolveOptions,
): boolean {
  return content.some((block) => {
    if (block.type === "image") {
      return block.source.type === "workspace_ref"
        ? true
        : base64ImageNeedsRewrite(block.source, options);
    }
    if (block.type === "file") {
      return block.source.type === "workspace_ref";
    }
    if (block.type === "tool_result" && block.contentBlocks?.length) {
      return contentNeedsResolution(block.contentBlocks, options);
    }
    return false;
  });
}

/**
 * Return a copy of `messages` with every {@link WorkspaceRefMediaSource}
 * resolved to inline base64 and every image block reconciled with its own
 * bytes. Messages that need neither are returned unchanged (same object
 * reference) so the common live turn does no allocation or disk I/O.
 */
export function resolveMediaReferences(
  messages: Message[],
  options: MediaResolveOptions = {},
): Promise<Message[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (!contentNeedsResolution(message.content, options)) {
        return message;
      }
      return {
        ...message,
        content: await Promise.all(
          message.content.map((block) => resolveBlock(block, options)),
        ),
      };
    }),
  );
}
