/**
 * Route handler for Slack workspace user enumeration.
 *
 * GET /v1/slack/users — normalized workspace roster used by the contact
 * "Link account" picker. Same token resolution as GET /v1/slack/channels.
 */

import { z } from "zod";

import { resolveSlackAuth } from "../../../../messaging/providers/slack/auth.js";
import { listUsers } from "../../../../messaging/providers/slack/client.js";
import { slackUserDisplayName } from "../../../../messaging/providers/slack/conversation-utils.js";
import type { SlackUser } from "../../../../messaging/providers/slack/types.js";
import { ACTOR_PRINCIPALS } from "../../../auth/route-policy.js";
import { ServiceUnavailableError } from "../../errors.js";
import type { RouteDefinition } from "../../types.js";

const NormalizedUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  imageUrl: z.string().nullable(),
});

const SlackUsersListResultSchema = z.object({
  users: z.array(NormalizedUserSchema),
});

/** Slack's built-in bot user, not flagged `is_bot` in the API response. */
const SLACKBOT_USER_ID = "USLACKBOT";

export async function handleListSlackUsers() {
  // users.list is workspace-wide, so the bot token returns the same roster a
  // user token would — no reason to prefer (or act as) the user here.
  const auth = await resolveSlackAuth("bot");
  if (auth === undefined) {
    throw new ServiceUnavailableError("No Slack token configured");
  }

  const members: SlackUser[] = [];
  let cursor: string | undefined;
  do {
    const resp = await listUsers(auth, 200, cursor);
    members.push(...resp.members);
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const users = members
    .filter(
      (member) =>
        !member.deleted && !member.is_bot && member.id !== SLACKBOT_USER_ID,
    )
    .map((member) => ({
      id: member.id,
      username: member.name,
      displayName: slackUserDisplayName(member),
      imageUrl: member.profile?.image_48 ?? null,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return { users };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "slack_users_get",
    endpoint: "slack/users",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List Slack workspace users",
    description:
      "List human members of the connected Slack workspace for the contact account-linking picker. Deleted users and bots are excluded.",
    tags: ["integrations"],
    responseBody: SlackUsersListResultSchema,
    handler: handleListSlackUsers,
  },
];
