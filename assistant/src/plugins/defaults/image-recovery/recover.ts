/**
 * Image-rejection recovery transforms for the image-recovery plugin.
 *
 * When the provider rejects a turn because an attached image violates its
 * limits, the `post-model-call` hook rewrites the offending image blocks in the
 * working history and asks the loop to retry. Two rejection classes each have
 * their own replacement rule:
 *
 * - Size rejections ({@link unsendableImageReplacement}) — too large on a side,
 *   over the payload cap, or below the minimum-size floor — are resized, or
 *   noted when this host cannot resize.
 * - Unprocessable rejections ({@link unprocessableImageReplacement}) — bytes
 *   the provider cannot decode or whose format disagrees with the declared
 *   media type — have their media type corrected when the bytes are a real
 *   image, are noted when the bytes are not an image at all (e.g. an HTML page
 *   stored as image/png), and otherwise fall through to the size rule.
 *
 * {@link recoverImages} applies a rule in-memory for the immediate retry;
 * {@link persistImageDowngrades} applies the same rule durably, because the
 * stored message row otherwise keeps the rejected image block and it rehydrates
 * on every later turn and keeps re-rejecting. The durable rewrite is what heals
 * an already-poisoned conversation — a rejected image cannot resurface and
 * re-reject once its stored row is downgraded.
 */

import {
  type ContentBlock,
  type Message,
  resolveMediaSourceData,
} from "@vellumai/plugin-api";

import {
  isBelowMinDimension,
  optimizeImageForTransport,
  upscaleImageToMinimum,
} from "../../../agent/image-optimize.js";
import { parseImageDimensions } from "../../../context/image-dimensions.js";
import {
  getMessages,
  updateMessageContent,
} from "../../../persistence/conversation-crud.js";
import { getLogger } from "../../../util/logger.js";

const log = getLogger("image-recovery");

// Anthropic rejects any image whose longest side exceeds this many pixels,
// regardless of payload size. Mirrors the user-facing message surfaced by
// `classifyConversationError` for the IMAGE_TOO_LARGE code.
// https://docs.anthropic.com/en/docs/build-with-claude/vision#image-size
const PROVIDER_MAX_IMAGE_DIMENSION = 8000;

// Anthropic rejects any single image whose base64 payload exceeds 5 MB.
// https://docs.anthropic.com/en/docs/build-with-claude/vision#image-size
const PROVIDER_MAX_IMAGE_PAYLOAD_BYTES = 5 * 1024 * 1024;

/** An inline or referenced image content block. */
type ImageBlock = Extract<ContentBlock, { type: "image" }>;

/**
 * A per-image replacement rule: given a rejected image block, return the block
 * to substitute (a rewritten image or a text note) or `null` to leave it
 * untouched. Shared by the in-memory recovery transform and the durable persist
 * pass so both apply an identical rewrite.
 */
export type ImageReplacementRule = (block: ImageBlock) => ContentBlock | null;

/**
 * Note left in place of an image that cannot be sent to the provider because it
 * exceeds the provider's size limits and this host cannot resize it. Shared
 * with the in-memory recovery path so the persisted history matches what the
 * model saw on the turn the image was rejected.
 */
export const UNSENDABLE_IMAGE_NOTE =
  "(An image was attached but could not be sent — it does not meet the provider's image size limits and automatic resizing was not available. Please resize the image and try again.)";

/**
 * Note left in place of an attachment whose bytes are not a valid image (e.g.
 * an HTML page stored under an image media type), so it cannot rehydrate and
 * re-reject on later turns.
 */
export const INVALID_IMAGE_NOTE =
  "(An image was attached but its data was not a valid image and could not be sent — it may have been corrupted when it was received. Please re-send the image.)";

/**
 * Detect the true image format of a base64 payload from its magic bytes, or
 * `null` when it matches none of the formats the provider accepts. Only the
 * first ~24 base64 chars (18 bytes) are decoded — enough for every signature,
 * including WebP's `RIFF....WEBP` at offset 8 — so a large payload is never
 * fully decoded just to sniff its head.
 */
function sniffImageMediaType(base64Data: string): string | null {
  const head = Buffer.from(base64Data.slice(0, 24), "base64");
  if (
    head.length >= 4 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    head.length >= 3 &&
    head[0] === 0xff &&
    head[1] === 0xd8 &&
    head[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    head.length >= 4 &&
    head[0] === 0x47 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    head.length >= 12 &&
    head.toString("ascii", 0, 4) === "RIFF" &&
    head.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Replacement for an image the provider rejected as unprocessable. Sniffs the
 * decoded bytes for a real image format:
 *
 * - Bytes match no known image format (e.g. an HTML interstitial saved as
 *   image/png): replaced with {@link INVALID_IMAGE_NOTE} — no relabeling can
 *   make non-image bytes decode.
 * - Bytes match a format that disagrees with the declared `media_type` (e.g.
 *   JPEG bytes labeled image/png): the same image with its `media_type`
 *   corrected to the detected type.
 * - Bytes match and the declared type already agrees: `null` (untouched) so the
 *   caller can fall through to the size rule.
 *
 * Returns `null` when the source cannot be resolved, leaving the block
 * untouched.
 */
export function invalidImageReplacement(
  block: ImageBlock,
): ContentBlock | null {
  const resolved = resolveMediaSourceData(block.source);
  if (!resolved) {
    return null;
  }
  const detected = sniffImageMediaType(resolved.data);
  if (!detected) {
    return { type: "text", text: INVALID_IMAGE_NOTE };
  }
  if (detected === resolved.media_type) {
    return null;
  }
  return {
    type: "image",
    source: { type: "base64", media_type: detected, data: resolved.data },
  };
}

/**
 * Replacement for an image that violates a provider hard limit (per-side pixel
 * cap, payload size, or the minimum-size floor), or null when the image is
 * within limits and should be left untouched. Gating on the provider hard caps
 * is what keeps still-sendable images intact: a normally sized image is left
 * alone rather than being noted or needlessly rewritten.
 *
 * An unsendable image that can be resized is rewritten to its resized form
 * (downscaled when oversized, upscaled to the minimum floor when undersized);
 * one that cannot be resized on this host (resize is a no-op, e.g. `sips` is
 * absent off macOS or the format is unsupported) is replaced with a text note.
 *
 * Persisting the resized form is what lets a poisoned conversation durably
 * self-heal — the latest tool-result media is kept in context, so without it the
 * original rejected block rehydrates and re-rejects on every later turn.
 */
export function unsendableImageReplacement(
  block: ImageBlock,
): ContentBlock | null {
  // Resolve reference sources to their bytes so a reloaded (referenced) image
  // is gated on the same payload/dimension caps as an inline one. When the
  // attachment can no longer be read, leave the block untouched.
  const resolved = resolveMediaSourceData(block.source);
  if (!resolved) {
    return null;
  }
  const payloadBytes = resolved.data.length;
  const dims = parseImageDimensions(block.source);
  const exceedsDimensionCap =
    dims != null &&
    (dims.width > PROVIDER_MAX_IMAGE_DIMENSION ||
      dims.height > PROVIDER_MAX_IMAGE_DIMENSION);
  const exceedsPayloadCap = payloadBytes > PROVIDER_MAX_IMAGE_PAYLOAD_BYTES;
  const belowMinDimension = isBelowMinDimension(dims);
  if (!exceedsDimensionCap && !exceedsPayloadCap && !belowMinDimension) {
    return null;
  }

  // The floor is undocumented, so undersized images are never touched
  // pre-send — the upscale runs only here, in response to an actual
  // provider rejection. Oversized images reuse the transport downscale.
  const optimized = belowMinDimension
    ? upscaleImageToMinimum(resolved.data, resolved.media_type)
    : optimizeImageForTransport(resolved.data, resolved.media_type);
  if (optimized && optimized.data !== resolved.data) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: optimized.mediaType,
        data: optimized.data,
      },
    };
  }
  return { type: "text", text: UNSENDABLE_IMAGE_NOTE };
}

/**
 * Replacement rule for the "unprocessable image" rejection class. Sniffs the
 * bytes first ({@link invalidImageReplacement}) so corrupt/non-image data
 * becomes a note and a mislabeled media type is corrected; when the bytes are a
 * valid image whose media type already agrees, falls back to the size rule
 * ({@link unsendableImageReplacement}) so an image below the provider's
 * minimum-size floor is still upscaled.
 */
export const unprocessableImageReplacement: ImageReplacementRule = (block) =>
  invalidImageReplacement(block) ?? unsendableImageReplacement(block);

/**
 * True when a message's content holds an image the provider may have rejected
 * — either a top-level image block (user upload) or one nested inside a
 * tool_result's contentBlocks (e.g. a browser screenshot).
 */
function messageHasImageBlock(content: ReadonlyArray<ContentBlock>): boolean {
  return content.some(
    (b) =>
      b.type === "image" ||
      (b.type === "tool_result" &&
        (b.contentBlocks?.some((cb) => cb.type === "image") ?? false)),
  );
}

/**
 * Apply an {@link ImageReplacementRule} to a single content block, recovering
 * both a top-level image block and images nested inside a tool_result's
 * contentBlocks in place — the latter so the tool_use/tool_result pairing stays
 * intact rather than dropping the whole tool_result. Returns the (possibly
 * rewritten) block and whether it changed.
 */
function applyRuleToBlock(
  block: ContentBlock,
  rule: ImageReplacementRule,
): { block: ContentBlock; changed: boolean } {
  if (block.type === "image") {
    const replacement = rule(block);
    if (!replacement) {
      return { block, changed: false };
    }
    return { block: replacement, changed: true };
  }
  if (block.type === "tool_result" && block.contentBlocks?.length) {
    let nestedChanged = false;
    const contentBlocks = block.contentBlocks.map((cb): ContentBlock => {
      if (cb.type !== "image") {
        return cb;
      }
      const replacement = rule(cb);
      if (!replacement) {
        return cb;
      }
      nestedChanged = true;
      return replacement;
    });
    if (!nestedChanged) {
      return { block, changed: false };
    }
    return { block: { ...block, contentBlocks }, changed: true };
  }
  return { block, changed: false };
}

/**
 * Apply `rule` to every image in the working history for an immediate retry,
 * leaving blocks the rule declines (returns null for) untouched.
 */
export function recoverImages(
  messages: ReadonlyArray<Message>,
  rule: ImageReplacementRule,
): Message[] {
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) {
      return msg;
    }
    if (!messageHasImageBlock(msg.content)) {
      return msg;
    }
    return {
      ...msg,
      content: msg.content.map((b) => applyRuleToBlock(b, rule).block),
    };
  });
}

/**
 * Apply `rule` durably to every stored message in a conversation that holds a
 * rejected image — whether a top-level block or one nested in a tool_result's
 * contentBlocks — so the rejected block cannot rehydrate from the DB row and
 * re-reject on a later turn. Reads stored content directly (not the in-memory,
 * injection-enriched copy) so injected prefixes and hydrated source paths are
 * never written back.
 *
 * Idempotent: a rewritten image no longer trips the rule and a note is no
 * longer an image, so neither matches on a second run. Returns the number of
 * rewritten messages.
 */
export function persistImageDowngrades(
  conversationId: string,
  rule: ImageReplacementRule,
): number {
  let rewritten = 0;
  for (const row of getMessages(conversationId)) {
    if (!messageHasImageBlock(row.content)) {
      continue;
    }

    let changed = false;
    const next = (row.content as ContentBlock[]).map((block): ContentBlock => {
      const result = applyRuleToBlock(block, rule);
      if (result.changed) {
        changed = true;
      }
      return result.block;
    });
    if (!changed) {
      continue;
    }

    updateMessageContent(row.id, JSON.stringify(next));
    rewritten++;
    log.info(
      { conversationId, messageId: row.id },
      "Persisted image-rejection downgrade so it cannot resurface on later turns",
    );
  }
  return rewritten;
}
