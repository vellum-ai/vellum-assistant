/**
 * Shared call TTS provider resolution.
 *
 * Both the call controller (LLM turn speech) and deterministic system
 * prompts (verification codes, guardian wait updates, timeout copy) use
 * this helper so that provider selection, format fallback, and the
 * native-vs-synthesized strategy decision stay in one implementation.
 */

import { loadConfig } from "../config/loader.js";
import { getTtsProvider } from "../tts/provider-registry.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";
import type { TtsProvider } from "../tts/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedCallTts {
  /** The resolved TTS provider, or null when config/registry is unavailable. */
  provider: TtsProvider | null;

  /**
   * True when the provider supports streaming and audio should be
   * synthesized via the provider API and streamed through the audio store.
   * False when text tokens are sent directly to the relay for Twilio's
   * built-in TTS engine.
   */
  useSynthesizedPath: boolean;

  /** Audio format to use for synthesized audio. */
  audioFormat: "mp3" | "wav" | "opus";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the active TTS provider via the global provider abstraction.
 *
 * Providers that declare streaming support are treated as "synthesized"
 * providers -- their audio is streamed through the audio store and played
 * via `sendPlayUrl`. Providers without streaming support are "native"
 * providers -- text tokens are streamed directly to the relay for Twilio's
 * built-in TTS.
 *
 * Falls back to the native (non-streaming) path with `mp3` format when
 * the config is missing a `services.tts` block or the provider is not
 * registered (e.g. unit tests or early startup).
 */
export function resolveCallTtsProvider(): ResolvedCallTts {
  try {
    const config = loadConfig();
    const resolved = resolveTtsConfig(config);
    const provider = getTtsProvider(resolved.provider);

    // Providers with streaming support synthesize audio themselves; others
    // rely on the relay's native (Twilio-managed) TTS engine.
    const useSynthesizedPath = provider.capabilities.supportsStreaming;

    // Read the user-configured audio format from the resolved provider
    // config so the streaming store entry's content-type matches the
    // actual audio bytes the provider produces.
    const configuredFormat = (resolved.providerConfig as { format?: string })
      .format;
    const audioFormat = (
      configuredFormat && ["mp3", "wav", "opus"].includes(configuredFormat)
        ? configuredFormat
        : "mp3"
    ) as "mp3" | "wav" | "opus";

    return { provider, useSynthesizedPath, audioFormat };
  } catch {
    // Config missing `services.tts` block or provider not registered
    // (e.g. unit tests or early startup) -- fall back to the native
    // (non-streaming) path where the provider object is not used.
    return { provider: null, useSynthesizedPath: false, audioFormat: "mp3" };
  }
}
