/**
 * Register built-in TTS providers at startup.
 *
 * Call {@link registerBuiltinTtsProviders} once during daemon initialization
 * to make all catalog-declared providers discoverable via the provider
 * registry. The function iterates {@link listCatalogProviderIds} and looks up
 * each ID in the {@link providerFactories} map — a missing factory entry
 * causes a clear startup-time error so that new catalog providers cannot be
 * added without also wiring an adapter factory.
 *
 * Also registers native Twilio voice-spec builders for providers whose
 * catalog `callMode` is `"native-twilio"`. These builders are consumed by
 * the call strategy abstraction in `tts-call-strategy.ts`.
 *
 * This module is the single entry point for built-in registration — new
 * providers should be added to the catalog and the factory map so they are
 * available from first request.
 */

import {
  _resetNativeTwilioVoiceSpecRegistry,
  type NativeTwilioVoiceSpec,
  registerNativeTwilioVoiceSpec,
} from "../../calls/tts-call-strategy.js";
import { buildElevenLabsVoiceSpec } from "../../calls/voice-quality.js";
import {
  getCatalogProvider,
  listCatalogProviderIds,
} from "../provider-catalog.js";
import { registerTtsProvider } from "../provider-registry.js";
import type { TtsProviderId } from "../types.js";
import { providerFactories } from "./index.js";

// ---------------------------------------------------------------------------
// Native Twilio voice-spec builders
// ---------------------------------------------------------------------------

/**
 * Maps provider IDs with `callMode: "native-twilio"` to their Twilio
 * voice-spec builder metadata.
 *
 * When onboarding a new native Twilio provider, add an entry here.
 * Synthesized-play providers do not need an entry — they use a
 * placeholder TTS provider and empty voice string.
 */
const nativeVoiceSpecs = new Map<TtsProviderId, NativeTwilioVoiceSpec>([
  [
    "elevenlabs",
    {
      twilioProviderName: "ElevenLabs",
      buildVoiceSpec: (providerConfig) =>
        buildElevenLabsVoiceSpec(
          providerConfig as {
            voiceId: string;
            voiceModelId?: string;
            speed?: number;
            stability?: number;
            similarityBoost?: number;
          },
        ),
    },
  ],
]);

let registered = false;

/**
 * Register all built-in TTS providers with the global registry.
 *
 * Iterates every provider ID declared in the canonical catalog and creates
 * an adapter via the corresponding factory in {@link providerFactories}.
 * For providers whose catalog `callMode` is `"native-twilio"`, also
 * registers the corresponding native Twilio voice-spec builder.
 *
 * Safe to call multiple times — subsequent calls are no-ops. This prevents
 * double-registration when the daemon restarts hot-module paths.
 *
 * @throws if any catalog provider ID has no corresponding adapter factory.
 * @throws if a native-twilio provider has no corresponding voice-spec entry.
 */
export function registerBuiltinTtsProviders(): void {
  if (registered) return;

  const catalogIds = listCatalogProviderIds();

  for (const id of catalogIds) {
    // Register the TTS provider adapter.
    const factory = providerFactories.get(id);
    if (!factory) {
      throw new Error(
        `TTS provider "${id}" is declared in the catalog but has no adapter factory. ` +
          `Add a factory entry for "${id}" in providers/index.ts.`,
      );
    }
    registerTtsProvider(factory());

    // Register the native Twilio voice-spec builder when applicable.
    const catalogEntry = getCatalogProvider(id);
    if (catalogEntry.callMode === "native-twilio") {
      const voiceSpec = nativeVoiceSpecs.get(id);
      if (!voiceSpec) {
        throw new Error(
          `TTS provider "${id}" has callMode "native-twilio" but no native ` +
            `voice-spec builder. Add an entry in register-builtins.ts nativeVoiceSpecs.`,
        );
      }
      registerNativeTwilioVoiceSpec(id, voiceSpec);
    }
  }

  registered = true;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Reset the registration guard so {@link registerBuiltinTtsProviders} can
 * re-register providers after a test clears the global registry.
 *
 * Also clears the native Twilio voice-spec registry to avoid
 * duplicate-registration errors on subsequent calls.
 *
 * **Test-only** — must not be called in production code.
 */
export function _resetBuiltinRegistration(): void {
  registered = false;
  _resetNativeTwilioVoiceSpecRegistry();
}
