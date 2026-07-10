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
 * `mode` selects between the user's own provider key (`"your-own"`) and
 * Vellum-managed transcription billed to Vellum credits (`"managed"`).
 * The `provider` field always holds the user's BYOK choice so switching
 * back from managed mode restores it; use {@link effectiveSttProvider}
 * to resolve which provider is actually active.
 */
export const SttServiceSchema = z
  .object({
    mode: z
      .enum(["your-own", "managed"], {
        error: 'services.stt.mode must be "your-own" or "managed"',
      })
      .default("your-own" as const)
      .describe(
        'STT service mode -- "your-own" uses the configured provider with your API key; "managed" transcribes through your Vellum account',
      ),
    provider: z
      .enum(VALID_STT_PROVIDERS, {
        error: `services.stt.provider must be one of: ${VALID_STT_PROVIDERS.join(", ")}`,
      })
      .describe("Active STT provider used for speech-to-text transcription"),
    providers: SttProvidersSchema.default({}),
  })
  .superRefine((service, ctx) => {
    if (service.provider === "vellum" && service.mode !== "managed") {
      ctx.addIssue({
        code: "custom",
        path: ["provider"],
        message:
          'services.stt.provider "vellum" requires services.stt.mode "managed"',
      });
    }
  })
  .describe(
    "Speech-to-text service configuration -- provider selection and per-provider settings",
  );

export type SttService = z.infer<typeof SttServiceSchema>;

/**
 * Resolve the provider that is actually active for the service config.
 *
 * Managed mode always routes to the `vellum` provider while leaving the
 * user's BYOK `provider` choice untouched, so toggling back to
 * `"your-own"` restores their previous setup.
 */
export function effectiveSttProvider(service: {
  mode: SttService["mode"];
  provider: string;
}): string {
  return service.mode === "managed" ? "vellum" : service.provider;
}
