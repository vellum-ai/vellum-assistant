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
