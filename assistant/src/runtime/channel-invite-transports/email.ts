/**
 * Email channel invite adapter.
 *
 * Resolves the assistant's email address for use in invite instructions.
 * The address is a managed inbox registration, which lives on the platform
 * (nothing about one lands in workspace config), so it resolves through the
 * shared registered-inbox reader. Returns `undefined` when no address is
 * registered or the platform cannot be asked, which causes the invite
 * instruction generator to emit generic "on Email" wording.
 *
 * Email invites use the universal 6-digit code path for redemption, so
 * this adapter only implements `resolveChannelHandleAsync`, with no
 * `buildShareLink` or `extractInboundToken` needed.
 */

import { resolveRegisteredInbox } from "../../email/registered-inbox.js";
import type { ChannelInviteAdapter } from "../channel-invite-types.js";

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const emailInviteAdapter: ChannelInviteAdapter = {
  channel: "email",

  async resolveChannelHandleAsync(): Promise<string | undefined> {
    try {
      const inbox = await resolveRegisteredInbox();
      if (inbox.status === "registered") {
        return inbox.address;
      }
    } catch {
      // Platform unavailable; fall through to generic wording
    }
    return undefined;
  },
};
