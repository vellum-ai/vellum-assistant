import { loadConfig, loadRawConfig, getNestedValue } from '../config/loader.js';

export interface VoiceQualityProfile {
  language: string;
  transcriptionProvider: string;
  ttsProvider: string;
  voice: string;
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
  if (!voiceId) return '';

  const voiceModelId = config.voiceModelId?.trim();
  if (!voiceModelId) return voiceId;

  const speed = config.speed ?? 1.0;
  const stability = config.stability ?? 0.5;
  const similarityBoost = config.similarityBoost ?? 0.75;
  return `${voiceId}-${voiceModelId}-${speed}_${stability}_${similarityBoost}`;
}

/**
 * Merge legacy `calls.voice.elevenlabs.*` config values into the top-level
 * `elevenlabs` config as fallbacks. Previous versions stored tuning parameters
 * under the nested path; this ensures those values are preserved on upgrade.
 */
function mergeWithLegacyElevenLabsConfig(elevenlabs: ReturnType<typeof loadConfig>['elevenlabs']): typeof elevenlabs {
  const raw = loadRawConfig();
  const legacyPrefix = 'calls.voice.elevenlabs';

  const fields = ['voiceModelId', 'speed', 'stability', 'similarityBoost'] as const;
  const topLevel = (raw.elevenlabs && typeof raw.elevenlabs === 'object') ? raw.elevenlabs as Record<string, unknown> : {};

  const merged = { ...elevenlabs };
  for (const field of fields) {
    // Only fall back to legacy if the top-level config doesn't explicitly set this field
    if (topLevel[field] === undefined) {
      const legacyValue = getNestedValue(raw, `${legacyPrefix}.${field}`);
      if (legacyValue !== undefined) {
        (merged as Record<string, unknown>)[field] = legacyValue;
      }
    }
  }

  return merged;
}

/**
 * Resolve the effective voice quality profile from config.
 *
 * Always uses ElevenLabs TTS via Twilio ConversationRelay.
 * The voice ID comes from the shared `elevenlabs.voiceId` config
 * (defaults to Rachel — 21m00Tcm4TlvDq8ikWAM).
 */
export function resolveVoiceQualityProfile(config?: ReturnType<typeof loadConfig>): VoiceQualityProfile {
  const cfg = config ?? loadConfig();
  const voice = cfg.calls.voice;
  const elevenlabs = mergeWithLegacyElevenLabsConfig(cfg.elevenlabs);

  return {
    language: voice.language,
    transcriptionProvider: voice.transcriptionProvider,
    ttsProvider: 'ElevenLabs',
    voice: buildElevenLabsVoiceSpec(elevenlabs),
  };
}
