/**
 * WhatsApp channel invite adapter.
 *
 * Resolves the assistant's WhatsApp phone number for use in invite
 * instructions. WhatsApp invites use the universal 6-digit code path
 * for redemption, so this adapter only implements `resolveChannelHandle`
 * — no `buildShareLink` or `extractInboundToken` needed.
 *
 * WhatsApp shares the same Twilio phone number as SMS, so the
 * resolution strategy mirrors the SMS adapter.
 */

import type { ChannelId } from "../../channels/types.js";
import type { ChannelInviteAdapter } from "../channel-invite-transport.js";
import { resolveTwilioInvitePhoneNumber } from "./sms.js";

// ---------------------------------------------------------------------------
// Phone number resolution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const whatsappInviteAdapter: ChannelInviteAdapter = {
  channel: "whatsapp" as ChannelId,

  resolveChannelHandle(): string | undefined {
    return resolveTwilioInvitePhoneNumber({ includeWhatsappOverride: true });
  },
};
