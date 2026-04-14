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
import { getLogger } from "../util/logger.js";
import { resolveCallStrategy } from "./tts-call-strategy.js";

const log = getLogger("resolve-call-tts-provider");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedCallTts {
  /** The resolved TTS provider, or null when config/registry is unavailable. */
  provider: TtsProvider | null;

  /**
   * True when the catalog's `callMode` is `"synthesized-play"` -- audio
   * is synthesized via the provider API and streamed through the audio
   * store. False when `callMode` is `"native-twilio"` -- text tokens are
   * sent directly to the relay for Twilio's built-in TTS engine.
   */
  useSynthesizedPath: boolean;

  /** Audio format to use for synthesized audio. */
  audioFormat: "mp3" | "wav" | "opus";
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ResolveCallTtsOptions {
  /**
   * When true, force `audioFormat` to `"wav"` regardless of the
   * provider's configured format. The media-stream transport sets this
   * because its {@link audioBufferToFrames} can only correctly
   * transcode WAV (PCM) to mu-law -- compressed formats (mp3, opus)
   * are sent as raw bytes and produce garbled audio.
   */
  preferWav?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the active TTS provider via the global provider abstraction.
 *
 * The native-vs-synthesized decision is driven by the catalog's
 * `callMode` field via {@link resolveCallStrategy} -- the same single
 * decision path used by `voice-quality.ts`. Providers with
 * `callMode: "synthesized-play"` have their audio streamed through the
 * audio store and played via `sendPlayUrl`. Providers with
 * `callMode: "native-twilio"` stream text tokens directly to the relay
 * for Twilio's built-in TTS.
 *
 * Falls back to the native path with `mp3` format when the config is
 * missing a `services.tts` block or the provider is not registered
 * (e.g. unit tests or early startup).
 */
export function resolveCallTtsProvider(
  options?: ResolveCallTtsOptions,
): ResolvedCallTts {
  try {
    const config = loadConfig();
    const resolved = resolveTtsConfig(config);
    const provider = getTtsProvider(resolved.provider);

    // Use the catalog's callMode to decide the call path -- the same
    // decision path used by voice-quality.ts via resolveCallStrategy().
    const strategy = resolveCallStrategy(config);
    const useSynthesizedPath = strategy.callMode === "synthesized-play";

    // For synthesized providers, preflight provider-specific config
    // invariants that would otherwise fail only at first synthesis call.
    // If required config is missing, degrade to the native token path
    // (Twilio TTS) rather than letting the call stay silent.
    //
    // Fish Audio requires a reference ID when no per-request voiceId is
    // supplied (which is the telephony default).
    if (useSynthesizedPath && resolved.provider === "fish-audio") {
      const referenceId = (resolved.providerConfig as { referenceId?: string })
        .referenceId;
      if (!referenceId?.trim()) {
        log.warn(
          { provider: resolved.provider },
          "Synthesized call TTS disabled: fish-audio.referenceId is not configured; falling back to native token path",
        );
        return {
          provider: null,
          useSynthesizedPath: false,
          audioFormat: "mp3",
        };
      }
    }

    // Read the user-configured audio format from the resolved provider
    // config so the streaming store entry's content-type matches the
    // actual audio bytes the provider produces.
    //
    // When preferWav is set (media-stream transport), force WAV so
    // audioBufferToFrames receives PCM it can transcode to mu-law.
    const audioFormat: "mp3" | "wav" | "opus" = options?.preferWav
      ? "wav"
      : (() => {
          const configuredFormat = (
            resolved.providerConfig as { format?: string }
          ).format;
          return (
            configuredFormat &&
            ["mp3", "wav", "opus"].includes(configuredFormat)
              ? configuredFormat
              : "mp3"
          ) as "mp3" | "wav" | "opus";
        })();

    return { provider, useSynthesizedPath, audioFormat };
  } catch {
    // Config missing `services.tts` block or provider not registered
    // (e.g. unit tests or early startup) -- fall back to the native
    // path where the provider object is not used.
    return { provider: null, useSynthesizedPath: false, audioFormat: "mp3" };
  }
}
