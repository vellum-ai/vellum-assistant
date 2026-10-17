/**
 * Request payload marks for retained media: tool-result documents and the
 * user's attachments.
 *
 * Providers reject a request outright once its inline media crosses their
 * payload limits, so the outbound sanitizer (`context/outbound-sanitize.ts`)
 * holds the media a request carries under these marks. The pair of marks is a
 * hysteresis band: nothing is evicted until the total crosses `high`, and once
 * eviction starts it continues down to `low`. Any eviction rewrites an old
 * message and so invalidates the prompt cache from that message on; the band
 * makes that a rare event instead of one per request once a conversation sits
 * at the limit.
 *
 * One band serves every provider. The transport a call actually goes to is
 * chosen inside the provider layer (`CallSiteRoutingProvider.sendMessage`),
 * after the sanitizer has run, and the pre-model-call hook can still change
 * the profile in between, so the sanitizer cannot know the transport. It
 * therefore uses the tightest documented limits among the providers the
 * daemon routes to:
 * - Gemini: 20 MB total inline request size (prompt, system, and inline
 *   files); see `gemini/inline-media.ts`. OpenAI-compatible endpoints vary by
 *   vendor and are treated the same way (see `openai/input-audio.ts`).
 *   Anthropic allows 32 MB.
 * - Anthropic: 100 images per request on 200k-context models (600 on larger
 *   windows); Gemini allows far more. Above 20 images Anthropic applies a
 *   stricter per-image dimension cap, which read-time scaling
 *   (`agent/image-optimize.ts`) already satisfies. The count marks leave 40
 *   slots under the 100 for the current step's frames, which the running
 *   total leaves out for the same stability reason as their bytes (below);
 *   a step is one assistant message's tool calls, so that covers many
 *   parallel screenshots.
 *   https://platform.claude.com/docs/en/build-with-claude/vision#request-limits
 *
 * The byte marks leave room under the 20 MB total for what the cap does not
 * count:
 * - the current step's frame media (a screenshot the model needs for its next
 *   action). It is left out of the running total so eviction decisions never
 *   depend on which step is current, which changes every send; one read-time
 *   optimized image is at most about 4.7 MB as base64
 *   (`agent/image-optimize.ts`), so that much is reserved for it;
 * - the request's text and tool definitions, a few MB at most.
 * A step that returns several large frames at once, or a single message whose
 * own attachments outweigh the band (the cap never evicts the turn in
 * progress), can still exceed the total; the reactive overflow path
 * (`plugins/defaults/compaction/context-overflow-reducer.ts`) is the backstop
 * for those cases.
 *
 * Per-image limits are enforced when the media is read, so only the aggregate
 * is governed here.
 *
 * An installation that knows its transport can raise the byte marks through
 * `media.payloadCap` in the workspace config ({@link mediaPayloadLimitsFromConfig}).
 */

import type { MediaConfig } from "../config/schemas/media.js";

export interface MediaPayloadLimits {
  /** Wire bytes (base64) of media above which eviction starts. */
  highBytes: number;
  /** Wire bytes eviction continues down to once it has started. */
  lowBytes: number;
  /** Image count above which eviction starts. */
  highImages: number;
  /** Image count eviction continues down to once it has started. */
  lowImages: number;
}

const MB = 1024 * 1024;

export const MEDIA_PAYLOAD_LIMITS: MediaPayloadLimits = {
  highBytes: 10 * MB,
  lowBytes: 6 * MB,
  highImages: 60,
  lowImages: 40,
};

/**
 * The marks in force: the shipped band, with the byte marks replaced by the
 * workspace's `media.payloadCap` when one is set. The image-count marks are
 * not configurable; bytes bind long before counts do for any real image.
 */
export function mediaPayloadLimitsFromConfig(
  media: MediaConfig | undefined,
): MediaPayloadLimits {
  const cap = media?.payloadCap;
  if (!cap) {
    return MEDIA_PAYLOAD_LIMITS;
  }
  return {
    ...MEDIA_PAYLOAD_LIMITS,
    highBytes: Math.round(cap.highMb * MB),
    lowBytes: Math.round(cap.lowMb * MB),
  };
}
