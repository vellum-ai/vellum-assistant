/**
 * Slack channel invite adapter.
 *
 * Resolves the assistant's Slack bot @username for use in invite
 * instructions. Slack invites use the universal 6-digit code path for
 * redemption, so this adapter only implements `resolveChannelHandle` —
 * no `buildShareLink` or `extractInboundToken` needed.
 */

import type { ChannelId } from "../../channels/types.js";
import { getCredentialMetadata } from "../../tools/credentials/metadata-store.js";
import type { ChannelInviteAdapter } from "../channel-invite-transport.js";

// ---------------------------------------------------------------------------
// Slack bot info resolution
// ---------------------------------------------------------------------------

interface SlackBotInfo {
  botUsername: string;
  teamName?: string;
}

/**
 * Resolve the Slack bot username and team name from credential metadata.
 * Mirrors the metadata parsing pattern in `config-slack-channel.ts`.
 */
function resolveSlackBotInfo(): SlackBotInfo | undefined {
  const meta = getCredentialMetadata("slack_channel", "bot_token");
  if (!meta?.accountInfo) return undefined;

  try {
    const parsed = JSON.parse(meta.accountInfo) as {
      botUsername?: string;
      teamName?: string;
    };
    if (!parsed.botUsername) return undefined;
    return {
      botUsername: parsed.botUsername,
      teamName: parsed.teamName,
    };
  } catch {
    return undefined;
  }
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
