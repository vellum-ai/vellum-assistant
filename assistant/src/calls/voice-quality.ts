import { loadConfig } from "../config/loader.js";
import { DEFAULT_ELEVENLABS_VOICE_ID } from "../config/schemas/elevenlabs.js";
import { getTtsProvider } from "../tts/provider-registry.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";

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
 * Twilio ConversationRelay accepts:
 *   - bare voiceId
 *   - voiceId-model-speed_stability_similarity
 *
 * We default to bare voiceId unless a model is explicitly configured.
 * This avoids forcing model/tuning suffixes that may be rejected for some
 * voice + model combinations.
 *
 * See: https://www.twilio.com/docs/voice/conversationrelay/voice-configuration
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
 * Resolve the effective voice quality profile from config.
 *
 * Uses the global TTS provider abstraction to determine which provider is
 * active. Providers that declare streaming support (e.g. Fish Audio) use
 * the synthesized-play path — ConversationRelay needs a valid TTS provider
 * in TwiML, so we set `ttsProvider` to `"Google"` as a placeholder and
 * leave `voice` empty since actual audio is delivered via `play` messages.
 *
 * For native providers (e.g. ElevenLabs), `ttsProvider` and `voice` are
 * populated from config so Twilio handles TTS natively.
 *
 * NOTE: STT provider and speech model are intentionally NOT part of this
 * profile. STT resolution is handled once in the voice webhook route
 * (`twilio-routes.ts`) via `resolveTelephonySttProfile()` to maintain a
 * single point of ownership.
 */
export function resolveVoiceQualityProfile(
  config?: ReturnType<typeof loadConfig>,
): VoiceQualityProfile {
  const cfg = config ?? loadConfig();
  const voice = cfg.calls.voice;

  // Resolve the active TTS provider through the global abstraction.
  // When the config lacks the `services.tts` block (e.g. test mocks or
  // pre-migration configs) or the provider registry has not been initialised,
  // we fall back to the native ElevenLabs profile.
  let usesSynthesizedPath = false;
  try {
    const resolved = resolveTtsConfig(cfg);
    const provider = getTtsProvider(resolved.provider);
    usesSynthesizedPath = provider.capabilities.supportsStreaming;
  } catch {
    // Config or provider not available — default to native (ElevenLabs) path.
  }

  return {
    language: voice.language,
    ttsProvider: usesSynthesizedPath ? "Google" : "ElevenLabs",
    voice: usesSynthesizedPath
      ? ""
      : buildElevenLabsVoiceSpec(
          cfg.services?.tts?.providers?.elevenlabs ?? {
            voiceId: DEFAULT_ELEVENLABS_VOICE_ID,
          },
        ),
    interruptSensitivity: voice.interruptSensitivity ?? "low",
    hints: voice.hints ?? [],
  };
}
