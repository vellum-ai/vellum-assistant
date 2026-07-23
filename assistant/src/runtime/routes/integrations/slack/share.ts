/**
 * Route handler for direct sharing to Slack channels.
 *
 * POST /v1/slack/share — lets the UI post app links directly to Slack
 * channels without going through the legacy Slack share flow.
 */

import { z } from "zod";

import { getApp } from "../../../../apps/app-store.js";
import {
  resolveSlackAuth,
  runAsUserWithBotFallback,
} from "../../../../messaging/providers/slack/auth.js";
import { postMessage } from "../../../../messaging/providers/slack/client.js";
import { getLogger } from "../../../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../../../auth/route-policy.js";
import {
  BadRequestError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "../../types.js";

const log = getLogger("slack-share");

const SlackShareResultSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
  channel: z.string(),
});

export async function handleShareToSlackChannel({
  body = {},
}: RouteHandlerArgs) {
  // Sharing is a human-initiated action, so post AS THE USER when a user token
  // is stored — the message should read as the person who clicked Share, not
  // as the bot. Resolve the bot auth up front to anchor the fallback and to
  // give the "not configured" check; the actual post prefers the user token.
  const botAuth = await resolveSlackAuth("bot");
  if (botAuth === undefined) {
    throw new ServiceUnavailableError("No Slack token configured");
  }

  const { appId, channelId, message } = body as {
    appId?: string;
    channelId?: string;
    message?: string;
  };

  if (!appId || !channelId) {
    throw new BadRequestError("Missing required fields: appId, channelId");
  }

  if (typeof appId !== "string" || typeof channelId !== "string") {
    throw new BadRequestError("Fields appId and channelId must be strings");
  }

  if (message !== undefined && typeof message !== "string") {
    throw new BadRequestError("Field message must be a string");
  }

  const app = getApp(appId);
  if (!app) {
    throw new NotFoundError("App not found");
  }

  const fallbackText = message
    ? `${message} — ${app.name}`
    : `Shared app: ${app.name}`;

  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: message ? `${message}\n\n*${app.name}*` : `*${app.name}*`,
      },
    },
  ];

  if (app.description) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: app.description }],
    });
  }

  try {
    // Fall back to the bot token when the user token is revoked (401) or lacks
    // chat:write (missing_scope) — otherwise a share would fail for an install
    // whose user token is under-scoped even though the bot could post fine.
    const result = await runAsUserWithBotFallback(
      botAuth,
      (auth) => postMessage(auth, channelId, fallbackText, { blocks }),
      {
        shouldFallback: (err) =>
          err.status === 401 || err.slackError === "missing_scope",
      },
    );
    return {
      ok: true,
      ts: result.ts,
      channel: result.channel,
    };
  } catch (err) {
    log.error({ err, appId, channelId }, "Failed to share app to Slack");
    throw new InternalError("Failed to post message to Slack");
  }
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "slack_share_post",
    endpoint: "slack/share",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Share to Slack channel",
    description: "Post an app link directly to a Slack channel.",
    tags: ["integrations"],
    requestBody: z.object({
      appId: z.string().describe("App to share"),
      channelId: z.string().describe("Target Slack channel ID"),
      message: z.string().optional().describe("Optional accompanying message"),
    }),
    responseBody: SlackShareResultSchema,
    handler: handleShareToSlackChannel,
  },
];
