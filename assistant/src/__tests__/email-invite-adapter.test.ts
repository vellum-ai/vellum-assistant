/**
 * Tests for the email invite adapter.
 *
 * Verifies that the email adapter resolves the assistant's real inbox
 * address when one is configured and falls back to `undefined` (triggering
 * generic invite instructions) when no inbox exists.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { resolveAdapterHandle } from "../runtime/channel-invite-transport.js";
import { emailInviteAdapter } from "../runtime/channel-invite-transports/email.js";

// ---------------------------------------------------------------------------
// Mock the EmailService singleton
// ---------------------------------------------------------------------------

let mockPrimaryAddress: string | undefined;

mock.module("../email/service.js", () => ({
  getEmailService: () => ({
    getPrimaryInboxAddress: async () => mockPrimaryAddress,
  }),
  // Re-export other symbols that callers might need
  EmailService: class {},
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("emailInviteAdapter", () => {
  beforeEach(() => {
    mockPrimaryAddress = undefined;
  });

  afterEach(() => {
    mockPrimaryAddress = undefined;
  });

  test("returns configured email address via resolveChannelHandleAsync", async () => {
    mockPrimaryAddress = "hello@mycompany.agentmail.to";

    const handle = await resolveAdapterHandle(emailInviteAdapter);
    expect(handle).toBe("hello@mycompany.agentmail.to");
  });

  test("returns undefined when no inbox is configured", async () => {
    mockPrimaryAddress = undefined;

    const handle = await resolveAdapterHandle(emailInviteAdapter);
    expect(handle).toBeUndefined();
  });

  test("adapter channel is email", () => {
    expect(emailInviteAdapter.channel).toBe("email");
  });

  test("does not define sync resolveChannelHandle", () => {
    // The email adapter uses the async path exclusively
    expect(emailInviteAdapter.resolveChannelHandle).toBeUndefined();
  });

  test("does not define buildShareLink or extractInboundToken", () => {
    expect(emailInviteAdapter.buildShareLink).toBeUndefined();
    expect(emailInviteAdapter.extractInboundToken).toBeUndefined();
  });

  test("returns config fallback address when provider has no inboxes", async () => {
    // Simulates the config fallback: provider returns no inboxes, but
    // email.address is set in workspace config. The service's
    // getPrimaryInboxAddress() should return the configured address.
    mockPrimaryAddress = "configured@example.com";

    const handle = await resolveAdapterHandle(emailInviteAdapter);
    expect(handle).toBe("configured@example.com");
  });
});
