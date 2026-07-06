/**
 * Explicit call-path strategy for TTS providers.
 *
 * Determines how a TTS provider integrates with the telephony call path
 * by reading the provider's `callMode` from the canonical catalog rather
 * than inferring behavior from runtime capabilities like
 * `supportsStreaming`.
 *
 * Two strategies exist:
 *
 * - **native-twilio** -- the text-token path: spoken text is sent via
 *   `sendTextToken()`, which the media-stream transport re-synthesizes
 *   through daemon TTS.
 *
 * - **synthesized-play** -- The assistant synthesises audio via the
 *   provider API and streams it through the audio store / `sendPlayUrl()`
 *   path.
 *
 * @module
 */

import type { AssistantConfig } from "../config/types.js";
import { getCatalogProvider } from "../tts/provider-catalog.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";
import type { TtsCallMode, TtsProviderId } from "../tts/types.js";

// ---------------------------------------------------------------------------
// Strategy resolution
// ---------------------------------------------------------------------------

/**
 * Resolved call strategy for the active TTS provider.
 */
export interface TtsCallStrategy {
  /** The provider ID from the catalog. */
  readonly providerId: TtsProviderId;

  /** How this provider integrates with the telephony call path. */
  readonly callMode: TtsCallMode;
}

/**
 * Resolve the call strategy for the currently configured TTS provider.
 *
 * Reads the active provider from config via {@link resolveTtsConfig},
 * then looks up the provider's `callMode` in the catalog.
 *
 * Falls back to `native-twilio` with `"elevenlabs"` when the config
 * or catalog is unavailable (e.g. test mocks, pre-migration configs).
 */
export function resolveCallStrategy(config: AssistantConfig): TtsCallStrategy {
  try {
    const resolved = resolveTtsConfig(config);
    const catalogEntry = getCatalogProvider(resolved.provider);
    return {
      providerId: catalogEntry.id,
      callMode: catalogEntry.callMode,
    };
  } catch {
    // Config or catalog not available -- default to native ElevenLabs path.
    return {
      providerId: "elevenlabs",
      callMode: "native-twilio",
    };
  }
}
