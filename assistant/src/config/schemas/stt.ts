import { z } from "zod";

/**
 * Valid STT provider identifiers. New providers append here and register
 * an adapter.
 */
export const VALID_STT_PROVIDERS = [
  "deepgram",
  "google-gemini",
  "openai-whisper",
  "xai",
  "vellum",
] as const;

/**
 * Forgiving aliases normalized to a canonical provider id before the enum
 * check, so a natural value like `openai` or `whisper` is accepted rather than
 * silently reset (which cascades into a full `services` section reset).
 */
const STT_PROVIDER_ALIASES: Record<
  string,
  (typeof VALID_STT_PROVIDERS)[number]
> = {
  openai: "openai-whisper",
  whisper: "openai-whisper",
};

/**
 * Sparse provider config map under `services.stt.providers`.
 *
 * This is a forward-compatible record that accepts any provider ID as key
 * with an object value. All provider entries — known (`openai-whisper`,
 * `deepgram`, `google-gemini`) and unknown — are accepted with generic object
 * validation. Adding a new provider ID does not require a migration to seed
 * `services.stt.providers.<id>`.
 *
 * The map only holds entries the user has explicitly configured — it is
 * NOT required to enumerate every known provider.
 */
export const SttProvidersSchema = z.record(
  z.string(),
  z.record(z.string(), z.unknown()).default({}),
);
export type SttProviders = z.infer<typeof SttProvidersSchema>;

/**
 * Canonical STT service configuration.
 *
 * `provider` is the only axis: `"vellum"` transcribes through the platform,
 * billed to Vellum credits; any other provider uses the user's own API key.
 */
export const SttServiceSchema = z
  .object({
    provider: z
      .preprocess(
        (v) => {
          if (typeof v !== "string") {
            return v;
          }
          const k = v.trim().toLowerCase();
          return STT_PROVIDER_ALIASES[k] ?? k;
        },
        z.enum(VALID_STT_PROVIDERS, {
          error: `services.stt.provider must be one of: ${VALID_STT_PROVIDERS.join(", ")} (aliases: openai/whisper -> openai-whisper)`,
        }),
      )
      .describe("Active STT provider used for speech-to-text transcription"),
    providers: SttProvidersSchema.default({}),
  })
  .describe(
    "Speech-to-text service configuration -- provider selection and per-provider settings",
  );

export type SttService = z.infer<typeof SttServiceSchema>;
