/**
 * Default `post-compact` hook: when the compacted turn's model is text-only,
 * re-sweeps the rebuilt history for image blocks and substitutes text
 * captions, so the provider call the loop resumes with never carries a raw
 * image to a model that rejects them.
 *
 * Compaction runs mid-turn, after the turn-start `user-prompt-submit` sweep,
 * and rebuilds history from persistence — which keeps raw images (the hook
 * pipeline hands hooks deep-cloned contexts, so earlier caption substitutions
 * never reach persisted rows). Two paths re-surface images here: the
 * compactor re-attaches retained images as top-level image blocks, and the
 * verbatim tail restores tool results whose `contentBlocks` still carry their
 * original images. Both are swept via {@link captionImagesInMessages};
 * previously captioned images resolve from the caption cache without a vision
 * call, and a captioning failure leaves a fail-open placeholder rather than
 * the raw image.
 */

import {
  type HookFunction,
  type PostCompactContext,
} from "@vellumai/plugin-api";

import {
  captionImagesInMessages,
  needsImageFallback,
} from "../src/caption-blocks.js";
import { findVisionProfile } from "../src/vision-caption.js";

const postCompact: HookFunction<PostCompactContext> = async (ctx) => {
  // If the turn's model already supports vision, leave images in place.
  if (!needsImageFallback(ctx.modelProfileKey)) return;

  // Find a vision-capable profile for captioning.
  const visionProfileKey = findVisionProfile();

  const imageCount = await captionImagesInMessages(
    ctx.history,
    visionProfileKey,
    ctx.logger,
  );

  if (imageCount > 0) {
    ctx.logger.info(
      { plugin: "image-fallback", imageCount },
      "Replaced compacted-history image blocks with text captions for text-only model",
    );
  }
};

export default postCompact;
