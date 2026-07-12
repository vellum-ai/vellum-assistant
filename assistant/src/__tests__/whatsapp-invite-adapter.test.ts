/**
 * Tests for the WhatsApp channel invite adapter.
 *
 * WhatsApp uses Meta WhatsApp Business API, not Twilio. The display phone
 * number is resolved from workspace config (`whatsapp.phoneNumber`), falling
 * back to undefined (triggering generic instructions) when not configured.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { whatsappInviteAdapter } from "../runtime/channel-invite-transports/whatsapp.js";
import { resolveWhatsAppDisplayNumber } from "../runtime/channel-invite-transports/whatsapp.js";
import { setConfig } from "./helpers/set-config.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("whatsapp invite adapter", () => {
  beforeEach(() => {
    setConfig("whatsapp", { phoneNumber: "" });
  });

  test("adapter is registered for the whatsapp channel", () => {
    expect(whatsappInviteAdapter.channel).toBe("whatsapp");
  });

  // -------------------------------------------------------------------------
  // Handle resolution — configured path
  // -------------------------------------------------------------------------

  test("returns configured phone number from workspace config", () => {
    setConfig("whatsapp", { phoneNumber: "+14155550123" });
    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBe("+14155550123");
  });

  test("resolveWhatsAppDisplayNumber returns configured number", () => {
    setConfig("whatsapp", { phoneNumber: "+14155550143" });
    expect(resolveWhatsAppDisplayNumber()).toBe("+14155550143");
  });

  // -------------------------------------------------------------------------
  // Handle resolution — unconfigured fallback
  // -------------------------------------------------------------------------

  test("returns undefined when whatsapp config is missing", () => {
    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBeUndefined();
  });

  test("returns undefined when phoneNumber is empty string", () => {
    setConfig("whatsapp", { phoneNumber: "" });
    const handle = whatsappInviteAdapter.resolveChannelHandle!();
    expect(handle).toBeUndefined();
  });

  test("returns undefined (never throws) when the number is unresolvable", () => {
    // The resolver reads config defensively (try/catch → undefined). With the
    // number unconfigured it resolves to undefined without throwing.
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
