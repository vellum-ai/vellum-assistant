/**
 * Route handlers for Vercel integration config endpoints.
 *
 * GET    /v1/integrations/vercel/config — check if a Vercel API token is stored
 * POST   /v1/integrations/vercel/config — store a Vercel API token
 * DELETE /v1/integrations/vercel/config — delete the stored Vercel API token
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
 * Body: { apiToken?: string }
 */
export async function handleSetVercelConfig(req: Request): Promise<Response> {
  const body = (await req.json()) as { apiToken?: string };
  const result = await setVercelConfig(body.apiToken);
  const status = result.success ? 200 : 400;
  return Response.json(result, { status });
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
      handler: async ({ req }) => handleSetVercelConfig(req),
    },
    {
      endpoint: "integrations/vercel/config",
      method: "DELETE",
      handler: async () => handleDeleteVercelConfig(),
    },
  ];
}
