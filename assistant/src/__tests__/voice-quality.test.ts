import { describe, expect, mock,test } from 'bun:test';

let mockConfig: Record<string, unknown> = {};

mock.module('../config/loader.js', () => ({
  loadConfig: () => mockConfig,
}));

import { buildElevenLabsVoiceSpec, isVoiceProfileValid,resolveVoiceQualityProfile } from '../calls/voice-quality.js';

describe('buildElevenLabsVoiceSpec', () => {
  test('returns bare voiceId when no model is set', () => {
    expect(buildElevenLabsVoiceSpec({ voiceId: 'abc123' })).toBe('abc123');
  });

  test('returns empty string when voiceId is empty', () => {
    expect(buildElevenLabsVoiceSpec({ voiceId: '' })).toBe('');
  });

  test('returns empty string when voiceId is whitespace', () => {
    expect(buildElevenLabsVoiceSpec({ voiceId: '  ' })).toBe('');
  });

  test('returns bare voiceId when voiceModelId is empty', () => {
    expect(buildElevenLabsVoiceSpec({ voiceId: 'abc123', voiceModelId: '' })).toBe('abc123');
  });

  test('returns bare voiceId when voiceModelId is whitespace', () => {
    expect(buildElevenLabsVoiceSpec({ voiceId: 'abc123', voiceModelId: '  ' })).toBe('abc123');
  });

  test('appends model and defaults when voiceModelId is provided', () => {
    const result = buildElevenLabsVoiceSpec({ voiceId: 'abc123', voiceModelId: 'eleven_turbo_v2' });
    expect(result).toBe('abc123-eleven_turbo_v2-1_0.5_0.75');
  });

  test('uses custom speed, stability, and similarity values', () => {
    const result = buildElevenLabsVoiceSpec({
      voiceId: 'voice1',
      voiceModelId: 'model1',
      speed: 1.5,
      stability: 0.8,
      similarityBoost: 0.9,
    });
    expect(result).toBe('voice1-model1-1.5_0.8_0.9');
  });

  test('trims whitespace from voiceId', () => {
    expect(buildElevenLabsVoiceSpec({ voiceId: '  abc123  ' })).toBe('abc123');
  });
});

describe('resolveVoiceQualityProfile', () => {
  test('returns standard profile for twilio_standard mode', () => {
    mockConfig = {
      calls: {
        voice: {
          mode: 'twilio_standard',
          language: 'en-US',
          transcriptionProvider: 'Google',
          fallbackToStandardOnError: false,
          elevenlabs: {},
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.mode).toBe('twilio_standard');
    expect(profile.ttsProvider).toBe('Google');
    expect(profile.voice).toBe('Google.en-US-Journey-O');
    expect(profile.validationErrors).toHaveLength(0);
  });

  test('returns elevenlabs profile for twilio_elevenlabs_tts mode', () => {
    mockConfig = {
      calls: {
        voice: {
          mode: 'twilio_elevenlabs_tts',
          language: 'en-US',
          transcriptionProvider: 'Google',
          fallbackToStandardOnError: false,
          elevenlabs: { voiceId: 'elvoice1' },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.mode).toBe('twilio_elevenlabs_tts');
    expect(profile.ttsProvider).toBe('ElevenLabs');
    expect(profile.voice).toBe('elvoice1');
    expect(profile.validationErrors).toHaveLength(0);
  });

  test('falls back to standard when voiceId missing and fallback enabled', () => {
    mockConfig = {
      calls: {
        voice: {
          mode: 'twilio_elevenlabs_tts',
          language: 'en-US',
          transcriptionProvider: 'Google',
          fallbackToStandardOnError: true,
          elevenlabs: { voiceId: '' },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.mode).toBe('twilio_standard');
    expect(profile.validationErrors.length).toBeGreaterThan(0);
    expect(profile.validationErrors[0]).toContain('falling back');
  });

  test('returns validation error when voiceId missing and fallback disabled', () => {
    mockConfig = {
      calls: {
        voice: {
          mode: 'twilio_elevenlabs_tts',
          language: 'en-US',
          transcriptionProvider: 'Google',
          fallbackToStandardOnError: false,
          elevenlabs: { voiceId: '' },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.mode).toBe('twilio_elevenlabs_tts');
    expect(profile.validationErrors.length).toBeGreaterThan(0);
    expect(profile.validationErrors[0]).toContain('voiceId is required');
  });

  test('returns elevenlabs_agent profile with agentId', () => {
    mockConfig = {
      calls: {
        voice: {
          mode: 'elevenlabs_agent',
          language: 'en-US',
          transcriptionProvider: 'Google',
          fallbackToStandardOnError: false,
          elevenlabs: { voiceId: 'voice1', agentId: 'agent123' },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.mode).toBe('elevenlabs_agent');
    expect(profile.agentId).toBe('agent123');
    expect(profile.validationErrors).toHaveLength(0);
  });

  test('falls back to standard when agentId missing and fallback enabled', () => {
    mockConfig = {
      calls: {
        voice: {
          mode: 'elevenlabs_agent',
          language: 'en-US',
          transcriptionProvider: 'Google',
          fallbackToStandardOnError: true,
          elevenlabs: { voiceId: 'voice1', agentId: '' },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.mode).toBe('twilio_standard');
    expect(profile.validationErrors[0]).toContain('falling back');
  });

  test('returns validation error when agentId missing and fallback disabled', () => {
    mockConfig = {
      calls: {
        voice: {
          mode: 'elevenlabs_agent',
          language: 'en-US',
          transcriptionProvider: 'Google',
          fallbackToStandardOnError: false,
          elevenlabs: { voiceId: 'voice1', agentId: '' },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.mode).toBe('elevenlabs_agent');
    expect(profile.validationErrors.length).toBeGreaterThan(0);
    expect(profile.validationErrors[0]).toContain('agentId is required');
  });

  test('returns standard profile for unknown mode', () => {
    mockConfig = {
      calls: {
        voice: {
          mode: 'unknown_mode',
          language: 'en-US',
          transcriptionProvider: 'Google',
          fallbackToStandardOnError: false,
          elevenlabs: {},
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.mode).toBe('twilio_standard');
  });
});

describe('isVoiceProfileValid', () => {
  test('returns true for profile with no errors', () => {
    expect(isVoiceProfileValid({
      mode: 'twilio_standard',
      language: 'en-US',
      transcriptionProvider: 'Google',
      ttsProvider: 'Google',
      voice: 'Google.en-US-Journey-O',
      fallbackToStandardOnError: false,
      validationErrors: [],
    })).toBe(true);
  });

  test('returns false for profile with errors', () => {
    expect(isVoiceProfileValid({
      mode: 'twilio_elevenlabs_tts',
      language: 'en-US',
      transcriptionProvider: 'Google',
      ttsProvider: 'ElevenLabs',
      voice: '',
      fallbackToStandardOnError: false,
      validationErrors: ['voiceId is required'],
    })).toBe(false);
  });
});
