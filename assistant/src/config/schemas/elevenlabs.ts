import { z } from "zod";

// Default ElevenLabs voice — "Amelia" (expressive, enthusiastic, British English).
// Used by both in-app TTS and phone calls (via Twilio ConversationRelay).
// Mirrored in: clients/macos/.../OpenAIVoiceService.swift (defaultVoiceId)
export const DEFAULT_ELEVENLABS_VOICE_ID = "ZF6FPAbjXT4488VcRRnw";

export const ElevenLabsConfigSchema = z
  .object({
    voiceId: z
      .string({ error: "elevenlabs.voiceId must be a string" })
      .min(1, "elevenlabs.voiceId must not be empty")
      .default(DEFAULT_ELEVENLABS_VOICE_ID)
      .describe("ElevenLabs voice ID for text-to-speech"),
    voiceModelId: z
      .string({ error: "elevenlabs.voiceModelId must be a string" })
      .default("")
      .describe(
        "ElevenLabs model ID override (leave empty to use the default model)",
      ),
    speed: z
      .number({ error: "elevenlabs.speed must be a number" })
      .min(0.7, "elevenlabs.speed must be >= 0.7")
      .max(1.2, "elevenlabs.speed must be <= 1.2")
      .default(1.0)
      .describe(
        "Speech playback speed multiplier (0.7 = slower, 1.2 = faster)",
      ),
    stability: z
      .number({ error: "elevenlabs.stability must be a number" })
      .min(0, "elevenlabs.stability must be >= 0")
      .max(1, "elevenlabs.stability must be <= 1")
      .default(0.5)
      .describe(
        "Voice stability — higher values produce more consistent speech, lower values add expressiveness",
      ),
    similarityBoost: z
      .number({ error: "elevenlabs.similarityBoost must be a number" })
      .min(0, "elevenlabs.similarityBoost must be >= 0")
      .max(1, "elevenlabs.similarityBoost must be <= 1")
      .default(0.75)
      .describe(
        "How closely the output matches the original voice — higher values increase similarity",
      ),
    conversationTimeoutSeconds: z
      .number({
        error: "elevenlabs.conversationTimeoutSeconds must be a number",
      })
      .refine((v) => [5, 10, 15, 30, 60].includes(v), {
        message:
          "elevenlabs.conversationTimeoutSeconds must be one of: 5, 10, 15, 30, 60",
      })
      .default(30)
      .describe("Seconds of silence before voice conversation auto-ends"),
  })
  .describe("ElevenLabs text-to-speech configuration");

export type ElevenLabsConfig = z.infer<typeof ElevenLabsConfigSchema>;
