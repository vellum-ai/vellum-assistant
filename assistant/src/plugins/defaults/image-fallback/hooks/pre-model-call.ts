/**
 * Default `pre-model-call` hook: the wire-boundary guard that keeps raw image
 * blocks off requests bound for a model that cannot accept them.
 *
 * The `user-prompt-submit` sweep captions history images at turn start, but it
 * only fires on the main-turn orchestrator path. Background wakes (memory
 * retrospective forks, memory consolidation) enter `AgentLoop.run` directly
 * and never dispatch that hook, so media-bearing history would otherwise reach
 * the provider verbatim. This hook runs at the shared invocation boundary,
 * once per provider call on every path, against the outbound (sanitized) wire
 * payload in `ctx.messages`:
 *
 * - No image blocks outbound, or the resolved model supports vision
 *   ({@link needsImageFallback} via the live per-call profile override or the
 *   run's `modelProfileKey`): no-op.
 * - Images + non-vision model + a vision-capable profile available: replace
 *   the images with text captions via the plugin's shared outbound sweep
 *   ({@link captionOutboundImagesInMessages}). The caption cache makes the
 *   pass lookup-only for anything the turn-start sweep already captioned, so
 *   keeping both hooks is cheap.
 * - Images + non-vision model + NO vision profile: for the background memory
 *   call sites (`memoryRetrospective`, `memoryV2Consolidation`) fail the call
 *   closed (`decision: "fail"`) so the run surfaces a retryable failure
 *   instead of silently sending a request the provider will reject; a failed
 *   retrospective wake leaves the memory cursor untouched, so the work is
 *   retried once a capable route exists. Every other call site falls through
 *   unchanged, preserving the reactive `post-model-call` recovery and its
 *   fail-open placeholder behavior for user-facing turns.
 *
 * Every non-trivial decision emits a structured log line with the call site,
 * resolved profile/model, media count, and decision.
 */

import {
  type HookFunction,
  type LLMCallSite,
  type PreModelCallContext,
} from "@vellumai/plugin-api";

import {
  captionOutboundImagesInMessages,
  countImageBlocksInMessages,
  needsImageFallback,
} from "../src/caption-blocks.js";
import { findVisionProfile } from "../src/vision-caption.js";

/**
 * Background memory call sites whose callers own failure handling and retry:
 * a failed run is re-attempted later, so failing closed loses no work, while
 * silently sending media to a non-vision route would either reject the run
 * with an opaque provider error or degrade extraction quality invisibly.
 */
const FAIL_CLOSED_MEMORY_CALL_SITES: ReadonlySet<LLMCallSite> = new Set([
  "memoryRetrospective",
  "memoryV2Consolidation",
]);

const preModelCall: HookFunction<PreModelCallContext> = async (ctx) => {
  const mediaBlocks = countImageBlocksInMessages(ctx.messages);
  if (mediaBlocks === 0) {
    return;
  }

  // The live per-call override (which an earlier hook, e.g. a model router,
  // may have set) wins over the run-level identity resolved at turn start.
  const modelKey = ctx.modelProfile ?? ctx.modelProfileKey;
  if (modelKey == null) {
    // Raw loop runs (no call site, no resolved identity) carry nothing to
    // judge capabilities against; leave the request untouched.
    return;
  }

  if (!needsImageFallback(modelKey)) {
    ctx.logger.debug(
      {
        plugin: "image-fallback",
        callSite: ctx.callSite,
        modelProfileKey: modelKey,
        mediaBlocks,
        decision: "pass",
      },
      "Outbound media bound for a vision-capable model; sending untouched",
    );
    return;
  }

  const visionProfileKey = findVisionProfile();
  if (visionProfileKey != null) {
    const captioned = await captionOutboundImagesInMessages(
      ctx.messages,
      ctx.conversationId,
      visionProfileKey,
      ctx.logger,
    );
    ctx.logger.info(
      {
        plugin: "image-fallback",
        callSite: ctx.callSite,
        modelProfileKey: modelKey,
        mediaBlocks,
        captioned,
        decision: "captioned",
      },
      "Replaced outbound image blocks with text captions for text-only model",
    );
    return;
  }

  if (ctx.callSite != null && FAIL_CLOSED_MEMORY_CALL_SITES.has(ctx.callSite)) {
    ctx.decision = "fail";
    ctx.failureReason =
      `Model call for background call site "${ctx.callSite}" carries ` +
      `${mediaBlocks} image block(s), but its resolved model ` +
      `("${modelKey}") does not support image input and no vision-capable ` +
      `profile is configured to caption them. Configure a vision-capable ` +
      `model profile, or route the "${ctx.callSite}" call site to a ` +
      `vision-capable model; the run will be retried.`;
    ctx.logger.error(
      {
        plugin: "image-fallback",
        callSite: ctx.callSite,
        modelProfileKey: modelKey,
        mediaBlocks,
        decision: "fail_closed",
      },
      "Failing background memory model call closed: outbound media, non-vision model, and no vision profile to caption with",
    );
    return;
  }

  // No vision profile and not a fail-closed call site: fall through with the
  // request untouched. The turn-start sweep has already placeholdered what it
  // saw, and the reactive post-model-call recovery handles a provider
  // rejection of anything that leaked past it.
  ctx.logger.warn(
    {
      plugin: "image-fallback",
      callSite: ctx.callSite,
      modelProfileKey: modelKey,
      mediaBlocks,
      decision: "pass",
    },
    "Outbound media bound for a text-only model with no vision profile; leaving it to reactive recovery",
  );
};

export default preModelCall;
