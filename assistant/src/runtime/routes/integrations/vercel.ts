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

import {
  deleteVercelConfig,
  getVercelConfig,
  setVercelConfig,
} from "../../../daemon/handlers/config-vercel.js";
import type { RouteDefinition } from "../../http-router.js";

/**
 * GET /v1/integrations/vercel/config
 */
export async function handleGetVercelConfig(): Promise<Response> {
  const result = await getVercelConfig();
  return Response.json(result);
}

/**
 * POST /v1/integrations/vercel/config
 *
 * Body: { action: "set" | "delete"; apiToken?: string }
 *
 * The Swift client uses POST for both set and delete operations,
 * distinguished by the `action` field.
 */
export async function handlePostVercelConfig(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    action?: "get" | "set" | "delete";
    apiToken?: string;
  };

  switch (body.action) {
    case "delete": {
      const result = await deleteVercelConfig();
      return Response.json(result);
    }
    case "get": {
      const result = await getVercelConfig();
      return Response.json(result);
    }
    case "set":
    default: {
      const result = await setVercelConfig(body.apiToken);
      const status = result.success ? 200 : 400;
      return Response.json(result, { status });
    }
  }
}

/**
 * DELETE /v1/integrations/vercel/config
 */
export async function handleDeleteVercelConfig(): Promise<Response> {
  const result = await deleteVercelConfig();
  return Response.json(result);
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function vercelRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "integrations/vercel/config",
      method: "GET",
      handler: () => handleGetVercelConfig(),
    },
    {
      endpoint: "integrations/vercel/config",
      method: "POST",
      handler: async ({ req }) => handlePostVercelConfig(req),
    },
    {
      endpoint: "integrations/vercel/config",
      method: "DELETE",
      handler: async () => handleDeleteVercelConfig(),
    },
  ];
}
