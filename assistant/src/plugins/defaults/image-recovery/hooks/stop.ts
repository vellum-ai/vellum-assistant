/**
 * Default `stop` hook: recovers from a provider image-too-large rejection.
 *
 * A provider rejects the call when an attached image violates a hard limit —
 * its longest side exceeds the per-side pixel cap, or its base64 payload
 * exceeds the size cap. That rejection is an error stop — the loop runs the
 * `stop` chain with the rejection attached. This hook recognizes the
 * image-too-large class, downscales the oversized image blocks in the working
 * history via {@link recoverOversizedImages}, and asks the loop to retry the
 * call. It also persists the same downgrade durably via {@link
 * persistUnsendableImageDowngrades} so the rejected image cannot rehydrate from
 * the stored row and re-reject on every later turn.
 *
 * Bounded to one pass per turn via the per-conversation recovery state: a
 * second consecutive image-too-large rejection means the downscale could not
 * bring the image under the cap, so the hook leaves the error to surface rather
 * than looping. The hook owns that state — it marks the conversation when it
 * retries and clears the mark on any terminal stop (a successful response, a
 * non-image rejection, or the exhausted second image rejection), so the next
 * turn recovers afresh without the loop or wrapper resetting anything.
 *
 * A successful stop (the model returned a response) is otherwise left untouched
 * for the empty-response plugin.
 */

import type { PluginHookFn, StopContext } from "@vellumai/plugin-api";

import { isImageDimensionsTooLargeError } from "../detect.js";
import {
  clearImageRecoveryAttempted,
  isImageRecoveryAttempted,
  markImageRecoveryAttempted,
} from "../image-recovery-state-store.js";
import {
  persistUnsendableImageDowngrades,
  recoverOversizedImages,
} from "../recover.js";

const stop: PluginHookFn<StopContext> = async (ctx) => {
  if (ctx.error && isImageDimensionsTooLargeError(ctx.error.message)) {
    if (!isImageRecoveryAttempted(ctx.conversationId)) {
      markImageRecoveryAttempted(ctx.conversationId);
      ctx.messages = recoverOversizedImages(ctx.messages);
      // Make the downgrade durable so the rejected image can't rehydrate from
      // the stored row and re-reject on later turns. This is cleanup for future
      // turns, so a persistence failure must never abort the retry that is
      // about to run — log it and continue with the in-memory recovery.
      try {
        const rewritten = persistUnsendableImageDowngrades(ctx.conversationId);
        if (rewritten > 0) {
          ctx.logger.info(
            { plugin: "image-recovery", rewritten },
            "Persisted unsendable-image downgrades so they cannot resurface",
          );
        }
      } catch (err) {
        ctx.logger.warn(
          { plugin: "image-recovery", err },
          "Failed to persist unsendable-image downgrade; continuing with in-memory recovery",
        );
      }
      ctx.decision = "continue";
      ctx.logger.warn(
        { plugin: "image-recovery", messageCount: ctx.messages.length },
        "Provider image-too-large error — recovering oversized image blocks and retrying",
      );
      return;
    }
    // The recovery already ran this turn and the call still rejected on
    // image-size grounds, so it could not bring the image under the cap. Clear
    // the bound and let the error surface rather than looping.
    clearImageRecoveryAttempted(ctx.conversationId);
    return;
  }

  // Any other stop — a successful response or a non-image rejection — ends the
  // turn, so clear the bound the next turn starts from.
  clearImageRecoveryAttempted(ctx.conversationId);
};

export default stop;
