/**
 * Route definitions for the inference model catalog.
 *
 * GET /v1/inference/models — list catalog models (optional ?provider= filter)
 * GET /v1/inference/models/openrouter/lookup: confirm a free-text OpenRouter id
 *
 * The catalog (`PROVIDER_CATALOG`) is the code-owned source of truth for which
 * model ids each provider serves. Exposing it lets clients (and the assistant
 * itself) discover valid model ids instead of guessing — the same ids
 * `isModelInCatalog` validates against when a profile is created.
 */

import { z } from "zod";

import { PROVIDER_CATALOG } from "../../providers/model-catalog.js";
import {
  lookupOpenRouterModel,
  OpenRouterModelIdInvalidError,
  OpenRouterModelLookupError,
  OpenRouterModelNotFoundError,
} from "../../providers/openrouter/lookup-model.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadGatewayError, BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const catalogModelSchema = z
  .object({
    provider: z.string(),
    id: z.string(),
    displayName: z.string(),
    contextWindowTokens: z.number().optional(),
    maxOutputTokens: z.number().optional(),
    supportsThinking: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
    supportsToolUse: z.boolean().optional(),
    /** When set, the model is only visible while the named flag is enabled. */
    featureFlag: z.string().optional(),
  })
  .meta({ id: "CatalogModel" });

function handleListModels({ queryParams = {} }: RouteHandlerArgs) {
  const providerFilter = queryParams.provider?.trim();
  if (providerFilter) {
    const known = PROVIDER_CATALOG.some((p) => p.id === providerFilter);
    if (!known) {
      throw new BadRequestError(
        `Unknown provider "${providerFilter}". Known providers: ${PROVIDER_CATALOG.map(
          (p) => p.id,
        ).join(", ")}.`,
      );
    }
  }

  const models = PROVIDER_CATALOG.filter(
    (entry) => !providerFilter || entry.id === providerFilter,
  ).flatMap((entry) =>
    entry.models.map((model) => ({
      provider: entry.id,
      id: model.id,
      displayName: model.displayName,
      ...(model.contextWindowTokens !== undefined
        ? { contextWindowTokens: model.contextWindowTokens }
        : {}),
      ...(model.maxOutputTokens !== undefined
        ? { maxOutputTokens: model.maxOutputTokens }
        : {}),
      ...(model.supportsThinking !== undefined
        ? { supportsThinking: model.supportsThinking }
        : {}),
      ...(model.supportsVision !== undefined
        ? { supportsVision: model.supportsVision }
        : {}),
      ...(model.supportsToolUse !== undefined
        ? { supportsToolUse: model.supportsToolUse }
        : {}),
      ...(model.featureFlag !== undefined
        ? { featureFlag: model.featureFlag }
        : {}),
    })),
  );

  return { models };
}

const openRouterLookupResponseSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    contextWindowTokens: z.number().optional(),
    maxOutputTokens: z.number().optional(),
    supportsThinking: z.boolean(),
  })
  .meta({ id: "OpenRouterModelLookup" });

async function handleOpenRouterLookup({ queryParams = {} }: RouteHandlerArgs) {
  const rawId = queryParams.id?.trim() ?? "";
  if (rawId.length === 0) {
    throw new BadRequestError(
      "Query parameter id is required (an OpenRouter model ID such as author/model-name).",
    );
  }

  try {
    return await lookupOpenRouterModel(rawId);
  } catch (error) {
    if (error instanceof OpenRouterModelNotFoundError) {
      throw new NotFoundError(error.message);
    }
    if (error instanceof OpenRouterModelIdInvalidError) {
      throw new BadRequestError(error.message);
    }
    if (error instanceof OpenRouterModelLookupError) {
      throw new BadGatewayError(error.message);
    }
    throw error;
  }
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_models_list",
    endpoint: "inference/models",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List inference catalog models",
    description:
      "Return every model in the code-owned provider catalog, each tagged with its provider. Optionally filter by provider with ?provider=<id>.",
    tags: ["inference"],
    queryParams: [
      {
        name: "provider",
        schema: { type: "string" },
        description: `Filter by provider id. One of: ${PROVIDER_CATALOG.map(
          (p) => p.id,
        ).join(", ")}`,
      },
    ],
    responseBody: z.object({ models: z.array(catalogModelSchema) }),
    additionalResponses: { "400": { description: "Unknown provider filter" } },
    handler: handleListModels,
  },
  {
    operationId: "inference_openrouter_model_lookup",
    endpoint: "inference/models/openrouter/lookup",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Look up an OpenRouter model ID",
    description:
      "Confirm an OpenRouter model ID against OpenRouter's public model API and return its display name and token limits. Used when a user adds an ID that is not in the curated catalog.",
    tags: ["inference"],
    queryParams: [
      {
        name: "id",
        schema: { type: "string" },
        required: true,
        description:
          "OpenRouter model ID in author/slug form (optional :variant suffix).",
      },
    ],
    responseBody: openRouterLookupResponseSchema,
    additionalResponses: {
      "400": { description: "Missing or invalid model ID" },
      "404": { description: "OpenRouter does not list this model ID" },
      "502": { description: "OpenRouter lookup failed" },
    },
    handler: handleOpenRouterLookup,
  },
];
