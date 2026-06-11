/**
 * Default `post-model-call` hook: recovers from a provider image-too-large
 * rejection.
 *
 * A provider rejects the call when an attached image violates a hard limit —
 * its longest side exceeds the per-side pixel cap, or its base64 payload
 * exceeds the size cap. That rejection is a model-call outcome — the loop runs
 * the `post-model-call` chain with the rejection attached. This hook recognizes
 * the image-too-large class, downscales the oversized image blocks in the
 * working history via {@link recoverOversizedImages}, and asks the loop to
 * retry the call. It also persists the same downgrade durably via {@link
 * persistUnsendableImageDowngrades} so the rejected image cannot rehydrate from
 * the stored row and re-reject on every later turn.
 *
 * Bounded to one pass per turn via the per-conversation recovery state: a
 * second consecutive image-too-large rejection means the downscale could not
 * bring the image under the cap, so the hook leaves the error to surface rather
 * than looping. The loop's per-run backstop caps these retries globally; this
 * one-shot mark keeps a single recovery attempt per turn. This hook marks the
 * conversation when it retries and clears the mark on any outcome it resolves (a
 * finalized reply, a non-image rejection, or the exhausted second image
 * rejection); the sibling `stop` hook clears it on the one terminal this hook
 * does not resolve — a retry the loop's per-run backstop overrides — so the
 * next turn recovers afresh.
 *
 * A finalized reply (the model returned content) is left untouched for the
 * empty-response hook; only a provider rejection is this hook's to act on.
 */

import type { PluginHookFn, PostModelCallContext } from "@vellumai/plugin-api";

import type { ContentBlock } from "../../../../providers/types.js";
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

function hasToolUse(content: ReadonlyArray<ContentBlock>): boolean {
  return content.some((block) => block.type === "tool_use");
}

const postModelCall: PluginHookFn<PostModelCallContext> = async (ctx) => {
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

  // A tool-bearing turn continues mid-run — the loop runs the tools — so leave
  // the bound intact: a later image rejection this turn must still be
  // recognized as this hook's exhausted second attempt rather than a fresh
  // first one. (A provider rejection carries empty content, so this never fires
  // for one.)
  if (hasToolUse(ctx.content)) return;

  // A terminal outcome for this hook — a finalized no-tool reply or a non-image
  // rejection — ends the turn, so clear the bound the next turn starts from. A
  // `"continue"` decision means an earlier hook is already retrying this turn;
  // the bound must survive that retry so a later image rejection in the same
  // turn is recognized as this hook's exhausted second attempt rather than a
  // fresh first one.
  if (ctx.decision === "stop") {
    clearImageRecoveryAttempted(ctx.conversationId);
  }
};

export default postModelCall;
