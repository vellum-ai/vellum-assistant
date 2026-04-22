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
  if (provider === "openai") return generateImageOpenAI(credentials, request);
  return generateImageGemini(credentials, request);
}

/**
 * Dispatch error mapping to the provider-specific implementation.
 */
export function mapImageGenError(
  provider: ImageGenProvider,
  error: unknown,
): string {
  if (provider === "openai") return mapOpenAIError(error);
  return mapGeminiError(error);
}

export type {
  GeneratedImage,
  ImageGenCredentials,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenProvider,
} from "./types.js";
