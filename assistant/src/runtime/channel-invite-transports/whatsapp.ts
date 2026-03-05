/**
 * WhatsApp channel invite adapter.
 *
 * WhatsApp uses Meta WhatsApp Business API credentials, not Twilio.
 * The Meta API identifies numbers by phone_number_id (a numeric string),
 * which isn't a user-facing phone number. Since we can't resolve a
 * display number from Meta credentials alone, the adapter returns
 * `undefined` — triggering the generic instruction path for invites.
 */

import type { ChannelId } from "../../channels/types.js";
import type { ChannelInviteAdapter } from "../channel-invite-transport.js";

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const whatsappInviteAdapter: ChannelInviteAdapter = {
  channel: "whatsapp" as ChannelId,

  resolveChannelHandle(): string | undefined {
    // Meta WhatsApp Business API uses phone_number_id, not a displayable
    // phone number. Return undefined to fall back to generic instructions.
    return undefined;
  },
};
