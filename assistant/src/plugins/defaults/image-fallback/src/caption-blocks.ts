/**
 * Shared image→text substitution for the image-fallback plugin's hooks.
 *
 * Three hooks replace `image` content blocks with a text caption when the
 * turn's model can't process images: `user-prompt-submit` sweeps the turn's
 * history at turn start, `post-tool-use` handles images a tool returns (e.g. a
 * browser screenshot) as they arrive, and `post-compact` re-sweeps the rebuilt
 * history after a mid-turn compaction. This module holds what they share —
 * deciding whether a profile needs the fallback ({@link needsImageFallback}),
 * the per-block substitution ({@link captionImageBlocks}): locate the original
 * image on disk, index it for `image_ask`, caption it via a vision-capable
 * profile, and swap in a `[Image "<filename>" …]` text block — and the message-level deep
 * sweep ({@link captionImagesInMessages}) that reaches images nested inside
 * `tool_result` blocks as well as top-level ones. The message-level sweeps
 * close by merging text-only user content into a single text block
 * ({@link flattenTextOnlyBlocks}), the shape providers serialize as a plain
 * string.
 *
 * The substitution mutates the blocks in place, but the hook pipeline hands
 * each hook a deep clone of its context, so the caption reaches only the
 * provider-bound history — persisted rows keep the raw image (clients render
 * it). Rebuild-from-persistence paths therefore re-surface raw images, which
 * is why the sweeps re-run per turn and per compaction; the caption cache
 * makes re-encounters lookup-only.
 *
 * The caption text states up front that the model can't view images and the
 * image was auto-described to text, so the model treats the block as a derived
 * description rather than a verbatim transcript. It names the image by its
 * filename, which is the handle the `image_ask` tool resolves back to bytes
 * when the model needs a detail the caption left out.
 *
 * `imageFallback.captionMode` chooses between the two. `caption` (the default)
 * describes every image up front. `handle-only` substitutes the name alone and
 * makes no vision call, leaving every look to `image_ask`.
 *
 * Fail-open is the dominant error mode: a captioning failure leaves a
 * placeholder text block rather than the raw image (which a text-only provider
 * would reject) or nothing (which would lose information).
 */

import { basename } from "node:path";

import {
  type ContentBlock,
  doesSupportVision,
  getAttachmentFilePath,
  getModelProfiles,
  type ImageContent,
  lastToolResultUserMessageIndex,
  type Message,
  type PluginLogger,
  resolveMediaSourceData,
} from "@vellumai/plugin-api";

import { imageHash } from "./caption-cache.js";
import { getCaptionMode } from "./caption-mode.js";
import { recordConversationImage } from "./image-index.js";
import { persistImage } from "./image-persist.js";
import { captionImage } from "./vision-caption.js";

/**
 * Whether the profile a turn runs needs image→text fallback (i.e. it can't
 * process images itself).
 *
 * Used by `user-prompt-submit`, whose context carries the effective profile
 * identity. Profileless configs use the resolved model id, which
 * `doesSupportVision` can check directly.
 */
export function needsImageFallback(modelProfileKey: string): boolean {
  const profiles = getModelProfiles();
  const profile = profiles.find((p) => p.key === modelProfileKey);
  if (profile == null) {
    return !doesSupportVision(modelProfileKey);
  }
  return !doesSupportVision(profile);
}

/**
 * On-disk location of an image block, or `null` when it has none.
 *
 * A `workspace_ref` block already names a file the host's attachment store
 * owns, so that path is the canonical one and no second copy is written.
 * Inline base64 (mid-turn screenshots, legacy rows) has no file yet, so it
 * lands in the plugin's content-hash-deduped attachments copy.
 */
function resolveImageFilePath(
  image: ImageContent,
  resolved: { data: string; media_type: string } | null,
): string | null {
  if (image.source.type === "workspace_ref") {
    try {
      const stored = getAttachmentFilePath(image.source.attachmentId);
      if (stored != null && stored !== "") {
        return stored;
      }
    } catch {
      // Attachment store unavailable: fall through to a persisted copy.
    }
  }
  if (resolved != null) {
    return persistImage(resolved.data, resolved.media_type);
  }
  return null;
}

/**
 * Opening of the `[Image …]` text that replaces an image block, naming the
 * image by filename when one is known.
 *
 * The filename is the model's only way to point at a specific image, so it is
 * also what `image_ask` matches its `image` argument against.
 */
function imageHandlePrefix(handle: string | null): string {
  return handle != null ? `[Image "${handle}"` : "[Image";
}

/**
 * Replace every `image` block in `blocks` (in place) with a text caption so a
 * text-only model can still reason about the image's content.
 *
 * @param blocks            Content-block array to scan and mutate in place.
 * @param conversationId    Conversation the blocks belong to, recorded on the
 *                          caption-cache rows so `conversation-deleted`
 *                          cleanup stays accurate.
 * @param visionProfileKey  Key of a vision-capable profile for captioning, or
 *                          `null` when none is configured (fail-open
 *                          placeholder).
 * @param logger            Turn-scoped logger for attribution.
 */
export async function captionImageBlocks(
  blocks: ContentBlock[],
  conversationId: string,
  visionProfileKey: string | null,
  logger: PluginLogger,
): Promise<number> {
  let replaced = 0;
  // Read once per block array rather than per image: the setting cannot
  // change mid-sweep, and the config accessor is a cached read either way.
  const mode = getCaptionMode();

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== "image") {
      continue;
    }

    replaced++;
    const image = block as ImageContent;

    // Locate the original on disk so it survives the text substitution, stays
    // findable for the user, and gives the caption a filename to name it by.
    // Resolve a reference source to its bytes first (a no-op for inline
    // base64).
    const resolved = resolveMediaSourceData(image.source);
    const filePath = resolveImageFilePath(image, resolved);
    if (filePath != null && resolved != null) {
      recordConversationImage(
        conversationId,
        filePath,
        resolved.media_type,
        imageHash(resolved.data),
      );
    }
    const prefix = imageHandlePrefix(
      filePath != null ? basename(filePath) : null,
    );

    if (visionProfileKey != null && mode === "handle-only") {
      // The image is named but not described: nothing is spent on it unless
      // the model calls `image_ask`. An image with no file behind it cannot be
      // asked about, so say that rather than offering a handle that resolves
      // to nothing.
      blocks[i] = {
        type: "text",
        text:
          filePath != null
            ? `${prefix} available via image_ask]`
            : `${prefix}: no stored copy available to examine]`,
      };
    } else if (visionProfileKey != null) {
      const caption = await captionImage(
        image,
        conversationId,
        visionProfileKey,
        logger,
      );
      blocks[i] = {
        type: "text",
        text:
          caption != null
            ? `${prefix} auto-described for text-only model: ${caption}]`
            : `${prefix}: auto-description failed (text-only model)]`,
      };
    } else {
      // No vision profile configured at all: fail-open placeholder.
      blocks[i] = {
        type: "text",
        text: `${prefix}: no vision-capable model configured to describe it]`,
      };
    }
  }

  return replaced;
}

/**
 * Replace image blocks nested in a message's `tool_result` blocks' rich
 * `contentBlocks` (in place) with text captions.
 */
async function captionToolResultMedia(
  message: Message,
  conversationId: string,
  visionProfileKey: string | null,
  logger: PluginLogger,
): Promise<number> {
  let replaced = 0;
  for (const block of message.content) {
    if (block.type === "tool_result" && block.contentBlocks != null) {
      replaced += await captionImageBlocks(
        block.contentBlocks,
        conversationId,
        visionProfileKey,
        logger,
      );
    }
  }
  return replaced;
}

/**
 * Merge a user message's text blocks (in place) into a single text block,
 * joined by a blank line, for every message whose content is more than one
 * block and entirely text. Returns how many messages were merged.
 *
 * A text-only turn's user content is text after image substitution, and a
 * single text block is the shape providers serialize as a plain string:
 * OpenAI-compatible endpoints that accept only `messages[].content` as a
 * string (rejecting an array of content parts with
 * `body/messages/N/content must be string`) can then take the turn, and the
 * request costs fewer tokens than the equivalent array of parts. The blank
 * line keeps the boundaries between the blocks a user message carries (the
 * turn's runtime-injected context blocks plus the user's own text) legible.
 *
 * Content holding any non-text block (audio, tool results, an image no
 * fallback replaced) keeps its array shape, since merging would drop it.
 */
export function flattenTextOnlyBlocks(messages: Message[]): number {
  let flattened = 0;
  for (const message of messages) {
    if (message.role !== "user" || message.content.length <= 1) {
      continue;
    }
    if (!message.content.every((block) => block.type === "text")) {
      continue;
    }
    const text = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n\n");
    message.content = [{ type: "text", text }];
    flattened++;
  }
  return flattened;
}

/**
 * Deep-sweep a message list (in place) for image blocks and replace each with
 * a text caption via {@link captionImageBlocks}. Covers both top-level image
 * blocks (user-attached images, the compactor's retained-image message) and
 * images nested in a `tool_result` block's rich `contentBlocks` (tool results
 * restored from persistence carry their raw images there).
 *
 * Text-only user content is then merged via {@link flattenTextOnlyBlocks}.
 */
export async function captionImagesInMessages(
  messages: Message[],
  conversationId: string,
  visionProfileKey: string | null,
  logger: PluginLogger,
): Promise<number> {
  let replaced = 0;
  for (const message of messages) {
    replaced += await captionImageBlocks(
      message.content,
      conversationId,
      visionProfileKey,
      logger,
    );
    replaced += await captionToolResultMedia(
      message,
      conversationId,
      visionProfileKey,
      logger,
    );
  }
  flattenTextOnlyBlocks(messages);
  return replaced;
}

/**
 * Caption only the image blocks a rejected model call would still carry after
 * the host's outbound media-stripping: every top-level image block (the
 * sanitizer never strips those) plus tool_result media in the current-turn
 * message ({@link lastToolResultUserMessageIndex}, the one the sanitizer keeps
 * intact). Older tool_result media is left raw so the sanitizer replaces it
 * with its compact removed-media marker on the retry rather than a full
 * caption: captioning it would waste vision calls and balloon context.
 *
 * Text-only user content is then merged via {@link flattenTextOnlyBlocks}.
 */
export async function captionOutboundImagesInMessages(
  messages: Message[],
  conversationId: string,
  visionProfileKey: string | null,
  logger: PluginLogger,
): Promise<number> {
  const currentTurnIdx = lastToolResultUserMessageIndex(messages);
  let replaced = 0;
  for (let i = 0; i < messages.length; i++) {
    replaced += await captionImageBlocks(
      messages[i].content,
      conversationId,
      visionProfileKey,
      logger,
    );
    if (i === currentTurnIdx) {
      replaced += await captionToolResultMedia(
        messages[i],
        conversationId,
        visionProfileKey,
        logger,
      );
    }
  }
  flattenTextOnlyBlocks(messages);
  return replaced;
}
