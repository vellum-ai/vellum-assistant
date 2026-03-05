/**
 * SMS channel invite adapter.
 *
 * Provides guardian instruction text that includes the assistant's Twilio
 * phone number. SMS invites use the universal 6-digit code path for
 * redemption, so this adapter only implements `buildGuardianInstruction` —
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
 * Resolve the SMS phone number with canonical precedence:
 * env override -> config sms.phoneNumber -> secure key fallback.
 * Mirrors the resolution strategy in `channel-readiness-service.ts`.
 */
function resolveSmsPhoneNumber(): string | undefined {
  try {
    const raw = loadRawConfig();
    const smsConfig = (raw?.sms ?? {}) as Record<string, unknown>;
    return (
      getTwilioPhoneNumberEnv() ||
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

  buildGuardianInstruction(params: {
    inviteCode: string;
    contactName?: string;
  }): string {
    const phoneNumber = resolveSmsPhoneNumber();
    const contactLabel = params.contactName || "the contact";
    if (!phoneNumber) {
      return `Tell ${contactLabel} to text the assistant and provide the code ${params.inviteCode}.`;
    }
    return `Tell ${contactLabel} to text ${phoneNumber} and provide the code ${params.inviteCode}.`;
  },
};
