import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { resolveImageGenCredentials } from "../../media/image-credentials.js";
import {
  describeImageModels,
  resolveImageModel,
} from "../../media/image-models.js";
import {
  generateImage,
  mapImageGenError,
  providerForModel,
} from "../../media/image-service.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadRequestError,
  InternalError,
  UnprocessableEntityError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SourceImageSchema = z.object({
  mimeType: z.string(),
  dataBase64: z.string(),
});

const ImageGenerationRequestSchema = z.object({
  prompt: z.string(),
  mode: z.enum(["generate", "edit"]).optional(),
  sourceImages: z.array(SourceImageSchema).optional(),
  model: z.string().optional(),
  variants: z.number().optional(),
});

const GeneratedImageSchema = z.object({
  mimeType: z.string(),
  dataBase64: z.string(),
  title: z.string().optional(),
});

const ImageGenerationResponseSchema = z.object({
  images: z.array(GeneratedImageSchema),
  text: z.string().optional(),
  resolvedModel: z.string(),
});
type ImageGenerationResponse = z.infer<typeof ImageGenerationResponseSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleImageGenerationGenerate(
  args: RouteHandlerArgs,
): Promise<ImageGenerationResponse> {
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

  // Resolve tier aliases (fast, quality, openai) to concrete model IDs via
  // the registry; reject unknown values with the current catalog so the
  // error is self-describing rather than a stale enum.
  let resolvedModel = model as string | undefined;
  if (typeof resolvedModel === "string" && resolvedModel) {
    const entry = resolveImageModel(resolvedModel);
    if (!entry) {
      throw new BadRequestError(
        `Unknown model "${resolvedModel}". Available models and aliases:\n${describeImageModels()}`,
      );
    }
    resolvedModel = entry.id;
  }

  // Derive provider from explicit model override when supplied
  const provider = providerForModel(resolvedModel, svc.provider);

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
      model: resolvedModel ?? svc.model,
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Generate or edit images using AI",
    description:
      "Calls the configured image-generation provider (Gemini or OpenAI) to produce one or more images.",
    tags: ["image-generation"],
    requestBody: ImageGenerationRequestSchema,
    responseBody: ImageGenerationResponseSchema,
    handler: handleImageGenerationGenerate,
  },
];
