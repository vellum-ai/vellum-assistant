/**
 * Slack channel invite adapter.
 *
 * Resolves the assistant's Slack bot @username for use in invite
 * instructions. Slack invites use the universal 6-digit code path for
 * redemption, so this adapter only implements `resolveChannelHandle` —
 * no `buildShareLink` or `extractInboundToken` needed.
 */

import type { ChannelId } from "../../channels/types.js";
import { getConfig } from "../../config/loader.js";
import type { ChannelInviteAdapter } from "../channel-invite-transport.js";

// ---------------------------------------------------------------------------
// Slack bot info resolution
// ---------------------------------------------------------------------------

interface SlackBotInfo {
  botUsername: string;
  teamName?: string;
}

/**
 * Resolve the Slack bot username and team name from config.
 */
function resolveSlackBotInfo(): SlackBotInfo | undefined {
  const { botUsername, teamName } = getConfig().slack;
  if (!botUsername) return undefined;
  return { botUsername, teamName: teamName || undefined };
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const slackInviteAdapter: ChannelInviteAdapter = {
  channel: "slack" as ChannelId,

  resolveChannelHandle(): string | undefined {
    const botInfo = resolveSlackBotInfo();
    if (!botInfo) return undefined;
    return `@${botInfo.botUsername}`;
  },
};
