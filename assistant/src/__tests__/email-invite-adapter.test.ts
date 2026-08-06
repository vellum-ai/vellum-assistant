/**
 * Tests for the email invite adapter.
 *
 * Verifies that the email adapter resolves the assistant's email address
 * from workspace config and falls back to `undefined` when no address
 * is configured.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { resolveAdapterHandle } from "../runtime/channel-invite-transport.js";
import { emailInviteAdapter } from "../runtime/channel-invite-transports/email.js";
import { setConfig } from "./helpers/set-config.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("emailInviteAdapter", () => {
  beforeEach(() => {
    // The adapter reads the raw workspace config; reset the `email` key so
    // each test starts without a configured address.
    setConfig("email", {});
  });

  test("returns configured email address via resolveChannelHandleAsync", async () => {
    setConfig("email", { address: "user@example.com" });

    const handle = await resolveAdapterHandle(emailInviteAdapter);
    expect(handle).toBe("user@example.com");
  });

  test("returns undefined when no address is configured", async () => {
    const handle = await resolveAdapterHandle(emailInviteAdapter);
    expect(handle).toBeUndefined();
  });

  test("returns undefined when email.address is empty string", async () => {
    setConfig("email", { address: "" });

    const handle = await resolveAdapterHandle(emailInviteAdapter);
    expect(handle).toBeUndefined();
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
