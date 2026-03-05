/**
 * SMS channel invite adapter.
 *
 * Resolves the assistant's Twilio phone number for use in invite
 * instructions. SMS invites use the universal 6-digit code path for
 * redemption, so this adapter only implements `resolveChannelHandle` —
 * no `buildShareLink` or `extractInboundToken` needed.
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
 * Keep Twilio-backed invite transports on a single secure-key reader so the
 * credential boundary stays narrow even as SMS and WhatsApp share resolution.
 */
export function resolveTwilioInvitePhoneNumber(options?: {
  includeWhatsappOverride?: boolean;
}): string | undefined {
  try {
    const raw = loadRawConfig();
    const smsConfig = (raw?.sms ?? {}) as Record<string, unknown>;
    const whatsappConfig = options?.includeWhatsappOverride
      ? ((raw?.whatsapp ?? {}) as Record<string, unknown>)
      : undefined;
    return (
      getTwilioPhoneNumberEnv() ||
      (whatsappConfig?.phoneNumber as string | undefined) ||
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

export const smsInviteAdapter: ChannelInviteAdapter = {
  channel: "sms" as ChannelId,

  resolveChannelHandle(): string | undefined {
    return resolveTwilioInvitePhoneNumber();
  },
};
