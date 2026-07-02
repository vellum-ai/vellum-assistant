import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { registerConversationPluginScopeResolver } from "../plugins/enabled-plugin-scope.js";
import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";

beforeEach(() => {
  resetPluginRegistryForTests();
});

describe("plugin pipeline", () => {
  test("logs and skips failed hooks while preserving threaded mutations", async () => {
    registerPlugin({
      manifest: {
        name: "test-first-hook",
        version: "1.0.0",
      },
      hooks: {
        "user-prompt-submit": async () => ({
          value: 1,
        }),
      },
    });
    registerPlugin({
      manifest: {
        name: "test-throwing-hook",
        version: "1.0.0",
      },
      hooks: {
        "user-prompt-submit": async () => {
          throw new Error("hook failed");
        },
      },
    });
    registerPlugin({
      manifest: {
        name: "test-final-hook",
        version: "1.0.0",
      },
      hooks: {
        "user-prompt-submit": async (ctx: { value: number }) => ({
          value: ctx.value + 1,
        }),
      },
    });

    const result = await runHook("user-prompt-submit", { value: 0 });

    expect(result).toEqual({ value: 2 });
  });

  test("discards in-place mutations from a failed hook", async () => {
    registerPlugin({
      manifest: {
        name: "test-first-hook",
        version: "1.0.0",
      },
      hooks: {
        "user-prompt-submit": async (ctx: { items: string[] }) => {
          ctx.items.push("first");
        },
      },
    });
    registerPlugin({
      manifest: {
        name: "test-throwing-hook",
        version: "1.0.0",
      },
      hooks: {
        "user-prompt-submit": async (ctx: { items: string[] }) => {
          ctx.items.push("failed");
          throw new Error("hook failed");
        },
      },
    });
    registerPlugin({
      manifest: {
        name: "test-final-hook",
        version: "1.0.0",
      },
      hooks: {
        "user-prompt-submit": async (ctx: { items: string[] }) => {
          ctx.items.push("final");
        },
      },
    });

    const result = await runHook<{ items: string[] }>("user-prompt-submit", {
      items: [],
    });

    expect(result.items).toEqual(["first", "final"]);
  });
});

describe("plugin pipeline — per-conversation scope", () => {
  afterEach(() => registerConversationPluginScopeResolver(null));

  function registerSeenHook(name: string) {
    registerPlugin({
      manifest: { name, version: "1.0.0" },
      hooks: {
        "user-prompt-submit": async (ctx: { seen: string[] }) => {
          ctx.seen.push(name);
        },
      },
    });
  }

  test("scopes hooks to the resolved set when the context has a conversationId", async () => {
    registerSeenHook("in-scope");
    registerSeenHook("out-scope");
    registerConversationPluginScopeResolver((conversationId) =>
      conversationId === "c1" ? new Set(["in-scope"]) : null,
    );

    // A context carrying conversationId resolves the scope and skips the
    // out-of-scope plugin's hook.
    const scoped = await runHook<{ conversationId: string; seen: string[] }>(
      "user-prompt-submit",
      { conversationId: "c1", seen: [] },
    );
    expect(scoped.seen).toEqual(["in-scope"]);

    // A context without a conversationId imposes no restriction.
    const unscoped = await runHook<{ seen: string[] }>("user-prompt-submit", {
      seen: [],
    });
    expect(unscoped.seen).toEqual(["in-scope", "out-scope"]);
  });

  test("imposes no restriction when no resolver is registered", async () => {
    registerSeenHook("plugin-a");
    registerSeenHook("plugin-b");

    const result = await runHook<{ conversationId: string; seen: string[] }>(
      "user-prompt-submit",
      { conversationId: "c1", seen: [] },
    );
    expect(result.seen).toEqual(["plugin-a", "plugin-b"]);
  });
});
