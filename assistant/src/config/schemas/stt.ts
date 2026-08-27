import { z } from "zod";

import { listProviderModelFamilies } from "../../providers/speech-to-text/provider-catalog.js";
import {
  STT_ROLE_REQUIREMENTS,
  STT_ROLES,
  type SttRole,
  sttRoleCapabilityGap,
} from "../../stt/roles.js";
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
 * Per-consumer provider overrides: `services.stt.roles.<role>`.
 *
 * Sparse: an unset role falls back to `services.stt.provider`. Capability is
 * per boundary while the base setting is global, so a provider that is right
 * for live voice can be incapable of batch transcription. A role is how one
 * consumer says which provider and model family it needs without moving the
 * others onto it.
 *
 * Validation is fail-closed: a pair the provider cannot serve is rejected
 * here rather than at dial time. Accepting it and falling back at resolve
 * time is the silent substitution this config exists to make visible.
 */
export const SttRolesSchema = z
  .partialRecord(
    z.enum(STT_ROLES),
    z.object({
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
            error: `a services.stt.roles provider must be one of: ${VALID_STT_PROVIDERS.join(", ")}`,
          }),
        )
        .describe("Provider this consumer uses"),
      model: z
        .string({ error: "a services.stt.roles model must be a string" })
        .optional()
        .describe(
          "Model family this consumer uses. Omitted runs the provider's default family",
        ),
    }),
  )
  .check((ctx) => {
    for (const [role, selection] of Object.entries(ctx.value)) {
      if (selection === undefined) {
        continue;
      }
      const families = listProviderModelFamilies(
        selection.provider as SttProviderId,
      );
      if (
        selection.model !== undefined &&
        !families.includes(selection.model as never)
      ) {
        ctx.issues.push({
          code: "custom",
          path: [role, "model"],
          message:
            families.length === 0
              ? `services.stt.roles.${role}: ${selection.provider} offers a single model, so model cannot be set`
              : `services.stt.roles.${role}.model must be one of: ${families.join(", ")}`,
          input: selection.model,
        });
        continue;
      }
      const gap = sttRoleCapabilityGap(role as SttRole, selection);
      if (gap !== null) {
        ctx.issues.push({
          code: "custom",
          path: [role],
          message: `services.stt.roles.${role} cannot be ${describeSelection(selection)}: ${gap}`,
          input: selection,
        });
      }
    }
  })
  .describe(
    `Per-consumer STT provider overrides (${STT_ROLES.join(", ")}). An unset role uses services.stt.provider`,
  );

export type SttRoles = z.infer<typeof SttRolesSchema>;

/** How a role's selection reads in an error: "deepgram" or "deepgram/flux". */
function describeSelection(selection: {
  provider: string;
  model?: string | undefined;
}): string {
  return selection.model === undefined
    ? `"${selection.provider}"`
    : `"${selection.provider}" running ${selection.model}`;
}

/** Re-exported so config consumers need not reach into the stt module. */
export { STT_ROLE_REQUIREMENTS, STT_ROLES, type SttRole };

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
    roles: SttRolesSchema.default({}),
  })
  .describe(
    "Speech-to-text service configuration -- provider selection, spoken language, and per-provider settings",
  );

export type SttService = z.infer<typeof SttServiceSchema>;
