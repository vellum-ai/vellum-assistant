import { loadConfig } from "../config/loader.js";
import { resolveTelephonySttProfile } from "./stt-profile.js";

export interface VoiceQualityProfile {
  language: string;
  transcriptionProvider: string;
  speechModel?: string;
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
 * STT provider and speech model selection is delegated to the telephony
 * STT profile adapter (`stt-profile.ts`), which centralizes all
 * provider-specific fallback logic.
 *
 * Supports ElevenLabs (default) and Fish Audio TTS providers.
 * When Fish Audio is selected, `ttsProvider` is set to `"Google"` as a
 * placeholder — ConversationRelay requires a valid provider in TwiML, but
 * actual audio is delivered via `play` messages from the call-controller.
 * The voice string is left empty since it is unused in that mode.
 *
 * For ElevenLabs, the voice ID comes from the shared `elevenlabs.voiceId`
 * config (defaults to Amelia — ZF6FPAbjXT4488VcRRnw).
 */
export function resolveVoiceQualityProfile(
  config?: ReturnType<typeof loadConfig>,
): VoiceQualityProfile {
  const cfg = config ?? loadConfig();
  const voice = cfg.calls.voice;
  const configuredTts = voice.ttsProvider ?? "elevenlabs";
  const fishAudio = configuredTts === "fish-audio";
  const sttProfile = resolveTelephonySttProfile(voice);
  return {
    language: voice.language,
    transcriptionProvider: sttProfile.provider,
    speechModel: sttProfile.speechModel,
    ttsProvider: fishAudio ? "Google" : "ElevenLabs",
    voice: fishAudio ? "" : buildElevenLabsVoiceSpec(cfg.elevenlabs),
    interruptSensitivity: voice.interruptSensitivity ?? "low",
    hints: voice.hints ?? [],
  };
}

/**
 * Check whether Fish Audio TTS is configured for phone calls.
 */
export function isFishAudioTts(
  config?: ReturnType<typeof loadConfig>,
): boolean {
  const cfg = config ?? loadConfig();
  return cfg.calls.voice?.ttsProvider === "fish-audio";
}
