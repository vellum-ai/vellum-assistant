import { loadConfig } from "../config/loader.js";
import { DEFAULT_ELEVENLABS_VOICE_ID } from "../config/schemas/elevenlabs.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";
import {
  getNativeTwilioVoiceSpec,
  resolveCallStrategy,
} from "./tts-call-strategy.js";

export interface VoiceQualityProfile {
  language: string;
  ttsProvider: string;
  voice: string;
  interruptSensitivity: string;
  hints: string[];
}

/**
 * Build a Twilio-compatible ElevenLabs voice string.
 *
 * Twilio's native TTS voice attribute accepts:
 *   - bare voiceId
 *   - voiceId-model-speed_stability_similarity
 *
 * We default to bare voiceId unless a model is explicitly configured.
 * This avoids forcing model/tuning suffixes that may be rejected for some
 * voice + model combinations.
 */
export function buildElevenLabsVoiceSpec(config: {
  voiceId: string;
  voiceModelId?: string;
  speed?: number;
  stability?: number;
  similarityBoost?: number;
}): string {
  const voiceId = config.voiceId?.trim();
  if (!voiceId) return "";

  const voiceModelId = config.voiceModelId?.trim();
  if (!voiceModelId) return voiceId;

  const speed = config.speed ?? 1.0;
  const stability = config.stability ?? 0.5;
  const similarityBoost = config.similarityBoost ?? 0.75;
  return `${voiceId}-${voiceModelId}-${speed}_${stability}_${similarityBoost}`;
}

/**
 * Resolve a valid native Twilio voice for the configured TTS provider.
 *
 * Returns the registered {@link NativeTwilioVoiceSpec} for `providerId` when one
 * exists; otherwise — no builder registered (e.g. a synthesized-play provider
 * like Fish Audio), or config unavailable — falls back to the ElevenLabs config
 * block, or the shipped default voice. The result is always a non-empty,
 * Twilio-valid `ttsProvider` + `voice`.
 */
function resolveNativeTwilioVoice(
  cfg: ReturnType<typeof loadConfig>,
  providerId: string,
): { ttsProvider: string; voice: string } {
  try {
    const spec = getNativeTwilioVoiceSpec(providerId);
    const resolved = resolveTtsConfig(cfg);
    return {
      ttsProvider: spec.twilioProviderName,
      voice: spec.buildVoiceSpec(resolved.providerConfig),
    };
  } catch {
    return {
      ttsProvider: "ElevenLabs",
      voice: buildElevenLabsVoiceSpec(
        cfg.services?.tts?.providers?.elevenlabs ?? {
          voiceId: DEFAULT_ELEVENLABS_VOICE_ID,
        },
      ),
    };
  }
}

/**
 * Resolve the effective voice quality profile from config.
 *
 * The profile always carries a valid, non-empty native Twilio voice:
 *
 * - **native-twilio** providers (e.g. ElevenLabs): the voice is built from
 *   the provider's registered {@link NativeTwilioVoiceSpec} builder.
 * - **synthesized-play** providers (e.g. Fish Audio): the daemon synthesizes
 *   audio itself, so the native voice is a fallback only — an empty voice
 *   makes Twilio reject a native-TTS turn with error 64106 ("TTS provider
 *   rejected the request due to invalid parameters") and drop the call.
 *   These providers have no registered native builder, so they resolve to
 *   the ElevenLabs fallback voice.
 *
 * NOTE: STT provider and speech model are intentionally NOT part of this
 * profile — the daemon owns STT on the media-stream transport (see
 * `resolveTelephonySttCapability` in providers/speech-to-text/resolve.ts).
 */
export function resolveVoiceQualityProfile(
  config?: ReturnType<typeof loadConfig>,
): VoiceQualityProfile {
  const cfg = config ?? loadConfig();
  const voice = cfg.calls.voice;

  // Resolve the call strategy from catalog metadata.
  // Falls back to native ElevenLabs when config/catalog is unavailable.
  const strategy = resolveCallStrategy(cfg);

  const { ttsProvider, voice: voiceSpec } = resolveNativeTwilioVoice(
    cfg,
    strategy.providerId,
  );

  return {
    language: voice.language,
    ttsProvider,
    voice: voiceSpec,
    interruptSensitivity: voice.interruptSensitivity ?? "low",
    hints: voice.hints ?? [],
  };
}
