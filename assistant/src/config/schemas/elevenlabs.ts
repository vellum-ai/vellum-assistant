import { z } from "zod";

// Default ElevenLabs voice — "Amelia" (expressive, enthusiastic, British English).
// Used by both in-app TTS and phone calls (via Twilio ConversationRelay).
// Mirrored in: clients/macos/.../OpenAIVoiceService.swift (defaultVoiceId)
export const DEFAULT_ELEVENLABS_VOICE_ID = "ZF6FPAbjXT4488VcRRnw";

export const ElevenLabsConfigSchema = z.object({
  voiceId: z
    .string({ error: "elevenlabs.voiceId must be a string" })
    .min(1, "elevenlabs.voiceId must not be empty")
    .default(DEFAULT_ELEVENLABS_VOICE_ID),
  voiceModelId: z
    .string({ error: "elevenlabs.voiceModelId must be a string" })
    .default(""),
  speed: z
    .number({ error: "elevenlabs.speed must be a number" })
    .min(0.7, "elevenlabs.speed must be >= 0.7")
    .max(1.2, "elevenlabs.speed must be <= 1.2")
    .default(1.0),
  stability: z
    .number({ error: "elevenlabs.stability must be a number" })
    .min(0, "elevenlabs.stability must be >= 0")
    .max(1, "elevenlabs.stability must be <= 1")
    .default(0.5),
  similarityBoost: z
    .number({ error: "elevenlabs.similarityBoost must be a number" })
    .min(0, "elevenlabs.similarityBoost must be >= 0")
    .max(1, "elevenlabs.similarityBoost must be <= 1")
    .default(0.75),
});

export type ElevenLabsConfig = z.infer<typeof ElevenLabsConfigSchema>;
