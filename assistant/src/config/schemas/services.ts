import { z } from "zod";

import { SttServiceSchema } from "./stt.js";
import { TtsServiceSchema } from "./tts.js";

export const ServiceModeSchema = z.enum(["managed", "your-own"]);
export type ServiceMode = z.infer<typeof ServiceModeSchema>;

export const VALID_INFERENCE_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "fireworks",
  "openrouter",
] as const;

export const VALID_IMAGE_GEN_PROVIDERS = ["gemini", "openai"] as const;

export const VALID_WEB_SEARCH_PROVIDERS = [
  "perplexity",
  "brave",
  "inference-provider-native",
] as const;

export const BaseServiceSchema = z.object({
  mode: ServiceModeSchema.default("your-own"),
});
export type BaseService = z.infer<typeof BaseServiceSchema>;

/**
 * Inference service entry. Carries only the routing `mode`
 * (`managed` vs `your-own`) — the provider and model live under
 * `llm.default.{provider, model}` (see `schemas/llm.ts`). PR 19 of the
 * unify-llm-callsites plan removed the `provider` and `model` fields here;
 * legacy configs that still carry them have those keys stripped by
 * workspace migration `039-drop-legacy-llm-keys`.
 */
export const InferenceServiceSchema = BaseServiceSchema;
export type InferenceService = z.infer<typeof InferenceServiceSchema>;

export const ImageGenerationServiceSchema = BaseServiceSchema.extend({
  provider: z.enum(VALID_IMAGE_GEN_PROVIDERS).default("gemini"),
  model: z.string().default("gemini-3.1-flash-image-preview"),
});
export type ImageGenerationService = z.infer<
  typeof ImageGenerationServiceSchema
>;

export const WebSearchServiceSchema = BaseServiceSchema.extend({
  provider: z
    .enum(VALID_WEB_SEARCH_PROVIDERS)
    .default("inference-provider-native"),
});
export type WebSearchService = z.infer<typeof WebSearchServiceSchema>;

export const GoogleOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});
export type GoogleOAuthService = z.infer<typeof GoogleOAuthServiceSchema>;

export const OutlookOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});
export type OutlookOAuthService = z.infer<typeof OutlookOAuthServiceSchema>;

export const LinearOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});
export type LinearOAuthService = z.infer<typeof LinearOAuthServiceSchema>;

export const GitHubOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});
export type GitHubOAuthService = z.infer<typeof GitHubOAuthServiceSchema>;

export const NotionOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});
export type NotionOAuthService = z.infer<typeof NotionOAuthServiceSchema>;

export const TwitterOAuthServiceSchema = BaseServiceSchema.extend({
  mode: ServiceModeSchema.default("your-own"),
});
export type TwitterOAuthService = z.infer<typeof TwitterOAuthServiceSchema>;

/**
 * `services.meet.host.*` — daemon-side knobs for the externalized meet-join
 * skill process. Kept narrow: only the values the daemon reads before the
 * meet-host child is spawned live here. Skill-internal configuration
 * (avatar renderer, consent copy, proactive-chat keywords, etc.) lives in
 * `skills/meet-join/config-schema.ts` and is sourced from the separate
 * `<workspace>/config/meet.json` file the skill owns.
 *
 * `lazy_external` gates the manifest-driven lazy-spawn path. The default
 * is `true`: the daemon reads the shipped meet-join manifest at startup
 * and spawns the meet-host child via `bun run` on first tool/route use.
 * Setting `false` keeps the in-process `register(host)` path that
 * `external-skills-bootstrap.ts` runs as an opt-out — useful for local
 * iteration when the manifest or shipped skill source is stale.
 */
export const MeetHostConfigSchema = z
  .object({
    lazy_external: z
      .boolean({
        error: "services.meet.host.lazy_external must be a boolean",
      })
      .default(true)
      .describe(
        "When true, the daemon installs meet-join tools from the shipped manifest and spawns the meet-host child on first use instead of loading the skill in-process.",
      ),
    idle_timeout_ms: z
      .number({
        error: "services.meet.host.idle_timeout_ms must be a number",
      })
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Idle window in milliseconds after the last active meet session closes before the meet-host child is shut down. Defaults to 5 minutes when unset.",
      ),
  })
  .describe("Daemon-side configuration for the external meet-join skill host");
export type MeetHostConfig = z.infer<typeof MeetHostConfigSchema>;

/**
 * Daemon-side `services.meet` block. Intentionally distinct from the
 * skill-internal `MeetServiceSchema` in `skills/meet-join/config-schema.ts`,
 * which validates the bot-facing `<workspace>/config/meet.json` file. This
 * schema only describes the keys the assistant itself reads from its global
 * `config.json` before the meet-host child process is spawned.
 */
export const MeetDaemonServiceSchema = z
  .object({
    host: MeetHostConfigSchema.default(MeetHostConfigSchema.parse({})),
  })
  .describe("meet-join skill daemon-side configuration");
export type MeetDaemonService = z.infer<typeof MeetDaemonServiceSchema>;

export const ServicesSchema = z.object({
  inference: InferenceServiceSchema.default(InferenceServiceSchema.parse({})),
  "image-generation": ImageGenerationServiceSchema.default(
    ImageGenerationServiceSchema.parse({}),
  ),
  "web-search": WebSearchServiceSchema.default(
    WebSearchServiceSchema.parse({}),
  ),
  stt: SttServiceSchema.default({
    mode: "your-own" as const,
    provider: "deepgram" as const,
    providers: {},
  }),
  tts: TtsServiceSchema.default(TtsServiceSchema.parse({})),
  "google-oauth": GoogleOAuthServiceSchema.default(
    GoogleOAuthServiceSchema.parse({}),
  ),
  "outlook-oauth": OutlookOAuthServiceSchema.default(
    OutlookOAuthServiceSchema.parse({}),
  ),
  "linear-oauth": LinearOAuthServiceSchema.default(
    LinearOAuthServiceSchema.parse({}),
  ),
  "github-oauth": GitHubOAuthServiceSchema.default(
    GitHubOAuthServiceSchema.parse({}),
  ),
  "notion-oauth": NotionOAuthServiceSchema.default(
    NotionOAuthServiceSchema.parse({}),
  ),
  "twitter-oauth": TwitterOAuthServiceSchema.default(
    TwitterOAuthServiceSchema.parse({}),
  ),
  meet: MeetDaemonServiceSchema.default(MeetDaemonServiceSchema.parse({})),
});
export type Services = z.infer<typeof ServicesSchema>;

/**
 * Safely read the `mode` of a `services.*` entry.
 *
 * Most service entries (OAuth providers, inference, etc.) extend
 * `BaseServiceSchema` and therefore carry a `mode: "managed" | "your-own"`
 * field.
 *
 * Returns `undefined` when the requested service entry has no `mode` field,
 * so callers can treat those entries as implicitly "your-own" without the
 * compiler tripping on a union widened by non-BaseService members.
 */
export function getServiceMode(
  services: Services,
  key: keyof Services,
): ServiceMode | undefined {
  const entry = services[key] as { mode?: ServiceMode };
  return entry.mode;
}
