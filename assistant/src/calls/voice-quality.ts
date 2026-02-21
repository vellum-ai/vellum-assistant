import { loadConfig } from '../config/loader.js';

export interface VoiceQualityProfile {
  mode: 'twilio_standard' | 'twilio_elevenlabs_tts' | 'elevenlabs_agent';
  language: string;
  transcriptionProvider: string;
  ttsProvider: string;
  voice: string;
  fallbackToStandardOnError: boolean;
  validationErrors: string[];
}

/**
 * Build a Twilio-compatible ElevenLabs voice string.
 * Format: voiceId or voiceId-modelId-stability_similarity_style
 */
export function buildElevenLabsVoiceSpec(config: {
  voiceId: string;
  voiceModelId: string;
  stability: number;
  similarityBoost: number;
  style: number;
}): string {
  if (!config.voiceId) return '';
  return `${config.voiceId}-${config.voiceModelId}-${config.stability}_${config.similarityBoost}_${config.style}`;
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
      fallbackToStandardOnError: voice.fallbackToStandardOnError,
      validationErrors: errors,
    };
  }

  return standardProfile;
}
