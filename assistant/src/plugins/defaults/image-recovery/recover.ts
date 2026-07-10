/**
 * Image-rejection recovery transforms for the image-recovery plugin.
 *
 * When the provider rejects a turn because an attached image violates its
 * limits — too large on a side, over the payload cap, or below the minimum
 * size floor — the `post-model-call` hook rewrites the offending image blocks
 * in the working history and asks the loop to retry. {@link
 * recoverUnsendableImages} performs that in-memory transform for the immediate
 * retry; {@link persistUnsendableImageDowngrades} makes the same rewrite
 * durable, because the stored message row otherwise keeps the rejected image
 * block and it rehydrates on every later turn and keeps re-entering the
 * model's context. The durable rewrite replaces the unsendable block with its
 * resized form, or with a text note when it cannot be resized on this host,
 * so a rejected image cannot resurface and re-reject on every later turn.
 */

import {
  type ContentBlock,
  type Message,
  resolveMediaSourceData,
} from "@vellumai/plugin-api";

import {
  isBelowMinDimension,
  optimizeImageForTransport,
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

/**
 * Note left in place of an image that cannot be sent to the provider. Shared
 * with the in-memory recovery path so the persisted history matches what the
 * model saw on the turn the image was rejected.
 */
export const UNSENDABLE_IMAGE_NOTE =
  "(An image was attached but could not be sent — it does not meet the provider's image size limits and automatic resizing was not available. Please resize the image and try again.)";

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
 * Shared by the in-memory recovery transform and the durable persist pass so
 * both apply the identical rule. Persisting the resized form is what lets a
 * poisoned conversation durably self-heal — the latest tool-result media is kept
 * in context, so without it the original rejected block rehydrates and
 * re-rejects on every later turn.
 */
export function unsendableImageReplacement(
  block: Extract<ContentBlock, { type: "image" }>,
): ContentBlock | null {
  // Resolve reference sources to their bytes so a reloaded (referenced) image
  // is gated on the same payload/dimension caps as an inline one. When the
  // attachment can no longer be read, leave the block untouched.
  const resolved = resolveMediaSourceData(block.source);
  if (!resolved) return null;
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

  const optimized = optimizeImageForTransport(
    resolved.data,
    resolved.media_type,
  );
  if (optimized.data !== resolved.data) {
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
 * Rewrite every stored message in a conversation that holds an image the
 * provider rejects — whether a top-level block or one nested in a
 * tool_result's contentBlocks — replacing it with its resized form, or with
 * {@link UNSENDABLE_IMAGE_NOTE} when it cannot be resized on this host. Reads
 * stored content directly (not the in-memory, injection-enriched copy) so
 * injected prefixes and hydrated source paths are never written back.
 *
 * Idempotent: a resized image is within limits and a note is no longer an
 * image, so neither matches on a second run. Returns the number of rewritten
 * messages.
 */
export function persistUnsendableImageDowngrades(
  conversationId: string,
): number {
  let rewritten = 0;
  for (const row of getMessages(conversationId)) {
    // Cheap prefilter — JSON.stringify emits no spaces, so an image block
    // always serializes with this exact substring.
    if (!row.content.includes('"type":"image"')) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.content);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    let changed = false;
    const next = (parsed as ContentBlock[]).map((block): ContentBlock => {
      if (block.type === "image") {
        const replacement = unsendableImageReplacement(block);
        if (!replacement) return block;
        changed = true;
        return replacement;
      }
      // Images returned by a tool (e.g. browser_screenshot) live inside the
      // tool_result's contentBlocks, not as top-level blocks. Downgrade them
      // in place so the tool_use/tool_result pairing stays intact.
      if (block.type === "tool_result" && block.contentBlocks?.length) {
        let nestedChanged = false;
        const contentBlocks = block.contentBlocks.map((cb): ContentBlock => {
          if (cb.type !== "image") return cb;
          const replacement = unsendableImageReplacement(cb);
          if (!replacement) return cb;
          nestedChanged = true;
          return replacement;
        });
        if (!nestedChanged) return block;
        changed = true;
        return { ...block, contentBlocks };
      }
      return block;
    });
    if (!changed) continue;

    updateMessageContent(row.id, JSON.stringify(next));
    rewritten++;
    log.info(
      { conversationId, messageId: row.id },
      "Persisted unsendable-image downgrade so it cannot resurface on later turns",
    );
  }
  return rewritten;
}

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
 * Resize every unsendable image in the working history for an immediate
 * retry, leaving still-sendable images untouched. Recovers both top-level image
 * blocks (user uploads) and images nested inside a tool_result's contentBlocks
 * (e.g. a browser screenshot) in place, so the tool_use/tool_result pairing
 * stays intact rather than dropping the whole tool_result. Applies the same
 * provider-cap gate as {@link persistUnsendableImageDowngrades} so the in-memory
 * retry and the durable rewrite agree on which images are unsendable.
 */
export function recoverUnsendableImages(
  messages: ReadonlyArray<Message>,
): Message[] {
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    if (!messageHasImageBlock(msg.content)) return msg;
    return {
      ...msg,
      content: msg.content.flatMap((b): ContentBlock[] => {
        if (b.type === "image") {
          return [unsendableImageReplacement(b) ?? b];
        }
        if (b.type === "tool_result" && b.contentBlocks?.length) {
          return [
            {
              ...b,
              contentBlocks: b.contentBlocks.map((cb) =>
                cb.type === "image"
                  ? (unsendableImageReplacement(cb) ?? cb)
                  : cb,
              ),
            },
          ];
        }
        return [b];
      }),
    };
  });
}
