/**
 * Request payload marks for retained tool-result media.
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
 *   (`agent/image-optimize.ts`) already satisfies.
 *   https://platform.claude.com/docs/en/build-with-claude/vision#request-limits
 *
 * Marks sit well inside those limits so the non-media part of the request
 * (text, tool definitions, the media the sanitizer never evicts) has room.
 * Per-image limits are enforced when the media is read, so only the aggregate
 * is governed here.
 */

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
  highBytes: 14 * MB,
  lowBytes: 9 * MB,
  highImages: 80,
  lowImages: 50,
};
