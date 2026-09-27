import { z } from "zod";

import {
  DEFAULT_OPENROUTER_IMAGE_MODEL,
  qualifyImageModelForOpenRouter,
  resolveImageModel,
} from "./image-models.js";
import {
  type GeneratedImage,
  type ImageGenCredentials,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  isImageProviderBillingError,
  MAX_VARIANTS,
} from "./types.js";

const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";
const OpenRouterImageResponseSchema = z.object({
  data: z
    .array(
      z
        .object({
          b64_json: z.string().optional().catch(undefined),
          media_type: z.string().optional().catch(undefined),
        })
        .optional()
        .catch(undefined),
    )
    .optional()
    .catch(undefined),
  error: z
    .union([
      z.string(),
      z.object({
        message: z.string().optional().catch(undefined),
      }),
    ])
    .optional()
    .catch(undefined),
});

type OpenRouterImageResponse = z.infer<typeof OpenRouterImageResponseSchema>;

/**
 * Qualify a bare built-in ID or alias for OpenRouter. Call sites that skip
 * tool-level validation (app-icon, avatar) still reach this boundary.
 */
function resolveOpenRouterModel(model: string | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed) {
    return DEFAULT_OPENROUTER_IMAGE_MODEL;
  }
  if (resolveImageModel(trimmed)) {
    return qualifyImageModelForOpenRouter(trimmed);
  }
  return trimmed;
}

const OPENROUTER_BILLING_MESSAGE =
  "Image generation is unavailable because the OpenRouter account or API key is out of credits. " +
  "Add funds with the provider or update the key in Settings. Retrying won't help until credits are added.";

class OpenRouterImageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenRouterImageError";
  }
}

export function mapOpenRouterError(error: unknown): string {
  if (error instanceof OpenRouterImageError) {
    if (
      isImageProviderBillingError({
        status: error.status,
        message: error.message,
      })
    ) {
      return OPENROUTER_BILLING_MESSAGE;
    }
    if (error.status === 400) {
      return `The OpenRouter image request was invalid: ${error.message}`;
    }
    if (error.status === 401 || error.status === 403) {
      return "Authentication failed. Please check your OpenRouter API key.";
    }
    if (error.status === 429) {
      return "OpenRouter rate limit exceeded. Please wait a moment and try again.";
    }
    if (error.status >= 500) {
      return "The OpenRouter service is temporarily unavailable. Please try again later.";
    }
    return `OpenRouter API error (status ${error.status}). Please try again.`;
  }
  if (error instanceof Error) {
    if (isImageProviderBillingError({ message: error.message })) {
      return OPENROUTER_BILLING_MESSAGE;
    }
    return `Image generation failed: ${error.message}`;
  }
  return "An unexpected error occurred during image generation.";
}

function errorMessage(body: OpenRouterImageResponse | undefined): string {
  if (typeof body?.error === "string") {
    return body.error;
  }
  return body?.error?.message || "Request failed";
}

export async function generateImageOpenRouter(
  credentials: ImageGenCredentials,
  request: ImageGenerationRequest,
): Promise<ImageGenerationResult> {
  if (credentials.type !== "direct") {
    throw new Error(
      "OpenRouter image generation requires an OpenRouter API key.",
    );
  }

  const model = resolveOpenRouterModel(request.model);
  const variants = Math.max(1, Math.min(request.variants ?? 1, MAX_VARIANTS));
  const inputReferences = request.sourceImages?.map((image) => ({
    type: "image_url" as const,
    image_url: {
      url: `data:${image.mimeType};base64,${image.dataBase64}`,
    },
  }));

  const response = await fetch(OPENROUTER_IMAGES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt: request.prompt,
      n: variants,
      ...(request.mode === "edit" && inputReferences?.length
        ? { input_references: inputReferences }
        : {}),
    }),
    ...(request.signal ? { signal: request.signal } : {}),
  });

  const parsed = OpenRouterImageResponseSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  const body = parsed.success ? parsed.data : undefined;

  if (!response.ok) {
    throw new OpenRouterImageError(response.status, errorMessage(body));
  }

  const images: GeneratedImage[] = [];
  for (const entry of body?.data ?? []) {
    if (!entry?.b64_json) {
      continue;
    }
    images.push({
      mimeType: entry.media_type || "image/png",
      dataBase64: entry.b64_json,
    });
  }

  return { images, text: undefined, resolvedModel: model };
}
