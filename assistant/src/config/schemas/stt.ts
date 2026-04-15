import { z } from "zod";

/**
 * Valid STT provider identifiers. New providers append here and register
 * an adapter.
 */
export const VALID_STT_PROVIDERS = [
  "deepgram",
  "google-gemini",
  "openai-whisper",
] as const;

/**
 * Deepgram-specific provider options under
 * `services.stt.providers.deepgram`.
 *
 * Kept as a standalone schema (rather than inlining into the generic
 * `SttProvidersSchema` record) so known Deepgram fields carry types and
 * defaults, while still round-tripping cleanly through the forward-compatible
 * parent record.
 */
export const DeepgramProviderConfigSchema = z
  .object({
    // Enables Deepgram's built-in speaker diarization. Adds no measurable
    // latency; slight cost implications in some tiers.
    diarize: z.boolean().default(false),
  })
  .describe(
    "Deepgram-specific provider options under services.stt.providers.deepgram",
  );
export type DeepgramProviderConfig = z.infer<
  typeof DeepgramProviderConfigSchema
>;

/**
 * Sparse provider config map under `services.stt.providers`.
 *
 * This is a forward-compatible record that accepts any provider ID as key
 * with an object value. All provider entries — known (`openai-whisper`,
 * `deepgram`, `google-gemini`) and unknown — are accepted with generic object validation.
 * Adding a new provider ID does not require a migration to seed
 * `services.stt.providers.<id>`.
 *
 * The map only holds entries the user has explicitly configured — it is
 * NOT required to enumerate every known provider. Typed validation for
 * known providers (e.g. {@link DeepgramProviderConfigSchema}) lives on
 * those schemas and is applied at the call site — this record is only
 * responsible for accepting the sparse shape.
 */
export const SttProvidersSchema = z.record(
  z.string(),
  z.record(z.string(), z.unknown()).default({}),
);
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
      .describe("Active STT provider used for speech-to-text transcription"),
    providers: SttProvidersSchema.default({}),
  })
  .describe(
    "Speech-to-text service configuration -- provider selection and per-provider settings",
  );

export type SttService = z.infer<typeof SttServiceSchema>;
