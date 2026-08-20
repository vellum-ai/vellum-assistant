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
 * 4. Posts a transcript system card when an image the user attached to this
 *    turn reached step 3 with no vision profile configured, since that image
 *    is information the model never receives in any form.
 *
 * The card covers only images attached to the message this turn submitted.
 * The sweep also walks earlier turns (persisted rows keep their raw images, so
 * every turn re-encounters them) and tool-returned media, and describing those
 * again would post a card per turn for images the user already heard about.
 *
 * The companion `post-tool-use` hook applies the same substitution to images a
 * tool returns (e.g. a browser screenshot), and `post-compact` re-sweeps the
 * rebuilt history after a mid-turn compaction.
 */

import {
  type HookFunction,
  type Message,
  persistSystemCard,
  type UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import {
  captionImageBlocks,
  captionImagesInMessages,
  needsImageFallback,
} from "../src/caption-blocks.js";
import { findVisionProfile } from "../src/vision-caption.js";

/**
 * The user message this turn submitted: the tail of the pre-hook history
 * snapshot, still the same object inside the working history (earlier hooks
 * inject runtime-context blocks into it rather than replacing it). Returns
 * `null` when the working history no longer holds that object, so a caption
 * only ever lands on blocks the provider call will actually carry.
 */
function submittedUserMessage(ctx: UserPromptSubmitContext): Message | null {
  const submitted = ctx.originalMessages[ctx.originalMessages.length - 1];
  if (submitted == null || submitted.role !== "user") {
    return null;
  }
  return ctx.latestMessages.includes(submitted) ? submitted : null;
}

/** Transcript copy for images this turn could not send to the model. */
function droppedImageCardText(count: number): string {
  return count === 1
    ? "The image you attached was not sent to the model: no vision-capable model is configured to describe it. Configure one to use images in this conversation."
    : `The ${count} images you attached were not sent to the model: no vision-capable model is configured to describe them. Configure one to use images in this conversation.`;
}

const userPromptSubmit: HookFunction<UserPromptSubmitContext> = async (ctx) => {
  // If the turn's model already supports vision, nothing to do.
  if (!needsImageFallback(ctx.modelProfileKey)) {
    return;
  }

  // Find a vision-capable profile for captioning.
  const visionProfileKey = findVisionProfile();

  // Substitute this turn's own attachments first, so their tally is the one
  // the user is told about; the sweep below then finds them already captioned.
  const submitted = submittedUserMessage(ctx);
  const submittedCounts =
    submitted != null
      ? await captionImageBlocks(
          submitted.content,
          ctx.conversationId,
          visionProfileKey,
          ctx.logger,
        )
      : { replaced: 0, droppedNoVision: 0 };

  // Scan all messages for image blocks and replace them with captions.
  const counts = await captionImagesInMessages(
    ctx.latestMessages,
    ctx.conversationId,
    visionProfileKey,
    ctx.logger,
  );

  const imageCount = counts.replaced + submittedCounts.replaced;
  if (imageCount > 0) {
    ctx.logger.info(
      { plugin: "image-fallback", imageCount },
      "Replaced image blocks with text captions for text-only model",
    );
  }

  if (submittedCounts.droppedNoVision > 0) {
    try {
      await persistSystemCard({
        conversationId: ctx.conversationId,
        text: droppedImageCardText(submittedCounts.droppedNoVision),
        metadata: {
          plugin: "image-fallback",
          droppedImageCount: submittedCounts.droppedNoVision,
        },
      });
    } catch (err) {
      // The turn proceeds with the placeholder text either way; the notice is
      // the only thing lost.
      ctx.logger.warn(
        { plugin: "image-fallback", err },
        "Failed to post dropped-image notice",
      );
    }
  }
};

export default userPromptSubmit;
