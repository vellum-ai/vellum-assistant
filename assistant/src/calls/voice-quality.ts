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
 * Uses the explicit call strategy from the TTS provider catalog to
 * determine the call path. The catalog's `callMode` field
 * (`"native-twilio"` vs `"synthesized-play"`) drives the decision
 * rather than inferring behavior from runtime `supportsStreaming`
 * capability.
 *
 * For **synthesized-play** providers (e.g. Fish Audio),
 * ConversationRelay needs a valid TTS provider in TwiML, so we set
 * `ttsProvider` to `"Google"` as a placeholder and leave `voice` empty
 * since actual audio is delivered via `play` messages.
 *
 * For **native-twilio** providers (e.g. ElevenLabs), `ttsProvider` and
 * `voice` are populated via the provider's registered
 * {@link NativeTwilioVoiceSpec} builder so Twilio handles TTS natively.
 * New native providers plug in by registering a voice-spec builder --
 * no edits to this module required.
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

  // Resolve the call strategy from catalog metadata.
  // Falls back to native ElevenLabs when config/catalog is unavailable.
  const strategy = resolveCallStrategy(cfg);

  let ttsProvider: string;
  let voiceSpec: string;

  if (strategy.callMode === "synthesized-play") {
    // Synthesized providers stream audio via `play` messages.
    // Twilio still needs a valid ttsProvider in TwiML, so use a
    // placeholder and leave voice empty.
    ttsProvider = "Google";
    voiceSpec = "";
  } else {
    // Native providers: delegate voice-spec building to the
    // provider's registered builder.
    try {
      const spec = getNativeTwilioVoiceSpec(strategy.providerId);
      ttsProvider = spec.twilioProviderName;

      const resolved = resolveTtsConfig(cfg);
      voiceSpec = spec.buildVoiceSpec(resolved.providerConfig);
    } catch {
      // Voice-spec builder not registered or config unavailable --
      // fall back to ElevenLabs using the config's elevenlabs block.
      ttsProvider = "ElevenLabs";
      voiceSpec = buildElevenLabsVoiceSpec(
        cfg.services?.tts?.providers?.elevenlabs ?? {
          voiceId: DEFAULT_ELEVENLABS_VOICE_ID,
        },
      );
    }
  }

  return {
    language: voice.language,
    ttsProvider,
    voice: voiceSpec,
    interruptSensitivity: voice.interruptSensitivity ?? "low",
    hints: voice.hints ?? [],
  };
}
