/**
 * Shared image→text substitution for the image-fallback plugin's hooks.
 *
 * Three hooks replace `image` content blocks with a text caption when the
 * turn's model can't process images: `user-prompt-submit` sweeps the turn's
 * history at turn start, `post-tool-use` handles images a tool returns (e.g. a
 * browser screenshot) as they arrive, and `post-compact` re-sweeps the rebuilt
 * history after a mid-turn compaction. This module holds what they share —
 * deciding whether a profile needs the fallback ({@link needsImageFallback}),
 * the per-block substitution ({@link captionImageBlocks}): persist the
 * original image to a known location, caption it via a vision-capable
 * profile, and swap in a `[Image …]` text block — and the message-level deep
 * sweep ({@link captionImagesInMessages}) that reaches images nested inside
 * `tool_result` blocks as well as top-level ones.
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
 * description rather than a verbatim transcript.
 *
 * Fail-open is the dominant error mode: a captioning failure leaves a
 * placeholder text block rather than the raw image (which a text-only provider
 * would reject) or nothing (which would lose information).
 */

import {
  type ContentBlock,
  doesSupportVision,
  getModelProfiles,
  type ImageContent,
  lastToolResultUserMessageIndex,
  type Message,
  type PluginLogger,
  resolveMediaSourceData,
} from "@vellumai/plugin-api";

import { persistImage } from "./image-persist.js";
import { captionImage, type VisionProviderResolver } from "./vision-caption.js";

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
 * Replace every `image` block in `blocks` (in place) with a text caption so a
 * text-only model can still reason about the image's content. Returns the
 * number of image blocks replaced.
 *
 * @param blocks            Content-block array to scan and mutate in place.
 * @param conversationId    Conversation the blocks belong to, recorded on the
 *                          caption-cache rows so `conversation-deleted`
 *                          cleanup stays accurate.
 * @param resolver          Sweep-scoped vision provider resolver. `hasCandidates`
 *                          gates the placeholder wording (no vision model vs.
 *                          captioning failed); `resolve` supplies the provider.
 * @param logger            Turn-scoped logger for attribution.
 */
export async function captionImageBlocks(
  blocks: ContentBlock[],
  conversationId: string,
  resolver: VisionProviderResolver,
  logger: PluginLogger,
): Promise<number> {
  let imageCount = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== "image") {
      continue;
    }

    imageCount++;
    const image = block as ImageContent;

    // Persist the original to a known, content-hash-deduped location so it
    // survives the text substitution and stays findable on disk. Resolve a
    // reference source to its bytes first (a no-op for inline base64).
    const resolvedForPersist = resolveMediaSourceData(image.source);
    if (resolvedForPersist) {
      persistImage(resolvedForPersist.data, resolvedForPersist.media_type);
    }

    if (resolver.hasCandidates()) {
      const caption = await captionImage(
        image,
        conversationId,
        resolver,
        logger,
      );
      blocks[i] = {
        type: "text",
        text:
          caption != null
            ? `[Image auto-described for text-only model: ${caption}]`
            : `[Image: auto-description failed (text-only model)]`,
      };
    } else {
      // No vision profile configured at all — fail-open placeholder.
      blocks[i] = {
        type: "text",
        text: `[Image: no vision-capable model configured to describe it]`,
      };
    }
  }

  return imageCount;
}

/**
 * Replace image blocks nested in a message's `tool_result` blocks' rich
 * `contentBlocks` (in place) with text captions. Returns the number replaced.
 */
async function captionToolResultMedia(
  message: Message,
  conversationId: string,
  resolver: VisionProviderResolver,
  logger: PluginLogger,
): Promise<number> {
  let imageCount = 0;
  for (const block of message.content) {
    if (block.type === "tool_result" && block.contentBlocks != null) {
      imageCount += await captionImageBlocks(
        block.contentBlocks,
        conversationId,
        resolver,
        logger,
      );
    }
  }
  return imageCount;
}

/**
 * Deep-sweep a message list (in place) for image blocks and replace each with
 * a text caption via {@link captionImageBlocks}. Covers both top-level image
 * blocks (user-attached images, the compactor's retained-image message) and
 * images nested in a `tool_result` block's rich `contentBlocks` (tool results
 * restored from persistence carry their raw images there). Returns the number
 * of image blocks replaced.
 */
export async function captionImagesInMessages(
  messages: Message[],
  conversationId: string,
  resolver: VisionProviderResolver,
  logger: PluginLogger,
): Promise<number> {
  let imageCount = 0;
  for (const message of messages) {
    imageCount += await captionImageBlocks(
      message.content,
      conversationId,
      resolver,
      logger,
    );
    imageCount += await captionToolResultMedia(
      message,
      conversationId,
      resolver,
      logger,
    );
  }
  return imageCount;
}

/**
 * Caption only the image blocks a rejected model call would still carry after
 * the host's outbound media-stripping: every top-level image block (the
 * sanitizer never strips those) plus tool_result media in the current-turn
 * message ({@link lastToolResultUserMessageIndex}, the one the sanitizer keeps
 * intact). Older tool_result media is left raw so the sanitizer replaces it
 * with its compact removed-media marker on the retry rather than a full
 * caption — captioning it would waste vision calls and balloon context.
 * Returns the number of image blocks replaced.
 */
export async function captionOutboundImagesInMessages(
  messages: Message[],
  conversationId: string,
  resolver: VisionProviderResolver,
  logger: PluginLogger,
): Promise<number> {
  const currentTurnIdx = lastToolResultUserMessageIndex(messages);
  let imageCount = 0;
  for (let i = 0; i < messages.length; i++) {
    imageCount += await captionImageBlocks(
      messages[i].content,
      conversationId,
      resolver,
      logger,
    );
    if (i === currentTurnIdx) {
      imageCount += await captionToolResultMedia(
        messages[i],
        conversationId,
        resolver,
        logger,
      );
    }
  }
  return imageCount;
}
