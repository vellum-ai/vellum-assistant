/**
 * Route handlers for Slack channel listing and direct sharing.
 *
 * These endpoints let the UI post app links directly to Slack channels
 * without going through the legacy Slack share flow.
 */

import { z } from "zod";

import { getApp } from "../../../../apps/app-store.js";
import {
  listConversations,
  postMessage,
  userInfo,
} from "../../../../messaging/providers/slack/client.js";
import type { SlackConversation } from "../../../../messaging/providers/slack/types.js";
import { getLogger } from "../../../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../../../auth/route-policy.js";
import {
  BadRequestError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "../../types.js";
import { resolveSlackToken } from "./token.js";

const log = getLogger("slack-share");

// ---------------------------------------------------------------------------
// GET /v1/slack/channels
// ---------------------------------------------------------------------------

const NormalizedChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["channel", "group", "dm"]),
  isPrivate: z.boolean(),
  isMember: z.boolean(),
  memberCount: z.number().optional(),
  topic: z.string().optional(),
  imageUrl: z.string().optional(),
});

type NormalizedChannel = z.infer<typeof NormalizedChannelSchema>;

const SlackChannelsListResultSchema = z.object({
  channels: z.array(NormalizedChannelSchema),
});

const SlackShareResultSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
  channel: z.string(),
});

function classifyConversation(
  conv: SlackConversation,
): "channel" | "group" | "dm" {
  if (conv.is_im) {
    return "dm";
  }
  if (conv.is_mpim) {
    return "group";
  }
  if (conv.is_group) {
    return "group";
  }
  return "channel";
}

const TYPE_SORT_ORDER: Record<string, number> = {
  channel: 0,
  group: 1,
  dm: 2,
};

export async function handleListSlackChannels({
  queryParams,
}: RouteHandlerArgs = {}) {
  const token = await resolveSlackToken("read");
  if (!token) {
    throw new ServiceUnavailableError("No Slack token configured");
  }

  const memberOnly = queryParams?.memberOnly === "true";

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

  const conversations = memberOnly
    ? allChannels.filter((c) => c.is_member === true)
    : allChannels;

  const dmUserIds = conversations
    .filter((c) => c.is_im && c.user)
    .map((c) => c.user!);
  const uniqueUserIds = [...new Set(dmUserIds)];
  const userResults = await Promise.allSettled(
    uniqueUserIds.map((uid) =>
      userInfo(token, uid).then((r) => ({
        uid,
        name:
          r.user.profile?.display_name ||
          r.user.profile?.real_name ||
          r.user.real_name ||
          r.user.name,
        imageUrl: r.user.profile?.image_48,
      })),
    ),
  );
  const dmUserMap = new Map<string, { name: string; imageUrl?: string }>();
  for (const r of userResults) {
    if (r.status === "fulfilled") {
      dmUserMap.set(r.value.uid, {
        name: r.value.name,
        imageUrl: r.value.imageUrl,
      });
    }
  }

  const channels: NormalizedChannel[] = conversations.map((c) => {
    const type = classifyConversation(c);
    let name = c.name ?? c.id;
    let imageUrl: string | undefined;
    if (type === "dm" && c.user) {
      const dmUser = dmUserMap.get(c.user);
      name = dmUser?.name ?? c.user;
      imageUrl = dmUser?.imageUrl;
    }
    const topic = c.topic?.value || c.purpose?.value || undefined;
    const channel: NormalizedChannel = {
      id: c.id,
      name,
      type,
      isPrivate: c.is_private ?? c.is_group ?? false,
      isMember: c.is_member ?? false,
    };
    if (c.num_members !== undefined) {
      channel.memberCount = c.num_members;
    }
    if (topic) {
      channel.topic = topic;
    }
    if (imageUrl) {
      channel.imageUrl = imageUrl;
    }
    return channel;
  });

  channels.sort((a, b) => {
    const typeOrder =
      (TYPE_SORT_ORDER[a.type] ?? 9) - (TYPE_SORT_ORDER[b.type] ?? 9);
    if (typeOrder !== 0) {
      return typeOrder;
    }
    return a.name.localeCompare(b.name);
  });

  return { channels };
}

// ---------------------------------------------------------------------------
// POST /v1/slack/share
// ---------------------------------------------------------------------------

export async function handleShareToSlackChannel({
  body = {},
}: RouteHandlerArgs) {
  const token = await resolveSlackToken("write");
  if (!token) {
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
    const result = await postMessage(token, channelId, fallbackText, {
      blocks,
    });
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

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "slack_channels_get",
    endpoint: "slack/channels",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List Slack channels",
    description: "List Slack channels, groups, and DMs for the channel picker.",
    tags: ["integrations"],
    queryParams: [
      {
        name: "memberOnly",
        schema: { type: "string", enum: ["true", "false"] },
        description:
          "When 'true', only return conversations the connected identity is a member of",
      },
    ],
    responseBody: SlackChannelsListResultSchema,
    handler: handleListSlackChannels,
  },
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
