/**
 * Shared call TTS provider resolution.
 *
 * Both the call controller (LLM turn speech) and deterministic system
 * prompts (verification codes, guardian wait updates, timeout copy) use
 * this helper so that provider selection, format fallback, and the
 * native-vs-synthesized strategy decision stay in one implementation.
 */

import { loadConfig } from "../config/loader.js";
import {
  getCatalogProvider,
  getTtsProvider,
  listCatalogProviderIds,
} from "../tts/provider-catalog.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";
import type { TtsProvider, TtsProviderId } from "../tts/types.js";
import { getLogger } from "../util/logger.js";
import {
  evaluateTelephonyTtsPlayability,
  fishAudioReferenceIdConfigured,
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
   * store. False when `callMode` is `"native-twilio"` -- text is sent
   * via `sendTextToken()`, which the media-stream transport re-synthesizes
   * through daemon TTS. (Collapsing the callMode split is a documented
   * deferred follow-up.)
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
   *
   * Also gates the media-stream playability guard: a configured provider
   * that cannot produce playable PCM/WAV audio (or lacks credentials) is
   * swapped for a playable fallback provider instead of resolving into a
   * provider whose only possible media-stream outcome is silence.
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
 * `callMode: "native-twilio"` send text via `sendTextToken`, which the
 * media-stream transport re-synthesizes through daemon TTS.
 *
 * For WAV-requiring transports (`preferWav`, i.e. media-stream), the
 * resolved provider is validated against the media-stream playability
 * capability (format + credentials); a not-playable provider is replaced
 * by {@link findPlayableTelephonyTtsFallback}.
 *
 * Falls back to the native path with `mp3` format when the config is
 * missing a `services.tts` block or the provider is not registered
 * (e.g. unit tests or early startup).
 */
export async function resolveCallTtsProvider(
  options?: ResolveCallTtsOptions,
): Promise<ResolvedCallTts> {
  try {
    const config = loadConfig();
    const resolved = resolveTtsConfig(config);

    // Use the catalog's callMode to decide the call path -- the same
    // decision path used by voice-quality.ts via resolveCallStrategy().
    const strategy = resolveCallStrategy(config);

    let providerId = resolved.provider;
    let useSynthesizedPath = strategy.callMode === "synthesized-play";

    // Preflight provider-specific config invariants that would otherwise
    // fail only at first synthesis call. Fish Audio requires a reference
    // ID when no per-request voiceId is supplied (the telephony default).
    const fishAudioUnusable =
      providerId === "fish-audio" && !fishAudioReferenceIdConfigured();

    if (options?.preferWav) {
      // Media-stream transport: every spoken turn is synthesized, so the
      // provider must produce playable PCM/WAV with resolvable credentials
      // and satisfied config invariants (the capability check covers the
      // fish-audio referenceId rule). Swap in a playable fallback rather
      // than resolving into a provider that can only be silent.
      const capability = await evaluateTelephonyTtsPlayability(providerId);
      if (capability.status === "not-playable") {
        const reason = capability.reason;
        const fallbackId = await findPlayableTelephonyTtsFallback(providerId);
        if (fallbackId) {
          log.warn(
            { providerId, reason, fallbackProviderId: fallbackId },
            "Configured TTS provider is not playable on the media-stream transport; falling back",
          );
          providerId = fallbackId;
          useSynthesizedPath =
            getCatalogProvider(fallbackId).callMode === "synthesized-play";
        } else {
          log.warn(
            { providerId, reason },
            "Configured TTS provider is not playable on the media-stream transport and no playable fallback provider is available",
          );
        }
      }
    } else if (useSynthesizedPath && fishAudioUnusable) {
      // Non-WAV transport: degrade to the native token path rather than
      // letting the call stay silent.
      log.warn(
        { provider: providerId },
        "Synthesized call TTS disabled: fish-audio.referenceId is not configured; falling back to native token path",
      );
      return { provider: null, useSynthesizedPath: false, audioFormat: "mp3" };
    }

    const provider = getTtsProvider(providerId);

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

/**
 * Find a catalog provider that can produce playable media-stream audio
 * with resolvable credentials.
 *
 * Preference order: the ElevenLabs default first (when its key resolves),
 * then the remaining catalog providers in display order. The playability
 * capability already applies the fish-audio `referenceId` invariant, so a
 * referenceId-less fish-audio setup is never selected. Returns `null` when
 * no provider qualifies.
 */
export async function findPlayableTelephonyTtsFallback(
  excludeProviderId?: string,
): Promise<TtsProviderId | null> {
  const candidates = [
    ...new Set<TtsProviderId>(["elevenlabs", ...listCatalogProviderIds()]),
  ].filter((id) => id !== excludeProviderId);

  for (const candidateId of candidates) {
    const capability = await evaluateTelephonyTtsPlayability(candidateId);
    if (capability.status === "playable") {
      return candidateId;
    }
  }
  return null;
}
