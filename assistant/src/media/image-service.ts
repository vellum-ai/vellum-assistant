import {
  generateImage as generateImageGemini,
  mapGeminiError,
} from "./gemini-image-service.js";
import { generateImageOpenAI, mapOpenAIError } from "./openai-image-service.js";
import type {
  ImageGenCredentials,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenProvider,
} from "./types.js";

/**
 * Dispatch image generation to the provider-specific implementation.
 */
export function generateImage(
  provider: ImageGenProvider,
  credentials: ImageGenCredentials,
  request: ImageGenerationRequest,
): Promise<ImageGenerationResult> {
  switch (provider) {
    case "openai":
      return generateImageOpenAI(credentials, request);
    case "gemini":
      return generateImageGemini(credentials, request);
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown image generation provider: ${_exhaustive}`);
    }
  }
}

/**
 * Dispatch error mapping to the provider-specific implementation.
 */
export function mapImageGenError(
  provider: ImageGenProvider,
  error: unknown,
): string {
  switch (provider) {
    case "openai":
      return mapOpenAIError(error);
    case "gemini":
      return mapGeminiError(error);
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown image generation provider: ${_exhaustive}`);
    }
  }
}

/**
 * Derive the owning provider from an explicit model ID.
 *
 * When a caller (LLM tool invocation, CLI `--model` flag) passes an explicit
 * `model` argument, the request should dispatch to the provider that owns
 * that model — not to the user's configured Settings provider. Without this,
 * asking for `gpt-image-2` while `services["image-generation"].provider` is
 * `gemini` silently falls back to the Gemini default model.
 *
 * Model prefix mapping:
 *   - `gpt-*` or `dall-e-*` → `openai`
 *   - `gemini-*`            → `gemini`
 *   - anything else (or `undefined`) → the provided `fallback`
 */
export function providerForModel(
  model: string | undefined,
  fallback: ImageGenProvider,
): ImageGenProvider {
  if (!model) return fallback;
  if (model.startsWith("gpt-") || model.startsWith("dall-e-")) return "openai";
  if (model.startsWith("gemini-")) return "gemini";
  return fallback;
}

export type {
  GeneratedImage,
  ImageGenCredentials,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenProvider,
} from "./types.js";
