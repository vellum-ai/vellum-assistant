/**
 * Tests for the WhatsApp channel invite adapter.
 *
 * WhatsApp uses Meta WhatsApp Business API, not Twilio. The adapter
 * cannot resolve a user-facing phone number from Meta credentials
 * alone, so it always returns undefined (triggering generic instructions).
 */
import { describe, expect, test } from "bun:test";

import { whatsappInviteAdapter } from "../runtime/channel-invite-transports/whatsapp.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("whatsapp invite adapter", () => {
  test("adapter is registered for the whatsapp channel", () => {
    expect(whatsappInviteAdapter.channel).toBe("whatsapp");
  });

  // -------------------------------------------------------------------------
  // Handle resolution — always undefined for Meta WhatsApp
  // -------------------------------------------------------------------------

  test("returns undefined because Meta API has no displayable phone number", () => {
    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Adapter shape
  // -------------------------------------------------------------------------

  test("does not implement buildShareLink", () => {
    expect(whatsappInviteAdapter.buildShareLink).toBeUndefined();
  });

  test("does not implement extractInboundToken", () => {
    expect(whatsappInviteAdapter.extractInboundToken).toBeUndefined();
  });
});
