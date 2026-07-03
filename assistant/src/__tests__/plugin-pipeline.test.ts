import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the conversation scope resolver so the pipeline's conversationId-based
// scoping can be exercised without a live conversation or DB row.
const resolveScopeMock = mock(
  (_conversationId: string): Set<string> | null => null,
);
mock.module("../daemon/conversation-plugin-scope.js", () => ({
  resolveConversationPluginScope: (id: string) => resolveScopeMock(id),
}));

import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";

beforeEach(() => {
  resetPluginRegistryForTests();
  resolveScopeMock.mockReset();
  resolveScopeMock.mockImplementation(() => null);
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

    // The threaded mutation is preserved. The pipeline also stamps a
    // `broadcast` capability onto every hook context, so assert the field
    // rather than an exact shape.
    expect(result).toMatchObject({ value: 2 });
    expect(typeof (result as { broadcast?: unknown }).broadcast).toBe(
      "function",
    );
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
    resolveScopeMock.mockImplementation((conversationId: string) =>
      conversationId === "c1" ? new Set(["in-scope"]) : null,
    );

    // A context carrying conversationId resolves the scope and skips the
    // out-of-scope plugin's hook.
    const scoped = await runHook<{ conversationId: string; seen: string[] }>(
      "user-prompt-submit",
      { conversationId: "c1", seen: [] },
    );
    expect(scoped.seen).toEqual(["in-scope"]);
    expect(resolveScopeMock).toHaveBeenCalledWith("c1");

    // A context without a conversationId is never resolved and imposes no
    // restriction.
    resolveScopeMock.mockClear();
    const unscoped = await runHook<{ seen: string[] }>("user-prompt-submit", {
      seen: [],
    });
    expect(unscoped.seen).toEqual(["in-scope", "out-scope"]);
    expect(resolveScopeMock).not.toHaveBeenCalled();
  });

  test("imposes no restriction when the resolver returns null", async () => {
    registerSeenHook("plugin-a");
    registerSeenHook("plugin-b");
    resolveScopeMock.mockImplementation(() => null);

    const result = await runHook<{ conversationId: string; seen: string[] }>(
      "user-prompt-submit",
      { conversationId: "c1", seen: [] },
    );
    expect(result.seen).toEqual(["plugin-a", "plugin-b"]);
  });
});

describe("plugin pipeline — originalMessages isolation", () => {
  test("mutating latestMessages does not affect originalMessages", async () => {
    registerPlugin({
      manifest: { name: "truncate-hook", version: "1.0.0" },
      hooks: {
        "user-prompt-submit": async (ctx: {
          originalMessages: string[];
          latestMessages: string[];
        }) => {
          ctx.latestMessages.length = 0;
        },
      },
    });

    const messages = ["hello", "world"];
    const result = await runHook<{
      originalMessages: string[];
      latestMessages: string[];
    }>("user-prompt-submit", {
      originalMessages: Object.freeze([...messages]),
      latestMessages: messages,
    });

    expect(result.latestMessages).toEqual([]);
    expect(result.originalMessages).toEqual(["hello", "world"]);
  });
});
