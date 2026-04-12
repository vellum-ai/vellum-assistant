import { z } from "zod";

/**
 * Valid STT provider identifiers. New providers append here and register
 * an adapter.
 */
export const VALID_STT_PROVIDERS = ["openai-whisper", "deepgram"] as const;

/**
 * Per-provider config schemas nested under `services.stt.providers.<id>`.
 *
 * Each provider's schema is the full provider-specific config (tuning
 * params, etc.). New providers add sibling schemas without restructuring.
 *
 * The provider config is an empty object. Per-provider tuning params
 * (e.g., model, language) can be added here once the provider adapter
 * consumes them at runtime.
 */
export const SttOpenAiWhisperProviderConfigSchema = z
  .object({})
  .describe("OpenAI Whisper provider configuration under services.stt");

export type SttOpenAiWhisperProviderConfig = z.infer<
  typeof SttOpenAiWhisperProviderConfigSchema
>;

/**
 * Deepgram provider configuration under `services.stt.providers.deepgram`.
 *
 * Provider-specific tuning params (model, language, smart formatting)
 * can be added here as the adapter evolves. For now the schema is empty
 * so that adding the provider to config.json is friction-free.
 */
export const SttDeepgramProviderConfigSchema = z
  .object({})
  .describe("Deepgram provider configuration under services.stt");

export type SttDeepgramProviderConfig = z.infer<
  typeof SttDeepgramProviderConfigSchema
>;

export const SttProvidersSchema = z.object({
  "openai-whisper": SttOpenAiWhisperProviderConfigSchema.default(
    SttOpenAiWhisperProviderConfigSchema.parse({}),
  ),
  deepgram: SttDeepgramProviderConfigSchema.default(
    SttDeepgramProviderConfigSchema.parse({}),
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
