/**
 * Voice channel invite adapter.
 *
 * Voice invites are identity-bound: the invitee must call from a specific
 * phone number and enter a numeric code. Unlike Telegram invites, there is
 * no shareable deep link — the guardian relays the code and calling
 * instructions verbally or via another channel.
 *
 * The adapter builds human-readable instruction text and provides a
 * no-op token extractor since voice invite redemption uses the dedicated
 * voice-code path rather than generic token extraction.
 */

import type { ChannelId } from "../../channels/types.js";
import type {
  ChannelInviteAdapter,
  InviteShareLink,
} from "../channel-invite-types.js";

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const voiceInviteAdapter: ChannelInviteAdapter = {
  channel: "phone" as ChannelId,

  buildShareLink(_params: {
    rawToken: string;
    sourceChannel: ChannelId;
  }): InviteShareLink {
    // Voice invites do not produce a clickable URL. The "url" field contains
    // a placeholder — callers should use displayText for presentation.
    return {
      url: "",
      displayText: [
        "Voice invite created.",
        "The invitee must call the assistant's phone number from the authorized number and enter their invite code when prompted.",
      ].join(" "),
    };
  },

  extractInboundToken(_params: {
    commandIntent?: import("@vellumai/gateway-client").CommandIntent;
    content: string;
    sourceMetadata?: import("@vellumai/gateway-client").SourceMetadata;
  }): string | undefined {
    // Voice invite redemption bypasses generic token extraction — it uses
    // the gateway's identity-bound voice-code redemption engine.
    return undefined;
  },
};
