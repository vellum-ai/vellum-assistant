/**
 * Discord channel invite adapter.
 *
 * Resolves the assistant's Discord bot username for use in invite
 * instructions. Discord invites use the universal 6-digit code path for
 * redemption, so this adapter only implements `resolveChannelHandle`,
 * no `buildShareLink` or `extractInboundToken` needed. The platform
 * constraint that shapes the instruction copy lives with the copy
 * (`invite-instruction-generator.ts`): a person can only DM the bot once
 * they share a server with it.
 */

import type { ChannelId } from "../../channels/types.js";
import { getConfig } from "../../config/loader.js";
import type { ChannelInviteAdapter } from "../channel-invite-types.js";

export const discordInviteAdapter: ChannelInviteAdapter = {
  channel: "discord" as ChannelId,

  resolveChannelHandle(): string | undefined {
    const { botUsername } = getConfig().discord;
    if (!botUsername) {
      return undefined;
    }
    return `@${botUsername}`;
  },
};
