/**
 * Explicit call-path strategy for TTS providers.
 *
 * Determines how a TTS provider integrates with the Twilio
 * ConversationRelay call path by reading the provider's `callMode` from
 * the canonical catalog rather than inferring behavior from runtime
 * capabilities like `supportsStreaming`.
 *
 * Two strategies exist:
 *
 * - **native-twilio** -- Twilio handles TTS natively via
 *   ConversationRelay. The profile needs a real `ttsProvider` name
 *   (e.g. `"ElevenLabs"`) and a provider-specific voice spec string.
 *   New native providers plug in by registering a
 *   {@link NativeTwilioVoiceSpecBuilder} -- no edits to the core call
 *   routing logic required.
 *
 * - **synthesized-play** -- The assistant synthesises audio and streams
 *   chunks to Twilio via `play` messages. The profile uses a
 *   placeholder TTS provider (`"Google"`) and an empty voice string
 *   because Twilio never drives TTS itself on this path.
 *
 * @module
 */

import type { AssistantConfig } from "../config/types.js";
import { getCatalogProvider } from "../tts/provider-catalog.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";
import type { TtsCallMode, TtsProviderId } from "../tts/types.js";

// ---------------------------------------------------------------------------
// Native Twilio voice-spec builder registry
// ---------------------------------------------------------------------------

/**
 * Builds the provider-specific voice spec string for a native Twilio
 * provider.
 *
 * The returned string is used as the `voice` attribute in the
 * ConversationRelay TwiML element. Its format is provider-specific --
 * e.g. ElevenLabs uses `voiceId-modelId-speed_stability_similarity`.
 *
 * @param providerConfig - Provider-specific config block from
 *   `services.tts.providers.<id>`.
 * @returns The voice spec string for the ConversationRelay `voice`
 *   attribute, or an empty string if the provider has no voice to
 *   specify.
 */
export type NativeTwilioVoiceSpecBuilder = (
  providerConfig: Record<string, unknown>,
) => string;

/**
 * Metadata returned by a native Twilio voice-spec builder registration.
 */
export interface NativeTwilioVoiceSpec {
  /** The Twilio `ttsProvider` attribute value (e.g. `"ElevenLabs"`). */
  readonly twilioProviderName: string;

  /** Builds the `voice` attribute string from provider config. */
  readonly buildVoiceSpec: NativeTwilioVoiceSpecBuilder;
}

/** Internal registry keyed by provider ID. */
const nativeVoiceSpecRegistry = new Map<TtsProviderId, NativeTwilioVoiceSpec>();

/**
 * Register a native Twilio voice-spec builder for a provider.
 *
 * Called at startup alongside provider adapter registration. This is
 * the extension point that allows new native Twilio providers to be
 * added without modifying core call routing logic.
 *
 * @throws if a builder for the same provider ID is already registered.
 */
export function registerNativeTwilioVoiceSpec(
  providerId: TtsProviderId,
  spec: NativeTwilioVoiceSpec,
): void {
  if (nativeVoiceSpecRegistry.has(providerId)) {
    throw new Error(
      `Native Twilio voice spec for "${providerId}" is already registered. ` +
        "Duplicate registrations are not allowed.",
    );
  }
  nativeVoiceSpecRegistry.set(providerId, spec);
}

/**
 * Look up a registered native Twilio voice-spec builder.
 *
 * @throws if no builder has been registered for the given provider.
 */
export function getNativeTwilioVoiceSpec(
  providerId: TtsProviderId,
): NativeTwilioVoiceSpec {
  const spec = nativeVoiceSpecRegistry.get(providerId);
  if (!spec) {
    const known = [...nativeVoiceSpecRegistry.keys()];
    const knownList =
      known.length > 0 ? ` Registered: ${known.join(", ")}` : "";
    throw new Error(
      `No native Twilio voice spec registered for "${providerId}".${knownList}`,
    );
  }
  return spec;
}

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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Clear all registered native Twilio voice spec builders.
 *
 * **Test-only** -- must not be called in production code.
 */
export function _resetNativeTwilioVoiceSpecRegistry(): void {
  nativeVoiceSpecRegistry.clear();
}
