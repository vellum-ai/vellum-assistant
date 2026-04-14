/**
 * Route handlers for Slack channel listing and direct sharing.
 *
 * These endpoints let the UI post app links directly to Slack channels
 * without going through the legacy Slack share flow.
 */

import { getApp } from "../../../../memory/app-store.js";
import {
  listConversations,
  postMessage,
  userInfo,
} from "../../../../messaging/providers/slack/client.js";
import type { SlackConversation } from "../../../../messaging/providers/slack/types.js";
import { getConnectionByProvider } from "../../../../oauth/oauth-store.js";
import { credentialKey } from "../../../../security/credential-key.js";
import { getSecureKeyAsync } from "../../../../security/secure-keys.js";
import { getLogger } from "../../../../util/logger.js";
import { httpError } from "../../../http-errors.js";
import type { RouteDefinition } from "../../../http-router.js";

const log = getLogger("slack-share");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a Slack token for the Share UI, mirroring the read/write auth split
 * in `messaging/providers/slack/adapter.ts`.
 *
 * For Socket Mode installs (tokens stored under `credential/slack_channel/*`),
 * prefer the user OAuth token (xoxp-) for reads when present — this lets the
 * channel picker surface channels the user belongs to but the bot doesn't.
 * Fall back to the bot token (xoxb-) otherwise.
 *
 * Writes MUST always use the bot token so posted messages come from the bot
 * identity, never the user. Passing `user_token` to chat.postMessage would
 * post as the user — unambiguously wrong for Share UI behavior.
 *
 * For legacy OAuth installs (no Socket Mode tokens), fall back to the OAuth
 * connection's access_token, which is the bot token in Slack's OAuth v2 flow.
 */
async function resolveSlackToken(
  mode: "read" | "write",
): Promise<string | undefined> {
  // Socket Mode path — tokens stored directly in the credential vault.
  const botToken = await getSecureKeyAsync(
    credentialKey("slack_channel", "bot_token"),
  );
  if (botToken) {
    if (mode === "read") {
      const userToken = await getSecureKeyAsync(
        credentialKey("slack_channel", "user_token"),
      );
      return userToken ?? botToken;
    }
    // SAFETY: writes must use the bot token. Using the user token here would
    // post as the user rather than the bot.
    return botToken;
  }

  // Legacy OAuth path. Slack's OAuth v2 access_token is the bot token; there
  // is no separate user token stored for this install, so reads and writes
  // both use access_token.
  const conn = getConnectionByProvider("slack");
  if (!conn) return undefined;
  return await getSecureKeyAsync(`oauth_connection/${conn.id}/access_token`);
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
  // Channel enumeration is a read path — prefer user_token when present so
  // the picker surfaces channels the user is in but the bot isn't.
  const token = await resolveSlackToken("read");
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
  // Posting a message is a write path — must use the bot token so the message
  // comes from the bot identity, never the user.
  const token = await resolveSlackToken("write");
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
