/**
 * Route handler for Slack channel enumeration.
 *
 * GET /v1/slack/channels — normalized list of channels, groups, and DMs
 * used by the share picker and the Channels-tab room list.
 */

import { z } from "zod";

import {
  listConversations,
  userInfo,
} from "../../../../messaging/providers/slack/client.js";
import type { SlackConversation } from "../../../../messaging/providers/slack/types.js";
import { ACTOR_PRINCIPALS } from "../../../auth/route-policy.js";
import { ServiceUnavailableError } from "../../errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "../../types.js";
import { resolveSlackToken } from "./token.js";

const NormalizedChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["channel", "group", "dm"]),
  isPrivate: z.boolean(),
  isMember: z.boolean(),
  memberCount: z.number().nullable(),
  topic: z.string().nullable(),
  imageUrl: z.string().nullable(),
});

type NormalizedChannel = z.infer<typeof NormalizedChannelSchema>;

const SlackChannelsListResultSchema = z.object({
  channels: z.array(NormalizedChannelSchema),
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
        imageUrl: r.user.profile?.image_48 ?? null,
      })),
    ),
  );
  const dmUserMap = new Map<
    string,
    { name: string; imageUrl: string | null }
  >();
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
    let imageUrl: string | null = null;
    if (type === "dm" && c.user) {
      const dmUser = dmUserMap.get(c.user);
      name = dmUser?.name ?? c.user;
      imageUrl = dmUser?.imageUrl ?? null;
    }
    return {
      id: c.id,
      name,
      type,
      isPrivate: c.is_private ?? c.is_group ?? false,
      isMember: c.is_member ?? false,
      memberCount: c.num_members ?? null,
      topic: c.topic?.value || c.purpose?.value || null,
      imageUrl,
    };
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
];
