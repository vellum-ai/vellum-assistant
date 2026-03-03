import { z } from 'zod';

// Default ElevenLabs voice — "Rachel" (calm, warm, conversational).
// Used by both in-app TTS and phone calls (via Twilio ConversationRelay).
// Mirrored in: clients/macos/.../OpenAIVoiceService.swift (defaultVoiceId)
export const DEFAULT_ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

export const ElevenLabsConfigSchema = z.object({
  voiceId: z
    .string({ error: 'elevenlabs.voiceId must be a string' })
    .default(DEFAULT_ELEVENLABS_VOICE_ID),
});

export type ElevenLabsConfig = z.infer<typeof ElevenLabsConfigSchema>;
