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
    /**
     * Spoken-language selection, forwarded to providers whose adapters accept
     * a language (Deepgram, xAI, and the managed relay).
     *
     * `"multi"` selects Deepgram's nova-3 code-switching mode, which follows
     * a speaker moving between languages inside a single utterance (e.g.
     * Hinglish). Providers that auto-detect natively and take no language
     * option (Gemini, Whisper) ignore this field.
     *
     * Left unset, the resolver fills in the provider's default rather than
     * sending nothing: `"multi"` on Deepgram and the managed relay, where
     * sending nothing would mean English rather than detection, and nothing
     * at all on providers that detect natively. See `effectiveSttLanguage` in
     * `providers/speech-to-text/resolve.ts`. Unset is kept meaningful here on
     * purpose: it records that the user has not chosen, which is what lets
     * the settings surfaces label a row "default".
     */
    language: z
      .string({ error: "services.stt.language must be a string" })
      .trim()
      .min(1, { error: "services.stt.language must not be empty" })
      .optional()
      .describe(
        "BCP-47 language code (e.g. 'en-US', 'hi') or 'multi' for code-switching across languages. Unset resolves to 'multi' on Deepgram/managed and to native auto-detection elsewhere",
      ),
    providers: SttProvidersSchema.default({}),
  })
  .describe(
    "Speech-to-text service configuration -- provider selection, spoken language, and per-provider settings",
  );

export type SttService = z.infer<typeof SttServiceSchema>;
