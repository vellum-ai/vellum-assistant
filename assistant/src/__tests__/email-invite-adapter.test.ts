/**
 * Tests for the email invite adapter.
 *
 * Verifies that the email adapter resolves the assistant's address from the
 * shared registered-inbox reader (the platform is the only writer of managed
 * inbox registrations) and falls back to `undefined` when no address is
 * registered or the platform cannot be asked.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { RegisteredInboxState } from "../email/registered-inbox.js";

let mockInboxState: RegisteredInboxState;
let mockResolveThrows: boolean;

mock.module("../email/registered-inbox.js", () => ({
  resolveRegisteredInbox: async () => {
    if (mockResolveThrows) {
      throw new Error("resolver unavailable");
    }
    return mockInboxState;
  },
  invalidateRegisteredInboxCache: () => {},
}));

import { resolveAdapterHandle } from "../runtime/channel-invite-transport.js";
import { emailInviteAdapter } from "../runtime/channel-invite-transports/email.js";
import { setConfig } from "./helpers/set-config.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("emailInviteAdapter", () => {
  beforeEach(() => {
    mockInboxState = { status: "none" };
    mockResolveThrows = false;
  });

  test("returns the registered address via resolveChannelHandleAsync", async () => {
    mockInboxState = { status: "registered", address: "user@example.com" };

    const handle = await resolveAdapterHandle(emailInviteAdapter);
    expect(handle).toBe("user@example.com");
  });

  test("returns undefined when no inbox is registered", async () => {
    const handle = await resolveAdapterHandle(emailInviteAdapter);
    expect(handle).toBeUndefined();
  });

  test("returns undefined when the platform is not connected", async () => {
    mockInboxState = { status: "no_platform" };

    const handle = await resolveAdapterHandle(emailInviteAdapter);
    expect(handle).toBeUndefined();
  });

  test("returns undefined when the platform cannot be asked", async () => {
    mockInboxState = { status: "unavailable", detail: "HTTP 503" };

    const handle = await resolveAdapterHandle(emailInviteAdapter);
    expect(handle).toBeUndefined();
  });

  test("returns undefined when the resolver throws", async () => {
    mockResolveThrows = true;

    const handle = await resolveAdapterHandle(emailInviteAdapter);
    expect(handle).toBeUndefined();
  });

  test("a local email.address config value cannot supply the handle", async () => {
    // Registration lives on the platform; a stray config value (a key
    // nothing writes) must not surface as the assistant's address.
    setConfig("email", { address: "stale@example.com" });
    mockInboxState = { status: "none" };

    const handle = await resolveAdapterHandle(emailInviteAdapter);
    expect(handle).toBeUndefined();

    setConfig("email", {});
  });

  test("adapter channel is email", () => {
    expect(emailInviteAdapter.channel).toBe("email");
  });

  test("does not define sync resolveChannelHandle", () => {
    expect(emailInviteAdapter.resolveChannelHandle).toBeUndefined();
  });

  test("does not define buildShareLink or extractInboundToken", () => {
    expect(emailInviteAdapter.buildShareLink).toBeUndefined();
    expect(emailInviteAdapter.extractInboundToken).toBeUndefined();
  });
});
