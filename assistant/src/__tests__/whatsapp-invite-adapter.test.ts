/**
 * Tests for the WhatsApp channel invite adapter.
 *
 * WhatsApp uses Meta WhatsApp Business API, not Twilio. The display phone
 * number is resolved from workspace config (`whatsapp.phoneNumber`), falling
 * back to undefined (triggering generic instructions) when not configured.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the adapter
// ---------------------------------------------------------------------------

let mockWhatsAppPhoneNumber: string | undefined;
let mockGetConfigThrows = false;

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => ({}),
  getConfig: () => {
    if (mockGetConfigThrows) throw new Error("config not found");
    return { whatsapp: { phoneNumber: mockWhatsAppPhoneNumber ?? "" } };
  },
  invalidateConfigCache: () => {},
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { whatsappInviteAdapter } from "../runtime/channel-invite-transports/whatsapp.js";
import { resolveWhatsAppDisplayNumber } from "../runtime/channel-invite-transports/whatsapp.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("whatsapp invite adapter", () => {
  beforeEach(() => {
    mockWhatsAppPhoneNumber = undefined;
    mockGetConfigThrows = false;
  });

  test("adapter is registered for the whatsapp channel", () => {
    expect(whatsappInviteAdapter.channel).toBe("whatsapp");
  });

  // -------------------------------------------------------------------------
  // Handle resolution — configured path
  // -------------------------------------------------------------------------

  test("returns configured phone number from workspace config", () => {
    mockWhatsAppPhoneNumber = "+15551234567";
    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBe("+15551234567");
  });

  test("resolveWhatsAppDisplayNumber returns configured number", () => {
    mockWhatsAppPhoneNumber = "+15559876543";
    expect(resolveWhatsAppDisplayNumber()).toBe("+15559876543");
  });

  // -------------------------------------------------------------------------
  // Handle resolution — unconfigured fallback
  // -------------------------------------------------------------------------

  test("returns undefined when whatsapp config is missing", () => {
    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBeUndefined();
  });

  test("returns undefined when phoneNumber is empty string", () => {
    mockWhatsAppPhoneNumber = "";
    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBeUndefined();
  });

  test("returns undefined when config loading throws", () => {
    mockGetConfigThrows = true;
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
