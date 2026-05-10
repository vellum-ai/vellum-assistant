import { getConfig } from "../../config/loader.js";
import { resolveImageGenCredentials } from "../../media/image-credentials.js";
import {
  generateImage,
  mapImageGenError,
  providerForModel,
} from "../../media/image-service.js";
import { BadRequestError, InternalError, UnprocessableEntityError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleImageGenerationGenerate(
  args: RouteHandlerArgs,
): Promise<unknown> {
  const { prompt, mode, sourceImages, model, variants } = args.body ?? {};

  // Validate prompt
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new BadRequestError("prompt must be a non-empty string");
  }

  // Validate / default mode
  const resolvedMode: "generate" | "edit" =
    mode === "edit" ? "edit" : "generate";

  // Validate edit mode requirements
  if (
    resolvedMode === "edit" &&
    (!sourceImages ||
      !Array.isArray(sourceImages) ||
      (sourceImages as unknown[]).length === 0)
  ) {
    throw new BadRequestError("Edit mode requires at least one source image");
  }

  // Resolve config
  const config = getConfig();
  const svc = config.services["image-generation"];

  // Derive provider from explicit model override when supplied
  const provider = providerForModel(model, svc.provider);

  // Resolve credentials
  const { credentials, errorHint } = await resolveImageGenCredentials({
    provider,
    mode: svc.mode,
  });

  if (!credentials) {
    throw new UnprocessableEntityError(
      errorHint ?? "No credentials available for image generation",
    );
  }

  // Clamp variants to 1-4
  const clampedVariants = Math.max(1, Math.min(Number(variants) || 1, 4));

  // Generate image
  try {
    const result = await generateImage(provider, credentials, {
      prompt,
      mode: resolvedMode,
      sourceImages: sourceImages as
        | Array<{ mimeType: string; dataBase64: string }>
        | undefined,
      model: (model as string | undefined) ?? svc.model,
      variants: clampedVariants,
    });

    return {
      images: result.images,
      text: result.text,
      resolvedModel: result.resolvedModel,
    };
  } catch (error) {
    const errorMessage = mapImageGenError(provider, error);
    throw new InternalError(errorMessage);
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "image_generation_generate",
    endpoint: "image-generation/generate",
    method: "POST",
    summary: "Generate or edit images using AI",
    description:
      "Calls the configured image-generation provider (Gemini or OpenAI) to produce one or more images.",
    tags: ["image-generation"],
    handler: handleImageGenerationGenerate,
  },
];
