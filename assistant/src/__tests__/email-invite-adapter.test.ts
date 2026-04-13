/**
 * Tests for the email invite adapter.
 *
 * Verifies that the email adapter resolves the assistant's email address
 * from workspace config and falls back to `undefined` when no address
 * is configured.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock the config loader
// ---------------------------------------------------------------------------

let mockConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => mockConfig,
  getNestedValue: (obj: Record<string, unknown>, path: string) => {
    const keys = path.split(".");
    let current: unknown = obj;
    for (const key of keys) {
      if (current == null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  },
  getConfig: () => ({}),
  saveRawConfig: () => {},
  setNestedValue: () => {},
}));

import { resolveAdapterHandle } from "../runtime/channel-invite-transport.js";
import { emailInviteAdapter } from "../runtime/channel-invite-transports/email.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("emailInviteAdapter", () => {
  beforeEach(() => {
    mockConfig = {};
  });

  afterEach(() => {
    mockConfig = {};
  });

  test("returns configured email address via resolveChannelHandleAsync", async () => {
    mockConfig = { email: { address: "hello@vellum.me" } };

    const handle = await resolveAdapterHandle(emailInviteAdapter);
    expect(handle).toBe("hello@vellum.me");
  });

  test("returns undefined when no address is configured", async () => {
    mockConfig = {};

    const handle = await resolveAdapterHandle(emailInviteAdapter);
    expect(handle).toBeUndefined();
  });

  test("returns undefined when email.address is empty string", async () => {
    mockConfig = { email: { address: "" } };

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
