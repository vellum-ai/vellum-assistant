import { z } from "zod";

/**
 * Valid STT provider identifiers. New providers append here and register
 * an adapter.
 */
export const VALID_STT_PROVIDERS = ["openai-whisper"] as const;

/**
 * Per-provider config schemas nested under `services.stt.providers.<id>`.
 *
 * Each provider's schema is the full provider-specific config (model,
 * language, tuning params, etc.). New providers add sibling schemas
 * without restructuring.
 */
export const SttOpenAiWhisperProviderConfigSchema = z
  .object({
    model: z
      .string({
        error: "services.stt.providers.openai-whisper.model must be a string",
      })
      .default("whisper-1")
      .describe("OpenAI Whisper model ID for speech-to-text"),
    language: z
      .string({
        error:
          "services.stt.providers.openai-whisper.language must be a string",
      })
      .default("")
      .describe(
        "ISO-639-1 language hint for transcription (leave empty for auto-detect)",
      ),
  })
  .describe("OpenAI Whisper provider configuration under services.stt");

export type SttOpenAiWhisperProviderConfig = z.infer<
  typeof SttOpenAiWhisperProviderConfigSchema
>;

export const SttProvidersSchema = z.object({
  "openai-whisper": SttOpenAiWhisperProviderConfigSchema.default(
    SttOpenAiWhisperProviderConfigSchema.parse({}),
  ),
});
export type SttProviders = z.infer<typeof SttProvidersSchema>;

/**
 * Canonical STT service configuration.
 *
 * `mode` is locked to `"your-own"` -- managed STT is not supported.
 * Attempting to set `mode: "managed"` will fail schema validation.
 */
export const SttServiceSchema = z
  .object({
    mode: z
      .literal("your-own", {
        error:
          'services.stt.mode must be "your-own" -- managed STT is not supported',
      })
      .default("your-own" as const)
      .describe(
        'STT service mode -- only "your-own" is supported (managed STT is not available)',
      ),
    provider: z
      .enum(VALID_STT_PROVIDERS, {
        error: `services.stt.provider must be one of: ${VALID_STT_PROVIDERS.join(", ")}`,
      })
      .default("openai-whisper")
      .describe("Active STT provider used for speech-to-text transcription"),
    providers: SttProvidersSchema.default(SttProvidersSchema.parse({})),
  })
  .describe(
    "Speech-to-text service configuration -- provider selection and per-provider settings",
  );

export type SttService = z.infer<typeof SttServiceSchema>;
