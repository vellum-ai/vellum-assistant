/**
 * Default `post-model-call` hook: recovers from a provider image-input
 * rejection.
 *
 * A provider rejects the call when an attached image violates a hard limit —
 * its longest side exceeds the per-side pixel cap, its base64 payload exceeds
 * the size cap, it falls below the minimum size floor, or its bytes cannot be
 * decoded ("Could not process image" / "image does not match the provided
 * media type"). That rejection is a model-call outcome — the loop runs the
 * `post-model-call` chain with the rejection attached. This hook recognizes the
 * image-rejection class, selects the matching replacement rule (size vs.
 * unprocessable), rewrites the offending image blocks in the working history
 * via {@link recoverImages}, and asks the loop to retry the call. It also
 * persists the same rewrite durably via {@link persistImageDowngrades} so the
 * rejected image cannot rehydrate from the stored row and re-reject on every
 * later turn.
 *
 * Bounded to one pass per turn via the per-conversation recovery state: a
 * second consecutive image rejection means the resize could not bring the
 * image within the provider's limits, so the hook leaves the error to surface
 * rather than looping. The loop's per-run backstop caps these retries
 * globally; this one-shot mark keeps a single recovery attempt per turn. This
 * hook only ever marks the conversation; the sibling `stop` hook (see
 * `./stop.ts`) clears the mark when the turn terminates, so the next turn
 * recovers afresh.
 *
 * A finalized reply (the model returned content) is left untouched for the
 * empty-response hook; only a provider rejection is this hook's to act on.
 */

import type { HookFunction, PostModelCallContext } from "@vellumai/plugin-api";

import {
  isImageUnprocessableError,
  isRecoverableImageError,
} from "../detect.js";
import {
  isImageRecoveryAttempted,
  markImageRecoveryAttempted,
} from "../image-recovery-state-store.js";
import {
  persistImageDowngrades,
  recoverImages,
  unprocessableImageReplacement,
  unsendableImageReplacement,
} from "../recover.js";

const postModelCall: HookFunction<PostModelCallContext> = async (ctx) => {
  if (
    ctx.error &&
    isRecoverableImageError(ctx.error.message) &&
    !isImageRecoveryAttempted(ctx.conversationId)
  ) {
    markImageRecoveryAttempted(ctx.conversationId);
    const rule = isImageUnprocessableError(ctx.error.message)
      ? unprocessableImageReplacement
      : unsendableImageReplacement;
    ctx.messages = recoverImages(ctx.messages, rule);
    // Make the downgrade durable so the rejected image can't rehydrate from the
    // stored row and re-reject on later turns. This is cleanup for future
    // turns, so a persistence failure must never abort the retry that is about
    // to run — log it and continue with the in-memory recovery.
    try {
      const rewritten = persistImageDowngrades(ctx.conversationId, rule);
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
      "Provider image rejection — recovering unsendable image blocks and retrying",
    );
  }
};

export default postModelCall;
