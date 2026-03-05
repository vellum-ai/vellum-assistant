/**
 * Tests for channel invite adapter handle resolution.
 *
 * Verifies that `resolveAdapterHandle()` correctly prefers the async
 * path when available and falls back to the sync path for adapters
 * that only implement `resolveChannelHandle`.
 */
import { describe, expect, test } from "bun:test";

import type { ChannelInviteAdapter } from "../runtime/channel-invite-transport.js";
import { resolveAdapterHandle } from "../runtime/channel-invite-transport.js";

describe("resolveAdapterHandle", () => {
  test("returns sync handle when only resolveChannelHandle is defined", async () => {
    const adapter: ChannelInviteAdapter = {
      channel: "telegram",
      resolveChannelHandle: () => "@mybot",
    };

    const handle = await resolveAdapterHandle(adapter);
    expect(handle).toBe("@mybot");
  });

  test("returns undefined when sync resolveChannelHandle returns undefined", async () => {
    const adapter: ChannelInviteAdapter = {
      channel: "email",
      resolveChannelHandle: () => undefined,
    };

    const handle = await resolveAdapterHandle(adapter);
    expect(handle).toBeUndefined();
  });

  test("returns undefined when adapter has no handle resolution methods", async () => {
    const adapter: ChannelInviteAdapter = {
      channel: "slack",
    };

    const handle = await resolveAdapterHandle(adapter);
    expect(handle).toBeUndefined();
  });

  test("returns async handle when only resolveChannelHandleAsync is defined", async () => {
    const adapter: ChannelInviteAdapter = {
      channel: "email",
      resolveChannelHandleAsync: async () => "hello@assistant.agentmail.to",
    };

    const handle = await resolveAdapterHandle(adapter);
    expect(handle).toBe("hello@assistant.agentmail.to");
  });

  test("prefers async over sync when both are defined", async () => {
    const adapter: ChannelInviteAdapter = {
      channel: "email",
      resolveChannelHandle: () => "sync-handle",
      resolveChannelHandleAsync: async () => "async-handle",
    };

    const handle = await resolveAdapterHandle(adapter);
    expect(handle).toBe("async-handle");
  });

  test("returns undefined when async resolveChannelHandleAsync returns undefined", async () => {
    const adapter: ChannelInviteAdapter = {
      channel: "whatsapp",
      resolveChannelHandleAsync: async () => undefined,
    };

    const handle = await resolveAdapterHandle(adapter);
    expect(handle).toBeUndefined();
  });
});
