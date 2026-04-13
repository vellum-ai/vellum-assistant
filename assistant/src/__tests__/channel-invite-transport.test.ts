/**
 * Tests for channel invite adapter resolution and registry wiring.
 *
 * Verifies that `resolveAdapterHandle()` correctly prefers the async
 * path when available and falls back to the sync path for adapters
 * that only implement `resolveChannelHandle`. Also covers the
 * canonical registry APIs (`createInviteAdapterRegistry`,
 * `getInviteAdapterRegistry`) that replaced the deprecated shims.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../email/feature-gate.js", () => ({
  isEmailEnabled: () => true,
}));

import {
  type ChannelInviteAdapter,
  createInviteAdapterRegistry,
  getInviteAdapterRegistry,
  InviteAdapterRegistry,
  resolveAdapterHandle,
} from "../runtime/channel-invite-transport.js";

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
      resolveChannelHandleAsync: async () => "hello@assistant.vellum.me",
    };

    const handle = await resolveAdapterHandle(adapter);
    expect(handle).toBe("hello@assistant.vellum.me");
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

  test("returns undefined when async resolveChannelHandleAsync rejects", async () => {
    const adapter: ChannelInviteAdapter = {
      channel: "email",
      resolveChannelHandleAsync: async () => {
        throw new Error("transient API failure");
      },
    };

    const handle = await resolveAdapterHandle(adapter);
    expect(handle).toBeUndefined();
  });

  test("returns undefined when sync resolveChannelHandle throws", async () => {
    const adapter: ChannelInviteAdapter = {
      channel: "telegram",
      resolveChannelHandle: () => {
        throw new Error("credential lookup failed");
      },
    };

    const handle = await resolveAdapterHandle(adapter);
    expect(handle).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Registry APIs
// ---------------------------------------------------------------------------

describe("createInviteAdapterRegistry", () => {
  const builtInChannels = [
    "email",
    "slack",
    "telegram",
    "phone",
    "whatsapp",
  ] as const;

  test("returns a registry with all built-in adapters registered", () => {
    const registry = createInviteAdapterRegistry();

    for (const channel of builtInChannels) {
      const adapter = registry.get(channel);
      expect(adapter).toBeDefined();
      expect(adapter!.channel).toBe(channel);
    }
  });

  test("getAll returns exactly the built-in adapters", () => {
    const registry = createInviteAdapterRegistry();
    const all = registry.getAll();

    expect(all).toHaveLength(builtInChannels.length);
    const channels = new Set(all.map((a) => a.channel));
    for (const ch of builtInChannels) {
      expect(channels.has(ch)).toBe(true);
    }
  });

  test("returns a new registry instance on each call", () => {
    const a = createInviteAdapterRegistry();
    const b = createInviteAdapterRegistry();
    expect(a).not.toBe(b);
  });
});

describe("getInviteAdapterRegistry", () => {
  test("returns the singleton registry", () => {
    const registry = getInviteAdapterRegistry();
    expect(registry).toBeInstanceOf(InviteAdapterRegistry);
  });

  test("returns the same instance on repeated calls", () => {
    const first = getInviteAdapterRegistry();
    const second = getInviteAdapterRegistry();
    expect(first).toBe(second);
  });
});

describe("InviteAdapterRegistry register / get", () => {
  test("register stores and get retrieves a custom adapter", () => {
    const registry = new InviteAdapterRegistry();
    const custom: ChannelInviteAdapter = {
      channel: "telegram",
      resolveChannelHandle: () => "@custom",
    };

    registry.register(custom);
    expect(registry.get("telegram")).toBe(custom);
  });

  test("register overwrites a previously registered adapter", () => {
    const registry = new InviteAdapterRegistry();
    const first: ChannelInviteAdapter = { channel: "email" };
    const second: ChannelInviteAdapter = {
      channel: "email",
      resolveChannelHandle: () => "new@example.com",
    };

    registry.register(first);
    registry.register(second);
    expect(registry.get("email")).toBe(second);
  });

  test("get returns undefined for an unregistered channel", () => {
    const registry = new InviteAdapterRegistry();
    expect(registry.get("slack")).toBeUndefined();
  });
});
