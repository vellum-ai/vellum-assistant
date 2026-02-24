import { z } from 'zod';

const VALID_CALL_PROVIDERS = ['twilio'] as const;
const VALID_CALL_VOICE_MODES = ['twilio_standard', 'twilio_elevenlabs_tts', 'elevenlabs_agent'] as const;
export const VALID_CALLER_IDENTITY_MODES = ['assistant_number', 'user_number'] as const;
const VALID_CALL_TRANSCRIPTION_PROVIDERS = ['Deepgram', 'Google'] as const;

export const CallsDisclosureConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'calls.disclosure.enabled must be a boolean' })
    .default(true),
  text: z
    .string({ error: 'calls.disclosure.text must be a string' })
    .default('At the very beginning of the call, introduce yourself as an assistant calling on behalf of the person you represent. Do not say "AI assistant".'),
});

export const CallsSafetyConfigSchema = z.object({
  denyCategories: z
    .array(z.string({ error: 'calls.safety.denyCategories values must be strings' }))
    .default([]),
});

export const CallsElevenLabsConfigSchema = z.object({
  voiceId: z
    .string({ error: 'calls.voice.elevenlabs.voiceId must be a string' })
    .default(''),
  voiceModelId: z
    .string({ error: 'calls.voice.elevenlabs.voiceModelId must be a string' })
    .default(''),
  speed: z
    .number({ error: 'calls.voice.elevenlabs.speed must be a number' })
    .min(0.7, 'calls.voice.elevenlabs.speed must be >= 0.7')
    .max(1.2, 'calls.voice.elevenlabs.speed must be <= 1.2')
    .default(1.0),
  stability: z
    .number({ error: 'calls.voice.elevenlabs.stability must be a number' })
    .min(0, 'calls.voice.elevenlabs.stability must be >= 0')
    .max(1, 'calls.voice.elevenlabs.stability must be <= 1')
    .default(0.5),
  similarityBoost: z
    .number({ error: 'calls.voice.elevenlabs.similarityBoost must be a number' })
    .min(0, 'calls.voice.elevenlabs.similarityBoost must be >= 0')
    .max(1, 'calls.voice.elevenlabs.similarityBoost must be <= 1')
    .default(0.75),
  useSpeakerBoost: z
    .boolean({ error: 'calls.voice.elevenlabs.useSpeakerBoost must be a boolean' })
    .default(true),
  agentId: z
    .string({ error: 'calls.voice.elevenlabs.agentId must be a string' })
    .default(''),
  apiBaseUrl: z
    .string({ error: 'calls.voice.elevenlabs.apiBaseUrl must be a string' })
    .default('https://api.elevenlabs.io'),
  registerCallTimeoutMs: z
    .number({ error: 'calls.voice.elevenlabs.registerCallTimeoutMs must be a number' })
    .int('calls.voice.elevenlabs.registerCallTimeoutMs must be an integer')
    .min(1000, 'calls.voice.elevenlabs.registerCallTimeoutMs must be >= 1000')
    .max(15000, 'calls.voice.elevenlabs.registerCallTimeoutMs must be <= 15000')
    .default(5000),
});

export const CallsVoiceConfigSchema = z.object({
  mode: z
    .enum(VALID_CALL_VOICE_MODES, {
      error: `calls.voice.mode must be one of: ${VALID_CALL_VOICE_MODES.join(', ')}`,
    })
    .default('twilio_standard'),
  language: z
    .string({ error: 'calls.voice.language must be a string' })
    .default('en-US'),
  transcriptionProvider: z
    .enum(VALID_CALL_TRANSCRIPTION_PROVIDERS, {
      error: `calls.voice.transcriptionProvider must be one of: ${VALID_CALL_TRANSCRIPTION_PROVIDERS.join(', ')}`,
    })
    .default('Deepgram'),
  fallbackToStandardOnError: z
    .boolean({ error: 'calls.voice.fallbackToStandardOnError must be a boolean' })
    .default(true),
  elevenlabs: CallsElevenLabsConfigSchema.default({
    voiceId: '',
    voiceModelId: '',
    speed: 1.0,
    stability: 0.5,
    similarityBoost: 0.75,
    useSpeakerBoost: true,
    agentId: '',
    apiBaseUrl: 'https://api.elevenlabs.io',
    registerCallTimeoutMs: 5000,
  }),
});

export const CallerIdentityConfigSchema = z.object({
  allowPerCallOverride: z
    .boolean({ error: 'calls.callerIdentity.allowPerCallOverride must be a boolean' })
    .default(true),
  userNumber: z
    .string({ error: 'calls.callerIdentity.userNumber must be a string' })
    .optional(),
});

export const CallsVerificationConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'calls.verification.enabled must be a boolean' })
    .default(false),
  maxAttempts: z
    .number({ error: 'calls.verification.maxAttempts must be a number' })
    .int('calls.verification.maxAttempts must be an integer')
    .positive('calls.verification.maxAttempts must be a positive integer')
    .default(3),
  codeLength: z
    .number({ error: 'calls.verification.codeLength must be a number' })
    .int('calls.verification.codeLength must be an integer')
    .positive('calls.verification.codeLength must be a positive integer')
    .default(6),
});

export const CallsConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'calls.enabled must be a boolean' })
    .default(true),
  provider: z
    .enum(VALID_CALL_PROVIDERS, {
      error: `calls.provider must be one of: ${VALID_CALL_PROVIDERS.join(', ')}`,
    })
    .default('twilio'),
  maxDurationSeconds: z
    .number({ error: 'calls.maxDurationSeconds must be a number' })
    .int('calls.maxDurationSeconds must be an integer')
    .positive('calls.maxDurationSeconds must be a positive integer')
    .max(2_147_483, 'calls.maxDurationSeconds must be at most 2147483 (setTimeout-safe limit)')
    .default(3600),
  userConsultTimeoutSeconds: z
    .number({ error: 'calls.userConsultTimeoutSeconds must be a number' })
    .int('calls.userConsultTimeoutSeconds must be an integer')
    .positive('calls.userConsultTimeoutSeconds must be a positive integer')
    .max(2_147_483, 'calls.userConsultTimeoutSeconds must be at most 2147483 (setTimeout-safe limit)')
    .default(120),
  disclosure: CallsDisclosureConfigSchema.default({
    enabled: true,
    text: 'At the very beginning of the call, introduce yourself as an assistant calling on behalf of the person you represent. Do not say "AI assistant".',
  }),
  safety: CallsSafetyConfigSchema.default({
    denyCategories: [],
  }),
  voice: CallsVoiceConfigSchema.default({
    mode: 'twilio_standard',
    language: 'en-US',
    transcriptionProvider: 'Deepgram',
    fallbackToStandardOnError: true,
    elevenlabs: {
      voiceId: '',
      voiceModelId: '',
      speed: 1.0,
      stability: 0.5,
      similarityBoost: 0.75,
      useSpeakerBoost: true,
      agentId: '',
      apiBaseUrl: 'https://api.elevenlabs.io',
      registerCallTimeoutMs: 5000,
    },
  }),
  model: z
    .string({ error: 'calls.model must be a string' })
    .optional(),
  callerIdentity: CallerIdentityConfigSchema.default({
    allowPerCallOverride: true,
  }),
  verification: CallsVerificationConfigSchema.default({
    enabled: false,
    maxAttempts: 3,
    codeLength: 6,
  }),
});

export type CallsConfig = z.infer<typeof CallsConfigSchema>;
export type CallsDisclosureConfig = z.infer<typeof CallsDisclosureConfigSchema>;
export type CallsSafetyConfig = z.infer<typeof CallsSafetyConfigSchema>;
export type CallsVoiceConfig = z.infer<typeof CallsVoiceConfigSchema>;
export type CallsElevenLabsConfig = z.infer<typeof CallsElevenLabsConfigSchema>;
export type CallerIdentityConfig = z.infer<typeof CallerIdentityConfigSchema>;
export type CallsVerificationConfig = z.infer<typeof CallsVerificationConfigSchema>;
