/**
 * Email channel invite adapter.
 *
 * Resolves the assistant's email address for use in invite instructions.
 * Uses the EmailService's cached primary inbox lookup so the real address
 * is returned when an inbox is configured. Falls back to `undefined` when
 * no inbox exists, which causes the invite instruction generator to emit
 * generic "on Email" wording instead of a misleading stub address.
 *
 * Email invites use the universal 6-digit code path for redemption, so
 * this adapter only implements `resolveChannelHandleAsync` — no
 * `buildShareLink` or `extractInboundToken` needed.
 */

import { getEmailService } from "../../email/service.js";
import type { ChannelInviteAdapter } from "../channel-invite-transport.js";

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const emailInviteAdapter: ChannelInviteAdapter = {
  channel: "email",

  async resolveChannelHandleAsync(): Promise<string | undefined> {
    return getEmailService().getPrimaryInboxAddress();
  },
};
