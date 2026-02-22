import { loadConfig } from '../config/loader.js';

export interface VoiceQualityProfile {
  mode: 'twilio_standard' | 'twilio_elevenlabs_tts' | 'elevenlabs_agent';
  language: string;
  transcriptionProvider: string;
  ttsProvider: string;
  voice: string;
  agentId?: string;
  fallbackToStandardOnError: boolean;
  validationErrors: string[];
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
 * Resolve the effective voice quality profile from config.
 * Returns a profile with all resolved values ready for use by TwiML generation
 * and call orchestration.
 */
export function resolveVoiceQualityProfile(config?: ReturnType<typeof loadConfig>): VoiceQualityProfile {
  const cfg = config ?? loadConfig();
  const voice = cfg.calls.voice;
  const errors: string[] = [];

  // Default/standard profile
  const standardProfile: VoiceQualityProfile = {
    mode: 'twilio_standard',
    language: voice.language,
    transcriptionProvider: voice.transcriptionProvider,
    ttsProvider: 'Google',
    voice: 'Google.en-US-Journey-O',
    fallbackToStandardOnError: voice.fallbackToStandardOnError,
    validationErrors: [],
  };

  if (voice.mode === 'twilio_standard') {
    return standardProfile;
  }

  if (voice.mode === 'twilio_elevenlabs_tts') {
    if (!voice.elevenlabs.voiceId && !voice.fallbackToStandardOnError) {
      errors.push('calls.voice.elevenlabs.voiceId is required for twilio_elevenlabs_tts mode when fallback is disabled');
    }
    if (!voice.elevenlabs.voiceId && voice.fallbackToStandardOnError) {
      return { ...standardProfile, validationErrors: ['calls.voice.elevenlabs.voiceId is empty; falling back to twilio_standard'] };
    }
    return {
      mode: 'twilio_elevenlabs_tts',
      language: voice.language,
      transcriptionProvider: voice.transcriptionProvider,
      ttsProvider: 'ElevenLabs',
      voice: buildElevenLabsVoiceSpec(voice.elevenlabs),
      fallbackToStandardOnError: voice.fallbackToStandardOnError,
      validationErrors: errors,
    };
  }

  if (voice.mode === 'elevenlabs_agent') {
    if (!voice.elevenlabs.agentId && !voice.fallbackToStandardOnError) {
      errors.push('calls.voice.elevenlabs.agentId is required for elevenlabs_agent mode when fallback is disabled');
    }
    if (!voice.elevenlabs.agentId && voice.fallbackToStandardOnError) {
      return { ...standardProfile, validationErrors: ['calls.voice.elevenlabs.agentId is empty; falling back to twilio_standard'] };
    }
    return {
      mode: 'elevenlabs_agent',
      language: voice.language,
      transcriptionProvider: voice.transcriptionProvider,
      ttsProvider: 'ElevenLabs',
      voice: buildElevenLabsVoiceSpec(voice.elevenlabs),
      agentId: voice.elevenlabs.agentId,
      fallbackToStandardOnError: voice.fallbackToStandardOnError,
      validationErrors: errors,
    };
  }

  return standardProfile;
}

/** Returns false when the profile has any validation errors. */
export function isVoiceProfileValid(profile: VoiceQualityProfile): boolean {
  return profile.validationErrors.length === 0;
}
