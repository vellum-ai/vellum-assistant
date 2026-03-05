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
import { getTwilioPhoneNumberEnv } from "../../config/env.js";
import { loadRawConfig } from "../../config/loader.js";
import { getSecureKey } from "../../security/secure-keys.js";
import type { ChannelInviteAdapter } from "../channel-invite-transport.js";

// ---------------------------------------------------------------------------
// Phone number resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the WhatsApp phone number with canonical precedence:
 * env override -> config whatsapp.phoneNumber -> config sms.phoneNumber
 * -> secure key fallback.
 *
 * WhatsApp typically shares the Twilio phone number with SMS, but
 * allows a channel-specific override via config.
 */
function resolveWhatsAppPhoneNumber(): string | undefined {
  try {
    const raw = loadRawConfig();
    const whatsappConfig = (raw?.whatsapp ?? {}) as Record<string, unknown>;
    const smsConfig = (raw?.sms ?? {}) as Record<string, unknown>;
    return (
      getTwilioPhoneNumberEnv() ||
      (whatsappConfig.phoneNumber as string) ||
      (smsConfig.phoneNumber as string) ||
      getSecureKey("credential:twilio:phone_number") ||
      undefined
    );
  } catch {
    return (
      getTwilioPhoneNumberEnv() ||
      getSecureKey("credential:twilio:phone_number") ||
      undefined
    );
  }
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const whatsappInviteAdapter: ChannelInviteAdapter = {
  channel: "whatsapp" as ChannelId,

  resolveChannelHandle(): string | undefined {
    return resolveWhatsAppPhoneNumber();
  },
};
