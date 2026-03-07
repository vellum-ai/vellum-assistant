/**
 * SMS channel invite adapter.
 *
 * Resolves the assistant's Twilio phone number for use in invite
 * instructions. SMS invites use the universal 6-digit code path for
 * redemption, so this adapter only implements `resolveChannelHandle` —
 * no `buildShareLink` or `extractInboundToken` needed.
 */

import { resolveTwilioPhoneNumber } from "../../calls/twilio-config.js";
import type { ChannelId } from "../../channels/types.js";
import type { ChannelInviteAdapter } from "../channel-invite-transport.js";

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const smsInviteAdapter: ChannelInviteAdapter = {
  channel: "sms" as ChannelId,

  resolveChannelHandle(): string | undefined {
    return resolveTwilioPhoneNumber() || undefined;
  },
};
