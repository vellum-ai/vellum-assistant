/**
 * Route handlers for Vercel integration config endpoints.
 *
 * GET    /v1/integrations/vercel/config — check if a Vercel API token is stored
 * POST   /v1/integrations/vercel/config — set or delete token (dispatched via action field)
 * DELETE /v1/integrations/vercel/config — delete the stored Vercel API token
 *
 * The Swift client sends all mutations as POST with an `action` field
 * ("set" or "delete") rather than using HTTP verbs directly.
 */

import { z } from "zod";

import {
  deleteVercelConfig,
  getVercelConfig,
  setVercelConfig,
} from "../../../daemon/handlers/config-vercel.js";
import { BadRequestError } from "../errors.js";
import { parseBody } from "../parse-body.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

const vercelConfigResponseSchema = z.object({
  hasToken: z.boolean(),
  success: z.boolean(),
  error: z.string().optional(),
});

// Declared once and referenced by both the route's `requestBody` (the
// OpenAPI/wire contract) and the handler's `parseBody` call, so the
// advertised shape and the validated shape can't drift.
const VercelConfigParams = z.object({
  action: z.enum(["get", "set", "delete"]).optional(),
  apiToken: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetVercelConfig() {
  return getVercelConfig();
}

async function handlePostVercelConfig({ body = {} }: RouteHandlerArgs) {
  const { action, apiToken } = parseBody(VercelConfigParams, body);

  switch (action) {
    case "delete":
      return deleteVercelConfig();
    case "get":
      return getVercelConfig();
    case "set":
    default: {
      const result = await setVercelConfig(apiToken);
      if (!result.success) {
        throw new BadRequestError(
          (result as { error?: string }).error ?? "Failed to set Vercel config",
        );
      }
      return result;
    }
  }
}

async function handleDeleteVercelConfig() {
  return deleteVercelConfig();
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "integrations_vercel_config_get",
    endpoint: "integrations/vercel/config",
    method: "GET",
    policy: null,
    summary: "Get Vercel config",
    description: "Check if a Vercel API token is stored.",
    tags: ["integrations"],
    responseBody: vercelConfigResponseSchema,
    handler: () => handleGetVercelConfig(),
  },
  {
    operationId: "integrations_vercel_config_post",
    endpoint: "integrations/vercel/config",
    method: "POST",
    policy: null,
    summary: "Set or delete Vercel config",
    description:
      "Set or delete the Vercel API token. Action is determined by the body action field.",
    tags: ["integrations"],
    requestBody: VercelConfigParams,
    responseBody: vercelConfigResponseSchema,
    handler: handlePostVercelConfig,
  },
  {
    operationId: "integrations_vercel_config_delete",
    endpoint: "integrations/vercel/config",
    method: "DELETE",
    policy: null,
    summary: "Delete Vercel config",
    description: "Delete the stored Vercel API token.",
    tags: ["integrations"],
    responseBody: vercelConfigResponseSchema,
    handler: () => handleDeleteVercelConfig(),
  },
];
