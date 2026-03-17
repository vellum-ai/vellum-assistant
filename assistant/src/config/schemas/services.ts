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

export const InferenceServiceSchema = z.object({
  mode: ServiceModeSchema.default("your-own"),
  provider: z.enum(VALID_INFERENCE_PROVIDERS).default("anthropic"),
  model: z.string().default("claude-opus-4-6"),
});
export type InferenceService = z.infer<typeof InferenceServiceSchema>;

export const ImageGenerationServiceSchema = z.object({
  mode: ServiceModeSchema.default("your-own"),
  provider: z.enum(VALID_IMAGE_GEN_PROVIDERS).default("gemini"),
  model: z.string().default("gemini-3.1-flash-image-preview"),
});
export type ImageGenerationService = z.infer<
  typeof ImageGenerationServiceSchema
>;

export const WebSearchServiceSchema = z.object({
  mode: ServiceModeSchema.default("your-own"),
  provider: z
    .enum(VALID_WEB_SEARCH_PROVIDERS)
    .default("inference-provider-native"),
});
export type WebSearchService = z.infer<typeof WebSearchServiceSchema>;

export const ServicesSchema = z.object({
  inference: InferenceServiceSchema.default(InferenceServiceSchema.parse({})),
  "image-generation": ImageGenerationServiceSchema.default(
    ImageGenerationServiceSchema.parse({}),
  ),
  "web-search": WebSearchServiceSchema.default(
    WebSearchServiceSchema.parse({}),
  ),
});
export type Services = z.infer<typeof ServicesSchema>;
