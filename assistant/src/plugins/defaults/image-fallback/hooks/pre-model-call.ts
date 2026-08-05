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
 *   call sites (`memoryRetrospective`, `memoryV2Consolidation`) substitute
 *   the fail-open text placeholders (deterministic preprocessing: the same
 *   stand-ins the reactive recovery produces, minus the wasted provider
 *   round-trip). The pass still runs, so a workspace whose only models are
 *   text-only keeps forming memories from the window's text; the trigger is
 *   deterministic, so failing the call instead would stall that
 *   conversation's memory cursor permanently. Every other call site falls
 *   through unchanged, preserving the reactive `post-model-call` recovery
 *   and its fail-open placeholder behavior for user-facing turns.
 *
 * The preventive check reads the profile override as settled at THIS hook's
 * position in the chain; a later user-land hook that reroutes the call to a
 * text-only profile bypasses it (default hooks dispatch before user hooks),
 * and the pipeline discards this hook's mutation entirely when it throws or
 * times out. Both escapes are closed by the loop's final send-boundary
 * enforcement (the host-side `context/outbound-media-guard.ts`, applied in
 * `agent/loop.ts`), which judges the settled chain's FINAL profile and
 * statically placeholders any media still bound for a text-only model. This
 * hook stays the quality pass (captions when a vision profile exists); the
 * boundary is the guarantee, and the reactive `post-model-call` recovery
 * remains the net for provider-side surprises.
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
 * Background memory call sites that get deterministic media preprocessing at
 * this boundary even when no vision profile exists: their runs enter
 * `AgentLoop.run` without the turn-start sweep, so this hook is the only
 * placeholder pass their outbound payload gets before the provider call.
 */
const BACKGROUND_MEMORY_CALL_SITES: ReadonlySet<LLMCallSite> = new Set([
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

  if (ctx.callSite != null && BACKGROUND_MEMORY_CALL_SITES.has(ctx.callSite)) {
    // No vision profile anywhere: substitute the fail-open placeholders (a
    // null vision profile makes the sweep emit its static stand-in text
    // instead of captions). The pass proceeds and still extracts the
    // window's text; failing the call here would be a deterministic
    // permanent stall for the conversation's memory cursor, since a retry
    // can never do better until the configuration itself changes.
    const placeholdered = await captionOutboundImagesInMessages(
      ctx.messages,
      ctx.conversationId,
      null,
      ctx.logger,
    );
    ctx.logger.warn(
      {
        plugin: "image-fallback",
        callSite: ctx.callSite,
        modelProfileKey: modelKey,
        mediaBlocks,
        placeholdered,
        decision: "placeholdered",
      },
      "Replaced outbound image blocks with static placeholders for background memory call: no vision-capable profile is configured to caption them",
    );
    return;
  }

  // No vision profile and not a background memory call site: fall through with the
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
