/**
 * Route handlers for Slack channel listing and direct sharing.
 *
 * These endpoints let the UI post app links directly to Slack channels
 * without going through the legacy IPC-based Slack share flow.
 */

import { getApp } from "../../memory/app-store.js";
import {
  listConversations,
  postMessage,
  userInfo,
} from "../../messaging/providers/slack/client.js";
import type { SlackConversation } from "../../messaging/providers/slack/types.js";
import { getSecureKey } from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("slack-share-routes");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the Slack bot token from secure storage.
 * Prefers the OAuth integration token, falls back to the legacy channel token.
 */
function resolveSlackToken(): string | undefined {
  return (
    getSecureKey("credential:integration:slack:access_token") ??
    getSecureKey("credential:slack_channel:bot_token")
  );
}

// ---------------------------------------------------------------------------
// GET /v1/slack/channels
// ---------------------------------------------------------------------------

interface NormalizedChannel {
  id: string;
  name: string;
  type: "channel" | "group" | "dm";
  isPrivate: boolean;
}

function classifyConversation(
  conv: SlackConversation,
): "channel" | "group" | "dm" {
  if (conv.is_im) return "dm";
  if (conv.is_mpim) return "group";
  if (conv.is_group) return "group";
  return "channel";
}

const TYPE_SORT_ORDER: Record<string, number> = {
  channel: 0,
  group: 1,
  dm: 2,
};

export async function handleListSlackChannels(): Promise<Response> {
  const token = resolveSlackToken();
  if (!token) {
    return httpError("SERVICE_UNAVAILABLE", "No Slack token configured", 503);
  }

  // Paginate through all results (follows the pattern in adapter.ts)
  const allChannels: SlackConversation[] = [];
  let cursor: string | undefined;
  do {
    const resp = await listConversations(
      token,
      "public_channel,private_channel,mpim,im",
      true,
      200,
      cursor,
    );
    allChannels.push(...resp.channels);
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);

  // Resolve DM display names in parallel, tolerating individual failures.
  const dmUserIds = allChannels
    .filter((c) => c.is_im && c.user)
    .map((c) => c.user!);
  const uniqueUserIds = [...new Set(dmUserIds)];
  const nameResults = await Promise.allSettled(
    uniqueUserIds.map((uid) =>
      userInfo(token, uid).then((r) => ({
        uid,
        name:
          r.user.profile?.display_name ||
          r.user.profile?.real_name ||
          r.user.real_name ||
          r.user.name,
      })),
    ),
  );
  const nameMap = new Map<string, string>();
  for (const r of nameResults) {
    if (r.status === "fulfilled") {
      nameMap.set(r.value.uid, r.value.name);
    }
  }

  const channels: NormalizedChannel[] = allChannels.map((c) => {
    const type = classifyConversation(c);
    let name = c.name ?? c.id;
    if (type === "dm" && c.user) {
      name = nameMap.get(c.user) ?? c.user;
    }
    return {
      id: c.id,
      name,
      type,
      isPrivate: c.is_private ?? c.is_group ?? false,
    };
  });

  // Sort: channels first, then groups, then DMs — alphabetical within each.
  channels.sort((a, b) => {
    const typeOrder =
      (TYPE_SORT_ORDER[a.type] ?? 9) - (TYPE_SORT_ORDER[b.type] ?? 9);
    if (typeOrder !== 0) return typeOrder;
    return a.name.localeCompare(b.name);
  });

  return Response.json({ channels });
}

// ---------------------------------------------------------------------------
// POST /v1/slack/share
// ---------------------------------------------------------------------------

export async function handleShareToSlackChannel(
  req: Request,
): Promise<Response> {
  const token = resolveSlackToken();
  if (!token) {
    return httpError("SERVICE_UNAVAILABLE", "No Slack token configured", 503);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return httpError("BAD_REQUEST", "Malformed JSON body", 400);
  }

  const appId = body.appId;
  const channelId = body.channelId;
  const message = body.message;

  if (!appId || !channelId) {
    return httpError(
      "BAD_REQUEST",
      "Missing required fields: appId, channelId",
      400,
    );
  }

  if (typeof appId !== "string" || typeof channelId !== "string") {
    return httpError(
      "BAD_REQUEST",
      "Fields appId and channelId must be strings",
      400,
    );
  }

  if (message !== undefined && typeof message !== "string") {
    return httpError("BAD_REQUEST", "Field message must be a string", 400);
  }

  const app = getApp(appId);
  if (!app) {
    return httpError("NOT_FOUND", "App not found", 404);
  }

  // Build a Block Kit message with a deterministic fallback text.
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
    const result = await postMessage(token, channelId, fallbackText, {
      blocks,
    });
    return Response.json({
      ok: true,
      ts: result.ts,
      channel: result.channel,
    });
  } catch (err) {
    log.error({ err, appId, channelId }, "Failed to share app to Slack");
    return httpError("INTERNAL_ERROR", "Failed to post message to Slack", 500);
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function slackShareRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "slack/channels",
      method: "GET",
      handler: () => handleListSlackChannels(),
    },
    {
      endpoint: "slack/share",
      method: "POST",
      handler: async ({ req }) => handleShareToSlackChannel(req),
    },
  ];
}
