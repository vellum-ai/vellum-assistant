/**
 * Default `post-tool-use` hook: when the turn's model is text-only, captions
 * the image blocks a tool returns (e.g. a `browser_screenshot`) and
 * substitutes the caption as a text block so the result stays sendable to a
 * provider that would otherwise reject the raw image.
 *
 * Tool images arrive nested in `toolResponse.contentBlocks` (the rich-content
 * companion to the tool result's text `content`), so the hook scans there
 * rather than the message-level sweep the `user-prompt-submit` and
 * `post-compact` hooks run. All three share {@link captionImageBlocks}.
 *
 * Capability is read straight off `ctx.model` — the provider-reported model id
 * for the turn that issued this tool call — so the decision tracks the model
 * that actually ran, including a text-only override. The hook receives a deep
 * clone of the tool result, so the caption reaches the provider-bound history
 * only — the persisted/displayed tool result keeps the original image, and
 * later rebuild-from-persistence sweeps re-caption it from the cache.
 */

import {
  doesSupportVision,
  type HookFunction,
  type PostToolUseContext,
} from "@vellumai/plugin-api";

import { captionImageBlocks } from "../src/caption-blocks.js";
import { findVisionProfile } from "../src/vision-caption.js";

const postToolUse: HookFunction<PostToolUseContext> = async (ctx) => {
  // Cheapest gate first: bail unless the tool actually returned an image,
  // before touching the model catalog or resolving a vision profile.
  const blocks = ctx.toolResponse.contentBlocks;
  if (blocks == null || !blocks.some((b) => b.type === "image")) return;

  // If the model that ran already supports vision, leave the image in place.
  if (doesSupportVision(ctx.model)) return;

  // Find a vision-capable profile for captioning.
  const visionProfileKey = findVisionProfile();

  const imageCount = await captionImageBlocks(
    blocks,
    ctx.conversationId,
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
