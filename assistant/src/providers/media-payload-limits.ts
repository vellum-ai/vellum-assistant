/**
 * Per-provider request payload marks for retained tool-result media.
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
 * Marks sit well inside each provider's documented limit so the non-media part
 * of the request (text, tool definitions, the media the sanitizer never
 * evicts) has room. Per-image limits are enforced when the media is read
 * (`agent/image-optimize.ts`), so only the aggregate is governed here.
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

// Anthropic: 32 MB request body; 100 images per request on 200k-context
// models (600 on larger windows). The count marks follow the tighter figure
// since the model's window is not known here. Above 20 images a stricter
// per-image dimension cap applies, which read-time scaling already satisfies.
// https://platform.claude.com/docs/en/build-with-claude/vision#request-limits
const ANTHROPIC_LIMITS: MediaPayloadLimits = {
  highBytes: 24 * MB,
  lowBytes: 16 * MB,
  highImages: 80,
  lowImages: 50,
};

// Gemini: 20 MB total inline request size (prompt, system, and inline files).
// See `gemini/inline-media.ts`.
const GEMINI_LIMITS: MediaPayloadLimits = {
  highBytes: 14 * MB,
  lowBytes: 9 * MB,
  highImages: 80,
  lowImages: 50,
};

/**
 * Marks for a provider whose limits are not tabulated (OpenAI-compatible
 * endpoints vary by vendor): the tightest known band.
 */
export const DEFAULT_MEDIA_PAYLOAD_LIMITS: MediaPayloadLimits = GEMINI_LIMITS;

/**
 * Payload marks for the transport provider a request goes to, by `Provider.name`.
 * Keyed by the transport provider rather than the token-estimation alias
 * because a proxied route is bound by the proxy's limits, not the upstream
 * model's.
 */
export function mediaPayloadLimitsFor(
  providerName: string | undefined,
): MediaPayloadLimits {
  switch (providerName) {
    case "anthropic": {
      return ANTHROPIC_LIMITS;
    }
    case "gemini": {
      return GEMINI_LIMITS;
    }
    default: {
      return DEFAULT_MEDIA_PAYLOAD_LIMITS;
    }
  }
}
