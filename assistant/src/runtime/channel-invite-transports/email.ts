/**
 * Email channel invite adapter.
 *
 * Resolves the assistant's email address for use in invite instructions.
 * Reads the address from workspace config (`email.address`). Returns
 * `undefined` when no address is configured, which causes the invite
 * instruction generator to emit generic "on Email" wording.
 *
 * Email invites use the universal 6-digit code path for redemption, so
 * this adapter only implements `resolveChannelHandleAsync` — no
 * `buildShareLink` or `extractInboundToken` needed.
 */

import { getNestedValue, loadRawConfig } from "../../config/loader.js";
import type { ChannelInviteAdapter } from "../channel-invite-transport.js";

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const emailInviteAdapter: ChannelInviteAdapter = {
  channel: "email",

  async resolveChannelHandleAsync(): Promise<string | undefined> {
    try {
      const raw = loadRawConfig();
      const address = getNestedValue(raw, "email.address");
      if (typeof address === "string" && address.length > 0) {
        return address;
      }
    } catch {
      // Config unavailable
    }
    return undefined;
  },
};
