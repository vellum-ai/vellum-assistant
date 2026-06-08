/**
 * Persistence for the image-too-large recovery path.
 *
 * When the provider rejects a turn because an attached image exceeds its
 * limits, the agent loop downgrades the offending image blocks in memory and
 * retries. That transformation is transient — the stored message row keeps the
 * full-size image block, so the rejected image is rehydrated on every later
 * turn and keeps re-entering the model's context. This module makes the
 * downgrade durable for images that can *never* be transmitted, so a rejected
 * upload cannot resurface after the user re-uploads a smaller version.
 */

import { optimizeImageForTransport } from "../agent/image-optimize.js";
import { parseImageDimensions } from "../context/image-dimensions.js";
import {
  getMessages,
  updateMessageContent,
} from "../memory/conversation-crud.js";
import type { ContentBlock } from "../providers/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("persist-unsendable-image");

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
  "(An image was attached but could not be sent — its dimensions exceed the provider limit and automatic resize was not available. Please resize the image and try again.)";

/**
 * True when a stored image block can never be transmitted to the provider: it
 * violates a provider hard limit (per-side pixel cap or payload size) and
 * cannot be shrunk to fit (re-optimization is a no-op).
 *
 * Stored blocks are already post-optimization, so a block that is still
 * oversized here only stays oversized because resizing is unavailable on this
 * host (e.g. `sips` is absent off macOS, or the format is unsupported). A
 * downscalable image would have been reduced at upload time and would not reach
 * this predicate, so it is left untouched.
 */
function isImagePermanentlyUnsendable(
  block: Extract<ContentBlock, { type: "image" }>,
): boolean {
  const payloadBytes = block.source.data.length;
  const dims = parseImageDimensions(block.source.data, block.source.media_type);
  const exceedsDimensionCap =
    dims != null &&
    (dims.width > PROVIDER_MAX_IMAGE_DIMENSION ||
      dims.height > PROVIDER_MAX_IMAGE_DIMENSION);
  const exceedsPayloadCap = payloadBytes > PROVIDER_MAX_IMAGE_PAYLOAD_BYTES;
  if (!exceedsDimensionCap && !exceedsPayloadCap) return false;

  const optimized = optimizeImageForTransport(
    block.source.data,
    block.source.media_type,
  );
  return optimized.data === block.source.data;
}

/**
 * Replacement note for a permanently unsendable image, or null when the image
 * is fine and should be left untouched. Shared by the top-level and nested
 * (tool_result.contentBlocks) downgrade paths.
 */
function unsendableImageNote(
  block: Extract<ContentBlock, { type: "image" }>,
): ContentBlock | null {
  if (!isImagePermanentlyUnsendable(block)) return null;
  return { type: "text", text: UNSENDABLE_IMAGE_NOTE };
}

/**
 * Rewrite every stored message in a conversation that holds a permanently
 * unsendable image, replacing those image blocks with {@link
 * UNSENDABLE_IMAGE_NOTE}. Reads stored content directly (not the in-memory,
 * injection-enriched copy) so injected prefixes and hydrated source paths are
 * never written back.
 *
 * Idempotent: once an image is replaced by the note there is no image block
 * left to match, so re-running is a no-op. Returns the number of rewritten
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
        const note = unsendableImageNote(block);
        if (!note) return block;
        changed = true;
        return note;
      }
      // Images returned by a tool (e.g. browser_screenshot) live inside the
      // tool_result's contentBlocks, not as top-level blocks. Downgrade them
      // in place so the tool_use/tool_result pairing stays intact.
      if (block.type === "tool_result" && block.contentBlocks?.length) {
        let nestedChanged = false;
        const contentBlocks = block.contentBlocks.map((cb): ContentBlock => {
          if (cb.type !== "image") return cb;
          const note = unsendableImageNote(cb);
          if (!note) return cb;
          nestedChanged = true;
          return note;
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
