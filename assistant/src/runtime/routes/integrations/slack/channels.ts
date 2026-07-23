/**
 * Route handler for the Slack presence list.
 *
 * GET /v1/slack/channels — the normalized list of rooms the connected bot is a
 * member of (channels and group DMs), shown on the Channels settings tab.
 */

import { z } from "zod";

import { resolveSlackAuth } from "../../../../messaging/providers/slack/auth.js";
import { listConversations } from "../../../../messaging/providers/slack/client.js";
import {
  classifyConversationType,
  isMemberConversation,
  isPrivateConversation,
} from "../../../../messaging/providers/slack/conversation-utils.js";
import type { SlackConversation } from "../../../../messaging/providers/slack/types.js";
import { ACTOR_PRINCIPALS } from "../../../auth/route-policy.js";
import { ServiceUnavailableError } from "../../errors.js";
import type { RouteDefinition } from "../../types.js";

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

export async function handleListSlackChannels() {
  // Reads as the BOT. This route is exposed at the gateway with generic edge
  // auth and the daemon never sees the calling actor's identity, so it must act
  // as the neutral app identity, never the stored installer user_token (which
  // would leak the installer's channel list to any caller). It is the bot's own
  // membership anyway — Slack's `is_member` is relative to the token's own
  // identity, so only the bot token answers "which rooms is the bot in".
  const botAuth = await resolveSlackAuth("bot");
  if (botAuth === undefined) {
    throw new ServiceUnavailableError("No Slack token configured");
  }

  // Rooms only — public/private channels and group DMs. 1:1 IMs are
  // person-scoped (their settings live on the contact) and Slack materializes
  // IM rows without any conversation happening (app install, a user opening the
  // bot's DM tab), which would overstate presence — so the `im` type is never
  // requested.
  const allChannels: SlackConversation[] = [];
  let cursor: string | undefined;
  do {
    const resp = await listConversations(
      botAuth,
      "public_channel,private_channel,mpim",
      true,
      200,
      cursor,
    );
    allChannels.push(...resp.channels);
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const channels: NormalizedChannel[] = allChannels
    .filter((c) => !c.is_im && isMemberConversation(c))
    .map((c) => ({
      id: c.id,
      name: c.name ?? c.id,
      type: classifyConversationType(c),
      isPrivate: isPrivateConversation(c),
      isMember: isMemberConversation(c),
      memberCount: c.num_members ?? null,
      topic: c.topic?.value || c.purpose?.value || null,
      imageUrl: null,
    }));

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
    summary: "List the Slack rooms the bot is in",
    description:
      "List the Slack channels and group DMs the connected bot is a member of, for the Channels settings tab.",
    tags: ["integrations"],
    responseBody: SlackChannelsListResultSchema,
    handler: handleListSlackChannels,
  },
];
