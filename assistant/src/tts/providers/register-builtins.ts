/**
 * Register built-in TTS providers at startup.
 *
 * Call {@link registerBuiltinTtsProviders} once during daemon initialization
 * to make `elevenlabs` and `fish-audio` discoverable via the provider registry.
 *
 * This module is the single entry point for built-in registration — new
 * providers should be added here so they are available from first request.
 */

import { registerTtsProvider } from "../provider-registry.js";
import { createElevenLabsProvider } from "./elevenlabs-provider.js";
import { createFishAudioProvider } from "./fish-audio-provider.js";

let registered = false;

/**
 * Register all built-in TTS providers with the global registry.
 *
 * Safe to call multiple times — subsequent calls are no-ops. This prevents
 * double-registration when the daemon restarts hot-module paths.
 */
export function registerBuiltinTtsProviders(): void {
  if (registered) return;

  registerTtsProvider(createElevenLabsProvider());
  registerTtsProvider(createFishAudioProvider());

  registered = true;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Reset the registration guard so {@link registerBuiltinTtsProviders} can
 * re-register providers after a test clears the global registry.
 *
 * **Test-only** — must not be called in production code.
 */
export function _resetBuiltinRegistration(): void {
  registered = false;
}
