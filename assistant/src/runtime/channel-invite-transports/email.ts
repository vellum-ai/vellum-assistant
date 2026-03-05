/**
 * Email channel invite adapter.
 *
 * Resolves the assistant's email address for use in invite instructions.
 * Email invites use the universal 6-digit code path for redemption, so
 * this adapter only implements `resolveChannelHandle` — no `buildShareLink`
 * or `extractInboundToken` needed.
 */

import type { ChannelInviteAdapter } from "../channel-invite-transport.js";

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

  resolveChannelHandle(): string | undefined {
    return resolveAssistantEmailAddress();
  },
};
