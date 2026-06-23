/**
 * Default `user-prompt-submit` hook: when the active model is text-only,
 * captions image blocks via a vision-capable profile and substitutes the
 * caption as a text block so the model can still reason about the image's
 * content.
 *
 * The hook runs once per user turn, after the assistant assembles
 * `latestMessages` and before they flow into `agentLoop.run()`. It:
 *
 * 1. Resolves the active profile from `modelProfileKey` (or the workspace's
 *    active profile when the key is `null`) and checks `doesSupportVision`.
 *    If the model already handles images, the hook is a no-op.
 * 2. Finds a vision-capable profile for captioning via `findVisionProfile`.
 *    If none exists, images are replaced with a fail-open placeholder so the
 *    model at least knows an image was present.
 * 3. Replaces each `ImageContent` block with a `[Image …]` text caption via
 *    {@link captionImageBlocks} (which also persists the original and caches
 *    captions across turns).
 *
 * The companion `post-tool-use` hook applies the same substitution to images a
 * tool returns (e.g. a browser screenshot).
 */

import {
  doesSupportVision,
  getModelProfiles,
  type PluginHookFn,
  type UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import { captionImageBlocks } from "../src/caption-blocks.js";
import { findVisionProfile } from "../src/vision-caption.js";

const userPromptSubmit: PluginHookFn<UserPromptSubmitContext> = async (ctx) => {
  // Resolve the active profile from modelProfileKey, falling back to the
  // workspace's active profile when the key is null (profile unchanged since
  // the last notified turn).
  const profiles = getModelProfiles();
  const activeProfile =
    ctx.modelProfileKey != null
      ? profiles.find((p) => p.key === ctx.modelProfileKey)
      : profiles.find((p) => p.isActive);
  if (activeProfile == null) return;

  // If the active model already supports vision, nothing to do.
  if (doesSupportVision(activeProfile)) return;

  // Find a vision-capable profile for captioning.
  const visionProfileKey = findVisionProfile();

  // Scan all messages for image blocks and replace them with captions.
  let imageCount = 0;
  for (const message of ctx.latestMessages) {
    imageCount += await captionImageBlocks(
      message.content,
      visionProfileKey,
      ctx.logger,
    );
  }

  if (imageCount > 0) {
    ctx.logger.info(
      { plugin: "image-fallback", imageCount },
      "Replaced image blocks with text captions for text-only model",
    );
  }
};

export default userPromptSubmit;
