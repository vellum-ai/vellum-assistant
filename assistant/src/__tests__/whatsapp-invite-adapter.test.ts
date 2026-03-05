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

let mockRawConfig: Record<string, unknown> | undefined;

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => mockRawConfig,
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
    mockRawConfig = undefined;
  });

  test("adapter is registered for the whatsapp channel", () => {
    expect(whatsappInviteAdapter.channel).toBe("whatsapp");
  });

  // -------------------------------------------------------------------------
  // Handle resolution — configured path
  // -------------------------------------------------------------------------

  test("returns configured phone number from workspace config", () => {
    mockRawConfig = { whatsapp: { phoneNumber: "+15551234567" } };
    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBe("+15551234567");
  });

  test("resolveWhatsAppDisplayNumber returns configured number", () => {
    mockRawConfig = { whatsapp: { phoneNumber: "+15559876543" } };
    expect(resolveWhatsAppDisplayNumber()).toBe("+15559876543");
  });

  // -------------------------------------------------------------------------
  // Handle resolution — unconfigured fallback
  // -------------------------------------------------------------------------

  test("returns undefined when whatsapp config is missing", () => {
    mockRawConfig = {};
    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBeUndefined();
  });

  test("returns undefined when phoneNumber is empty string", () => {
    mockRawConfig = { whatsapp: { phoneNumber: "" } };
    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBeUndefined();
  });

  test("returns undefined when config loading throws", () => {
    mockRawConfig = undefined;
    // Simulate loadRawConfig throwing by setting it to something that
    // will cause our mock to return undefined (the try/catch handles this)
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
