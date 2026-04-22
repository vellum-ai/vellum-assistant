import OpenAI from "openai";
import { toFile } from "openai/uploads";

import {
  type GeneratedImage,
  type ImageGenCredentials,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  MAX_VARIANTS,
} from "./types.js";

// --- Constants ---

const DEFAULT_MODEL = "gpt-image-2";
const ALLOWED_MODELS = new Set(["gpt-image-2"]);

// --- Error mapping ---

/**
 * Map an error raised by the OpenAI Images API to a user-friendly string.
 * Mirrors the status-code branches of `mapGeminiError` in
 * `./gemini-image-service.ts`.
 */
export function mapOpenAIError(error: unknown): string {
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    if (status === 400) {
      return "The image request was invalid. Please check your prompt and try again.";
    }
    if (status === 401 || status === 403) {
      return "Authentication failed. Please check your OpenAI API key.";
    }
    if (status === 429) {
      return "Rate limit exceeded. Please wait a moment and try again.";
    }
    if (status !== undefined && status >= 500) {
      return "The OpenAI service is temporarily unavailable. Please try again later.";
    }
    return `OpenAI API error (status ${status}). Please try again.`;
  }
  if (error instanceof Error) {
    return `Image generation failed: ${error.message}`;
  }
  return "An unexpected error occurred during image generation.";
}

// --- Title derivation ---

/**
 * Derive a short filename-safe title from the first 6 words of the prompt.
 * Uses the same sanitization regex as `extractTitle` in
 * `./gemini-image-service.ts`.
 */
function deriveTitleFromPrompt(prompt: string): string | undefined {
  const firstWords = prompt.trim().split(/\s+/).slice(0, 6).join(" ");
  if (!firstWords) return undefined;
  const sanitized = firstWords
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 60);
  return sanitized.length > 0 ? sanitized : undefined;
}

// --- Core function ---

/**
 * Generate or edit an image via the OpenAI Images API (`gpt-image-2`).
 *
 * The OpenAI Images API does not return commentary text, so the returned
 * `text` field is always `undefined`. A title is derived from the prompt
 * instead and attached to every returned image.
 */
export async function generateImageOpenAI(
  credentials: ImageGenCredentials,
  request: ImageGenerationRequest,
): Promise<ImageGenerationResult> {
  const model =
    request.model && ALLOWED_MODELS.has(request.model)
      ? request.model
      : DEFAULT_MODEL;

  const variants = Math.max(1, Math.min(request.variants ?? 1, MAX_VARIANTS));

  const client =
    credentials.type === "managed-proxy"
      ? new OpenAI({
          apiKey: credentials.assistantApiKey,
          baseURL: credentials.baseUrl,
        })
      : new OpenAI({ apiKey: credentials.apiKey });

  const title = deriveTitleFromPrompt(request.prompt);

  let response: { data?: Array<{ b64_json?: string }> };

  if (request.mode === "edit" && request.sourceImages) {
    const files = await Promise.all(
      request.sourceImages.map((img) =>
        toFile(Buffer.from(img.dataBase64, "base64"), "input.png", {
          type: img.mimeType,
        }),
      ),
    );
    response = (await client.images.edit({
      model,
      prompt: request.prompt,
      image: files,
      n: variants,
    })) as { data?: Array<{ b64_json?: string }> };
  } else {
    response = (await client.images.generate({
      model,
      prompt: request.prompt,
      n: variants,
    })) as { data?: Array<{ b64_json?: string }> };
  }

  const images: GeneratedImage[] = [];
  for (const entry of response.data ?? []) {
    if (!entry.b64_json) continue;
    const img: GeneratedImage = {
      mimeType: "image/png",
      dataBase64: entry.b64_json,
    };
    if (title) img.title = title;
    images.push(img);
  }

  return { images, text: undefined, resolvedModel: model };
}
