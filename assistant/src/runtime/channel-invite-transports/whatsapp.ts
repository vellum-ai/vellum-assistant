/**
 * WhatsApp channel invite adapter.
 *
 * WhatsApp uses Meta WhatsApp Business API credentials, not Twilio.
 * The Meta API identifies numbers by phone_number_id (a numeric string),
 * which isn't a user-facing phone number. The display number is resolved
 * from workspace config (`whatsapp.phoneNumber`), falling back to
 * `undefined` (triggering generic instructions) when not configured.
 */

import type { ChannelId } from "../../channels/types.js";
import { getConfig } from "../../config/loader.js";
import type { ChannelInviteAdapter } from "../channel-invite-transport.js";

// ---------------------------------------------------------------------------
// Phone number resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the user-configured WhatsApp display phone number from workspace
 * config. The Meta API's `phone_number_id` is not user-facing, so the
 * display number must be explicitly configured by the user.
 */
export function resolveWhatsAppDisplayNumber(): string | undefined {
  try {
    const config = getConfig();
    return config.whatsapp.phoneNumber || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const whatsappInviteAdapter: ChannelInviteAdapter = {
  channel: "whatsapp" as ChannelId,

  resolveChannelHandle(): string | undefined {
    return resolveWhatsAppDisplayNumber();
  },
};
