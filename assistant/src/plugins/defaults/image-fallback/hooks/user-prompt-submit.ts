/**
 * Default `user-prompt-submit` hook: when the turn's model is text-only,
 * captions image blocks via a vision-capable profile and substitutes the
 * caption as a text block so the model can still reason about the image's
 * content.
 *
 * The hook runs once per user turn, after the assistant assembles
 * `latestMessages` and before they flow into `agentLoop.run()`. It:
 *
 * 1. Checks whether the turn's model needs image→text fallback via
 *    {@link needsImageFallback}, using the turn's effective `modelProfileKey`.
 *    If the model handles images, the hook is a no-op.
 * 2. Finds a vision-capable profile for captioning via `findVisionProfile`.
 *    If none exists, images are replaced with a fail-open placeholder so the
 *    model at least knows an image was present.
 * 3. Replaces each image block with a `[Image …]` text caption via
 *    {@link captionImagesInMessages} (which also persists the original and
 *    caches captions across turns), sweeping top-level blocks and images
 *    nested in `tool_result` blocks alike.
 *
 * The companion `post-tool-use` hook applies the same substitution to images a
 * tool returns (e.g. a browser screenshot), and `post-compact` re-sweeps the
 * rebuilt history after a mid-turn compaction.
 */

import {
  type HookFunction,
  type UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import {
  captionImagesInMessages,
  needsImageFallback,
} from "../src/caption-blocks.js";
import { findVisionProfile } from "../src/vision-caption.js";

const userPromptSubmit: HookFunction<UserPromptSubmitContext> = async (ctx) => {
  // If the turn's model already supports vision, nothing to do.
  if (!needsImageFallback(ctx.modelProfileKey)) return;

  // Find a vision-capable profile for captioning.
  const visionProfileKey = findVisionProfile();

  // Scan all messages for image blocks and replace them with captions.
  const imageCount = await captionImagesInMessages(
    ctx.latestMessages,
    ctx.conversationId,
    visionProfileKey,
    ctx.logger,
  );

  if (imageCount > 0) {
    ctx.logger.info(
      { plugin: "image-fallback", imageCount },
      "Replaced image blocks with text captions for text-only model",
    );
  }
};

export default userPromptSubmit;
