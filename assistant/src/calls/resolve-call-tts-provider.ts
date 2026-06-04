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
import {
  DEFAULT_PLAYABLE_TTS_PROVIDER,
  resolveTelephonyTtsCapability,
  resolveTelephonyTtsCapabilityFor,
} from "./telephony-tts-capability.js";
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
 *
 * For the media-stream call path (where every byte is transcoded
 * PCM -> mu-law), use {@link resolvePlayableCallTtsProvider} instead --
 * it guarantees a provider that can emit playable audio.
 */
export function resolveCallTtsProvider(): ResolvedCallTts {
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
    const audioFormat: "mp3" | "wav" | "opus" = (() => {
      const configuredFormat = (resolved.providerConfig as { format?: string })
        .format;
      return (
        configuredFormat && ["mp3", "wav", "opus"].includes(configuredFormat)
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

// ---------------------------------------------------------------------------
// Media-stream playability guard
// ---------------------------------------------------------------------------

/**
 * A media-stream TTS provider guaranteed to emit transcodable audio.
 *
 * `provider` is `null` to signal **no playable provider** — neither the
 * configured provider nor the fallback default could synthesize transcodable,
 * credentialed audio (or the registry is unavailable). Callers MUST treat a
 * null provider as "do not attempt synthesized media-stream playback" and
 * degrade safely (native token path / end-of-turn signal) rather than dialing
 * into silence.
 */
export interface PlayableCallTts {
  /** The resolved, PCM/WAV-capable, credentialed provider, or `null`. */
  provider: TtsProvider | null;

  /** Audio format to request for synthesized audio (always `"wav"`). */
  audioFormat: "wav";
}

/**
 * Resolve a TTS provider for the **media-stream** call path, guaranteeing
 * that the returned provider can actually feed the PCM -> mu-law transcoder.
 *
 * On media-stream every byte of telephony audio is daemon-synthesized and
 * transcoded, so a provider that cannot emit PCM/WAV (or whose credential or
 * required config is missing) would produce a silent call. When the configured
 * provider is {@link resolveTelephonyTtsCapability not playable}, this falls
 * back to a known PCM-capable default ({@link DEFAULT_PLAYABLE_TTS_PROVIDER}) —
 * **but only after re-running the same playability check on that default**, so
 * an uncredentialed default is never silently returned.
 *
 * Returns `{ provider: null }` when neither the configured provider nor the
 * fallback default is playable (e.g. the default is also uncredentialed), or
 * when the registry/config is unavailable (tests / early startup). This is the
 * explicit "no playable provider" signal: callers (and the call preflight)
 * fail loudly / degrade safely rather than dialing into silence.
 */
export async function resolvePlayableCallTtsProvider(): Promise<PlayableCallTts> {
  try {
    const capability = await resolveTelephonyTtsCapability();

    if (capability.status === "playable") {
      return {
        provider: getTtsProvider(capability.providerId),
        audioFormat: "wav",
      };
    }

    // Configured provider cannot feed the media-stream transcoder. Before
    // falling back to the default, verify the default is ITSELF playable
    // (credentialed + required config present) so we never return an unusable
    // provider that would dial into silence.
    const fallbackCapability = await resolveTelephonyTtsCapabilityFor(
      DEFAULT_PLAYABLE_TTS_PROVIDER,
    );

    if (fallbackCapability.status !== "playable") {
      log.error(
        {
          configuredProvider: capability.providerId,
          configuredReason: capability.reason,
          fallbackProvider: DEFAULT_PLAYABLE_TTS_PROVIDER,
          fallbackReason: fallbackCapability.reason,
        },
        "No playable media-stream TTS provider — configured provider cannot " +
          "synthesize playable audio and the default fallback is also not " +
          "playable; degrading instead of returning a silent provider",
      );
      return { provider: null, audioFormat: "wav" };
    }

    log.warn(
      {
        configuredProvider: capability.providerId,
        reason: capability.reason,
        fallbackProvider: DEFAULT_PLAYABLE_TTS_PROVIDER,
      },
      "Configured media-stream TTS provider cannot synthesize playable audio — " +
        "falling back to a PCM-capable default",
    );
    return {
      provider: getTtsProvider(DEFAULT_PLAYABLE_TTS_PROVIDER),
      audioFormat: "wav",
    };
  } catch {
    // Config missing / provider not registered (e.g. tests, early startup).
    return { provider: null, audioFormat: "wav" };
  }
}
