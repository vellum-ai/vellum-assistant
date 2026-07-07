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
import {
  classifyConversationType,
  isMemberConversation,
  isPrivateConversation,
  slackUserDisplayName,
} from "../../../../messaging/providers/slack/conversation-utils.js";
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

const TYPE_SORT_ORDER: Record<string, number> = {
  channel: 0,
  group: 1,
  dm: 2,
};

/** Slackbot's fixed user id — its IM channel exists in every workspace. */
const SLACKBOT_USER_ID = "USLACKBOT";

/**
 * IMs the assistant can neither converse in meaningfully nor post to:
 * Slackbot (bots cannot message Slackbot) and deactivated accounts.
 */
function isNoiseIm(c: SlackConversation): boolean {
  return (
    !!c.is_im && (c.user === SLACKBOT_USER_ID || c.is_user_deleted === true)
  );
}

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

  // The presence list (memberOnly) is rooms only: channels and group DMs.
  // 1:1 IMs are person-scoped, not room-scoped — the person's settings live
  // on their contact — and Slack materializes IM rows without any
  // conversation happening (app install, a user merely opening the bot's DM
  // tab, Slackbot), so IM existence would overstate presence anyway. The
  // share picker (memberOnly absent) keeps IMs — they are valid share
  // destinations — minus the unpostable noise IMs.
  const conversations = (
    memberOnly
      ? allChannels.filter((c) => !c.is_im && isMemberConversation(c))
      : allChannels
  ).filter((c) => !isNoiseIm(c));

  const dmUserIds = conversations
    .filter((c) => c.is_im && c.user)
    .map((c) => c.user!);
  const uniqueUserIds = [...new Set(dmUserIds)];
  const userResults = await Promise.allSettled(
    uniqueUserIds.map((uid) =>
      userInfo(token, uid).then((r) => ({
        uid,
        name: slackUserDisplayName(r.user),
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
    const type = classifyConversationType(c);
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
      isPrivate: isPrivateConversation(c),
      isMember: isMemberConversation(c),
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
          "When 'true', only return rooms the connected identity is in: channels with is_member plus group DMs. 1:1 DMs are excluded — they are person-scoped, and Slack materializes IM rows without any conversation happening.",
      },
    ],
    responseBody: SlackChannelsListResultSchema,
    handler: handleListSlackChannels,
  },
];
