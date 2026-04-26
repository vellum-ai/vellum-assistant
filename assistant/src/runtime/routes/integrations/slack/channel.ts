/**
 * Route handlers for Slack channel configuration.
 *
 * GET    /v1/integrations/slack/channel/config        — get current config status
 * POST   /v1/integrations/slack/channel/config        — validate and store credentials
 * DELETE /v1/integrations/slack/channel/config        — clear credentials
 * POST   /v1/integrations/slack/channel/oauth-install — run OAuth loopback to capture bot+user tokens
 */

import {
  clearSlackChannelConfig,
  getSlackChannelConfig,
  setSlackChannelConfig,
} from "../../../../daemon/handlers/config-slack-channel.js";
import { runSlackChannelOAuthInstall } from "../../../../daemon/handlers/slack-channel-oauth-install.js";
import type { RouteDefinition } from "../../../http-router.js";

// ---------------------------------------------------------------------------
// Slack channel config
// ---------------------------------------------------------------------------

/**
 * GET /v1/integrations/slack/channel/config
 */
async function handleGetSlackChannelConfig(): Promise<Response> {
  const result = await getSlackChannelConfig();
  return Response.json(result);
}

/**
 * POST /v1/integrations/slack/channel/config
 *
 * Body: { botToken?: string, appToken?: string, userToken?: string }
 */
export async function handleSetSlackChannelConfig(
  req: Request,
): Promise<Response> {
  const body = (await req.json()) as {
    botToken?: string;
    appToken?: string;
    userToken?: string;
  };
  const result = await setSlackChannelConfig(
    body.botToken,
    body.appToken,
    body.userToken,
  );
  const status = result.success ? 200 : 400;
  return Response.json(result, { status });
}

/**
 * DELETE /v1/integrations/slack/channel/config
 */
async function handleClearSlackChannelConfig(): Promise<Response> {
  const result = await clearSlackChannelConfig();
  return Response.json(result);
}

/**
 * POST /v1/integrations/slack/channel/oauth-install
 *
 * Runs an OAuth2 loopback flow to install the Slack app and capture
 * bot + user tokens. Requires client_id, client_secret, and app_token
 * to be pre-stored in the credential vault.
 *
 * Blocks until the user completes the OAuth flow or the 5-minute timeout.
 */
async function handleSlackChannelOAuthInstall(): Promise<Response> {
  const result = await runSlackChannelOAuthInstall();
  const status = result.success ? 200 : 400;
  return Response.json(result, { status });
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
    {
      endpoint: "integrations/slack/channel/oauth-install",
      method: "POST",
      handler: () => handleSlackChannelOAuthInstall(),
    },
  ];
}
