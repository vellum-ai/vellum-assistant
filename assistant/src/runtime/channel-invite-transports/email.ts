/**
 * Email channel invite adapter.
 *
 * Provides guardian instruction text for email-based invites. Email invites
 * use the universal 6-digit code path for redemption, so this adapter only
 * implements `buildGuardianInstruction` — no `buildShareLink` or
 * `extractInboundToken` needed.
 */

import type {
  ChannelInviteAdapter,
  GuardianInstruction,
} from "../channel-invite-transport.js";

// ---------------------------------------------------------------------------
// Email address resolution
// ---------------------------------------------------------------------------

// TODO: resolve from AgentMail provider (async — needs caching or pre-resolution)
// The real implementation requires async inbox lookup via
// `getActiveEmailProvider().health()` which doesn't fit the sync adapter
// interface.
function resolveAssistantEmailAddress(): string | undefined {
  return undefined;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const emailInviteAdapter: ChannelInviteAdapter = {
  channel: "email",

  buildGuardianInstruction(params: {
    inviteCode: string;
    contactName?: string;
  }): GuardianInstruction {
    const address = resolveAssistantEmailAddress();
    const contactLabel = params.contactName || "the contact";
    if (!address) {
      return {
        instruction: `Tell ${contactLabel} to email the assistant and include the code ${params.inviteCode} in the message.`,
      };
    }
    return {
      instruction: `Tell ${contactLabel} to email ${address} and include the code ${params.inviteCode} in the message.`,
      channelHandle: address,
    };
  },

  resolveChannelHandle(): string | undefined {
    return resolveAssistantEmailAddress();
  },
};
