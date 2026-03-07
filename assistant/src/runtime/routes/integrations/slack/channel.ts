/**
 * Route handlers for Slack channel configuration.
 *
 * GET    /v1/integrations/slack/channel/config — get current config status
 * POST   /v1/integrations/slack/channel/config — validate and store credentials
 * DELETE /v1/integrations/slack/channel/config — clear credentials
 */

import {
  clearSlackChannelConfig,
  getSlackChannelConfig,
  setSlackChannelConfig,
} from "../../../../daemon/handlers/config-slack-channel.js";
import type { RouteDefinition } from "../../../http-router.js";

// ---------------------------------------------------------------------------
// Slack channel config
// ---------------------------------------------------------------------------

/**
 * GET /v1/integrations/slack/channel/config
 */
export function handleGetSlackChannelConfig(): Response {
  const result = getSlackChannelConfig();
  return Response.json(result);
}

/**
 * POST /v1/integrations/slack/channel/config
 *
 * Body: { botToken?: string, appToken?: string }
 */
export async function handleSetSlackChannelConfig(
  req: Request,
): Promise<Response> {
  const body = (await req.json()) as { botToken?: string; appToken?: string };
  const result = await setSlackChannelConfig(body.botToken, body.appToken);
  const status = result.success ? 200 : 400;
  return Response.json(result, { status });
}

/**
 * DELETE /v1/integrations/slack/channel/config
 */
export async function handleClearSlackChannelConfig(): Promise<Response> {
  const result = await clearSlackChannelConfig();
  return Response.json(result);
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function slackChannelRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "integrations/slack/channel/config",
      method: "GET",
      handler: () => handleGetSlackChannelConfig(),
    },
    {
      endpoint: "integrations/slack/channel/config",
      method: "POST",
      handler: async ({ req }) => handleSetSlackChannelConfig(req),
    },
    {
      endpoint: "integrations/slack/channel/config",
      method: "DELETE",
      handler: () => handleClearSlackChannelConfig(),
    },
  ];
}
