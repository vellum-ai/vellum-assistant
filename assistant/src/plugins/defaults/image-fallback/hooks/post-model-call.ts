/**
 * Default `post-model-call` hook: recovers from a provider vision-not-supported
 * rejection.
 *
 * The turn-start sweep captions history images when the turn's profile is
 * text-only, but raw images can still reach a non-vision model through paths
 * the sweep does not cover — messages that join an in-flight turn (rapid-fire
 * batches, subagent completions), catalog entries that call a model
 * vision-capable when the serving endpoint rejects images, or provider
 * fallback to a text-only model after the sweep decided. The provider's
 * rejection is ground truth that image input cannot be sent, regardless of
 * what the catalog claims. This hook recognizes the rejection class, captions
 * every image block in the working history via the plugin's shared
 * substitution (fail-open placeholders when captioning fails), and asks the
 * loop to retry the call.
 *
 * Unlike the image-recovery plugin's image-too-large flow, nothing is
 * persisted: the stored rows keep the raw image, which clients render and
 * vision-capable profiles can still consume on later turns. The caption cache
 * makes the re-sweeps on those turns lookup-only.
 *
 * Bounded to one pass per turn via the per-conversation recovery state: a
 * second consecutive vision rejection means captioning could not clear the
 * request of image input, so the hook leaves the error to surface rather than
 * looping. The loop's per-run backstop caps these retries globally; this
 * one-shot mark keeps a single recovery attempt per turn. This hook only ever
 * marks the conversation; the sibling `stop` hook (see `./stop.ts`) clears the
 * mark when the turn terminates, so the next turn recovers afresh.
 *
 * A finalized reply (the model returned content) is left untouched; only a
 * provider rejection is this hook's to act on.
 */

import type { HookFunction, PostModelCallContext } from "@vellumai/plugin-api";

import { captionImagesInMessages } from "../src/caption-blocks.js";
import {
  isVisionRecoveryAttempted,
  markVisionRecoveryAttempted,
} from "../src/recovery-state.js";
import { findVisionProfile } from "../src/vision-caption.js";
import { isVisionNotSupportedError } from "../src/vision-error.js";

const postModelCall: HookFunction<PostModelCallContext> = async (ctx) => {
  if (
    !ctx.error ||
    !isVisionNotSupportedError(ctx.error.message) ||
    isVisionRecoveryAttempted(ctx.conversationId)
  ) {
    return;
  }
  markVisionRecoveryAttempted(ctx.conversationId);

  const visionProfileKey = findVisionProfile();
  const captioned = await captionImagesInMessages(
    ctx.messages,
    ctx.conversationId,
    visionProfileKey,
    ctx.logger,
  );

  if (captioned === 0) {
    // The rejection names image input but the working history holds no image
    // blocks to caption — retrying the identical request would just re-reject,
    // so leave the error to surface.
    ctx.logger.warn(
      { plugin: "image-fallback" },
      "Provider vision-not-supported error but no image blocks found in history; not retrying",
    );
    return;
  }

  ctx.decision = "continue";
  ctx.logger.warn(
    { plugin: "image-fallback", captioned },
    "Provider vision-not-supported error — captioned image blocks and retrying",
  );
};

export default postModelCall;
