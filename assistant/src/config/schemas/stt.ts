import { z } from "zod";

import { listProviderModelFamilies } from "../../providers/speech-to-text/provider-catalog.js";
import type { SttProviderId } from "../../stt/types.js";

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
export const SttProvidersSchema = z
  .record(z.string(), z.record(z.string(), z.unknown()).default({}))
  .check((ctx) => {
    // `model` is only meaningful for providers the catalog knows, and the map
    // is deliberately open to ids it does not: entries for future providers
    // must keep round-tripping untouched. So validate the key where it means
    // something and leave the rest alone.
    for (const [providerId, settings] of Object.entries(ctx.value)) {
      const model = settings?.model;
      if (model === undefined) {
        continue;
      }
      const families = listProviderModelFamilies(providerId as SttProviderId);
      if (families.length === 0) {
        continue;
      }
      if (typeof model !== "string" || !families.includes(model as never)) {
        ctx.issues.push({
          code: "custom",
          path: [providerId, "model"],
          message: `services.stt.providers.${providerId}.model must be one of: ${families.join(", ")}`,
          input: model,
        });
      }
    }
  });
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
     * Defaults to `"multi"` rather than staying unset, so there is no state
     * where the answer to "what language is this assistant listening for"
     * has to be inferred. Every config carries the answer, and the settings
     * surfaces render a real selection rather than a sentinel standing in
     * for one.
     *
     * The default applies on load, not just at creation, so an existing
     * config that never set a language materializes `"multi"` on its next
     * start. That changes no behavior: `effectiveSttLanguage` already
     * resolved unset to `"multi"` on Deepgram and the managed relay, and the
     * providers that detect natively ignore the field either way. It only
     * makes the value explicit. An assistant that has chosen a language
     * keeps it, since a default fills nothing that is already set.
     */
    language: z
      .string({ error: "services.stt.language must be a string" })
      .trim()
      .min(1, { error: "services.stt.language must not be empty" })
      .default("multi")
      .describe(
        "BCP-47 language code (e.g. 'en-US', 'hi') or 'multi' for code-switching across languages. Defaults to 'multi'; providers that detect natively ignore it",
      ),
    providers: SttProvidersSchema.default({}),
  })
  .describe(
    "Speech-to-text service configuration -- provider selection, spoken language, and per-provider settings",
  );

export type SttService = z.infer<typeof SttServiceSchema>;
