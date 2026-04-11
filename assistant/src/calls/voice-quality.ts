import { loadConfig } from "../config/loader.js";
import { getTtsProvider } from "../tts/provider-registry.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";

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
 * Uses the global TTS provider abstraction to determine which provider is
 * active. Providers that declare streaming support (e.g. Fish Audio) use
 * the synthesized-play path — ConversationRelay needs a valid TTS provider
 * in TwiML, so we set `ttsProvider` to `"Google"` as a placeholder and
 * leave `voice` empty since actual audio is delivered via `play` messages.
 *
 * For native providers (e.g. ElevenLabs), `ttsProvider` and `voice` are
 * populated from config so Twilio handles TTS natively.
 */
export function resolveVoiceQualityProfile(
  config?: ReturnType<typeof loadConfig>,
): VoiceQualityProfile {
  const cfg = config ?? loadConfig();
  const voice = cfg.calls.voice;

  // Resolve the active TTS provider through the global abstraction.
  const resolved = resolveTtsConfig(cfg);
  const provider = getTtsProvider(resolved.provider);
  const usesSynthesizedPath = provider.capabilities.supportsStreaming;

  const isGoogle = voice.transcriptionProvider === "Google";
  // Treat the legacy Deepgram default ("nova-3") as unset when provider is
  // Google — upgraded workspaces may still have it persisted from prior defaults.
  const effectiveSpeechModel =
    voice.speechModel == null || (voice.speechModel === "nova-3" && isGoogle)
      ? isGoogle
        ? undefined
        : "nova-3"
      : voice.speechModel;
  return {
    language: voice.language,
    transcriptionProvider: voice.transcriptionProvider,
    speechModel: effectiveSpeechModel,
    ttsProvider: usesSynthesizedPath ? "Google" : "ElevenLabs",
    voice: usesSynthesizedPath ? "" : buildElevenLabsVoiceSpec(cfg.elevenlabs),
    interruptSensitivity: voice.interruptSensitivity ?? "low",
    hints: voice.hints ?? [],
  };
}
