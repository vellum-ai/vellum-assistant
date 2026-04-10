import { z } from "zod";

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

export const InferenceServiceSchema = BaseServiceSchema.extend({
  provider: z.enum(VALID_INFERENCE_PROVIDERS).default("anthropic"),
  model: z.string().default("claude-opus-4-6"),
});
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

export const ServicesSchema = z.object({
  inference: InferenceServiceSchema.default(InferenceServiceSchema.parse({})),
  "image-generation": ImageGenerationServiceSchema.default(
    ImageGenerationServiceSchema.parse({}),
  ),
  "web-search": WebSearchServiceSchema.default(
    WebSearchServiceSchema.parse({}),
  ),
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
});
export type Services = z.infer<typeof ServicesSchema>;
