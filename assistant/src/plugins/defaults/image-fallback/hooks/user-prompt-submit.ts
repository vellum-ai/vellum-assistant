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
 * 3. Persists each image to the workspace attachments directory (content-hash
 *    deduped) so the original image is accessible to future vision-capable
 *    turns or subagents.
 * 4. Captions each `ImageContent` block through the `vision` call site (with
 *    an in-memory content-hash cache to avoid re-captioning across turns), and
 *    replaces the block with `[Image: <caption>] (saved to <path>)`.
 *
 * Fail-open is the dominant error mode: a captioning failure leaves a
 * placeholder text block (with the saved image path) rather than the raw
 * image (which would cause a provider rejection on a text-only model) or
 * dropping the image entirely (which would lose information).
 */

import {
  doesSupportVision,
  getModelProfiles,
  type ImageContent,
  type PluginHookFn,
  type UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import { persistImage } from "../src/image-persist.js";
import { captionImage, findVisionProfile } from "../src/vision-caption.js";

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
    for (let i = 0; i < message.content.length; i++) {
      const block = message.content[i];
      if (block.type !== "image") continue;

      imageCount++;
      const image = block as ImageContent;

      // Persist the image to the workspace so it's accessible to future
      // vision-capable turns or subagents.
      const savedPath = persistImage(
        image.source.data,
        image.source.media_type,
      );

      if (visionProfileKey != null) {
        const caption = await captionImage(image, visionProfileKey, ctx.logger);
        const pathSuffix = savedPath != null ? ` (saved to ${savedPath})` : "";
        message.content[i] = {
          type: "text",
          text:
            caption != null
              ? `[Image: ${caption}]${pathSuffix}`
              : `[Image: captioning failed — unable to describe]${pathSuffix}`,
        };
      } else {
        // No vision profile configured at all — fail-open placeholder.
        const pathSuffix = savedPath != null ? ` (saved to ${savedPath})` : "";
        message.content[i] = {
          type: "text",
          text: `[Image: no vision-capable model configured to describe this image]${pathSuffix}`,
        };
      }
    }
  }

  if (imageCount > 0) {
    ctx.logger.info(
      { plugin: "image-fallback", imageCount },
      "Replaced image blocks with text captions for text-only model",
    );
  }
};

export default userPromptSubmit;
