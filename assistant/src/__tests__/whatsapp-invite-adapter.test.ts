/**
 * Tests for the WhatsApp channel invite adapter.
 *
 * Verifies handle resolution in both configured-handle and
 * generic-instruction (no handle) paths.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the adapter
// ---------------------------------------------------------------------------

let mockTwilioPhoneNumberEnv: string | undefined;
let mockRawConfig: Record<string, unknown> | undefined;
let mockSecureKeys: Record<string, string>;

mock.module("../config/env.js", () => ({
  getTwilioPhoneNumberEnv: () => mockTwilioPhoneNumberEnv,
}));

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => mockRawConfig,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (key: string) => mockSecureKeys[key] ?? null,
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { whatsappInviteAdapter } from "../runtime/channel-invite-transports/whatsapp.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("whatsapp invite adapter", () => {
  beforeEach(() => {
    mockTwilioPhoneNumberEnv = undefined;
    mockRawConfig = undefined;
    mockSecureKeys = {};
  });

  test("adapter is registered for the whatsapp channel", () => {
    expect(whatsappInviteAdapter.channel).toBe("whatsapp");
  });

  // -------------------------------------------------------------------------
  // Configured-handle path
  // -------------------------------------------------------------------------

  test("resolves handle from env override", () => {
    mockTwilioPhoneNumberEnv = "+15551234567";

    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBe("+15551234567");
  });

  test("resolves handle from whatsapp config phoneNumber", () => {
    mockRawConfig = { whatsapp: { phoneNumber: "+15559876543" } };

    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBe("+15559876543");
  });

  test("resolves handle from sms config phoneNumber as fallback", () => {
    mockRawConfig = { sms: { phoneNumber: "+15550001111" } };

    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBe("+15550001111");
  });

  test("prefers whatsapp config over sms config", () => {
    mockRawConfig = {
      whatsapp: { phoneNumber: "+15551111111" },
      sms: { phoneNumber: "+15552222222" },
    };

    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBe("+15551111111");
  });

  test("resolves handle from secure key fallback", () => {
    mockSecureKeys = { "credential:twilio:phone_number": "+15553334444" };
    mockRawConfig = {};

    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBe("+15553334444");
  });

  test("env override takes precedence over all other sources", () => {
    mockTwilioPhoneNumberEnv = "+15550000000";
    mockRawConfig = { whatsapp: { phoneNumber: "+15551111111" } };
    mockSecureKeys = { "credential:twilio:phone_number": "+15552222222" };

    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBe("+15550000000");
  });

  // -------------------------------------------------------------------------
  // Generic-instruction path (no handle configured)
  // -------------------------------------------------------------------------

  test("returns undefined when no phone number is configured", () => {
    mockRawConfig = {};

    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBeUndefined();
  });

  test("returns undefined when no sources are available at all", () => {
    // No env, no config, no secure keys — the adapter degrades gracefully
    mockRawConfig = undefined;

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
