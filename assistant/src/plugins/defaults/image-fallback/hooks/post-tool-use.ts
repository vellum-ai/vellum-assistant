/**
 * Default `post-tool-use` hook: when the active model is text-only, captions
 * the image blocks a tool returns (e.g. a `browser_screenshot`) and
 * substitutes the caption as a text block so the result stays sendable to a
 * provider that would otherwise reject the raw image.
 *
 * Tool images arrive nested in `toolResponse.contentBlocks` (the rich-content
 * companion to the tool result's text `content`), so the hook scans there
 * rather than the top-level message content the `user-prompt-submit` hook
 * handles. Both share {@link captionImageBlocks}.
 *
 * The active model is resolved from the workspace's active profile — the
 * post-tool-use context carries the running model, and the active profile is
 * what the loop is executing this turn. If that profile supports vision, the
 * hook is a no-op and the image reaches the model untouched.
 */

import {
  doesSupportVision,
  getModelProfiles,
  type PluginHookFn,
  type PostToolUseContext,
} from "@vellumai/plugin-api";

import { captionImageBlocks } from "../src/caption-blocks.js";
import { findVisionProfile } from "../src/vision-caption.js";

const postToolUse: PluginHookFn<PostToolUseContext> = async (ctx) => {
  const blocks = ctx.toolResponse.contentBlocks;
  if (blocks == null || blocks.length === 0) return;

  // If the active model already supports vision, leave the image in place.
  const activeProfile = getModelProfiles().find((p) => p.isActive);
  if (activeProfile == null) return;
  if (doesSupportVision(activeProfile)) return;

  // Find a vision-capable profile for captioning.
  const visionProfileKey = findVisionProfile();

  const imageCount = await captionImageBlocks(
    blocks,
    visionProfileKey,
    ctx.logger,
  );

  if (imageCount > 0) {
    ctx.logger.info(
      {
        plugin: "image-fallback",
        toolUseId: ctx.toolResponse.tool_use_id,
        imageCount,
      },
      "Replaced tool-result image blocks with text captions for text-only model",
    );
  }
};

export default postToolUse;
