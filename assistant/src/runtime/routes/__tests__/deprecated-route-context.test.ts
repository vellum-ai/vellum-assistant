/**
 * The deprecated `/x/*` route context is a compatibility shim: each field
 * delegates to a `@vellumai/plugin-api` call and records a one-per-route
 * deprecation-usage telemetry signal. These tests mock the three collaborators
 * (`publishEvent`, `runConversationTurn`, `recordWatchdogEvent`) and assert the
 * delegation, the telemetry payload, and the fire-once dedup.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const publishCalls: Array<{ event: unknown; options: unknown }> = [];
const turnCalls: Array<{ conversationId?: string; content: unknown }> = [];
const watchdogCalls: Array<{
  checkName: string;
  detail?: Record<string, unknown> | null;
}> = [];

mock.module("../../../plugin-api/publish-event.js", () => ({
  publishEvent: async (event: unknown, options: unknown) => {
    publishCalls.push({ event, options });
  },
}));
mock.module("../../../plugin-api/conversation-turn.js", () => ({
  runConversationTurn: async (opts: {
    conversationId?: string;
    content: unknown;
  }) => {
    turnCalls.push(opts);
    return {
      content: [],
      userMessageId: "user-msg-1",
      conversationId: opts.conversationId ?? "generated",
    };
  },
}));
mock.module("../../../telemetry/watchdog-events-store.js", () => ({
  recordWatchdogEvent: (record: {
    checkName: string;
    detail?: Record<string, unknown> | null;
  }) => {
    watchdogCalls.push(record);
  },
}));

const { buildDeprecatedRouteContext } =
  await import("../deprecated-route-context.js");

beforeEach(() => {
  publishCalls.length = 0;
  turnCalls.length = 0;
  watchdogCalls.length = 0;
});

describe("deprecated route context shim", () => {
  test("assistantEventHub.publish forwards to publishEvent and records a signal", async () => {
    const ctx = buildDeprecatedRouteContext("route-publish");
    const event = { id: "e1" } as never;
    const options = { excludeClientId: "tab-1" } as never;

    await ctx.assistantEventHub.publish(event, options);

    expect(publishCalls).toEqual([{ event, options }]);
    expect(watchdogCalls).toHaveLength(1);
    expect(watchdogCalls[0].checkName).toBe("deprecated_api_use");
    expect(watchdogCalls[0].detail).toEqual({
      surface: "custom_route",
      api: "context.assistantEventHub.publish",
      replacement: "plugin-api:publishEvent",
      route_path: "route-publish",
    });
  });

  test("conversations.postMessage runs a turn and returns its user message id", async () => {
    const ctx = buildDeprecatedRouteContext("route-post");

    const result = await ctx.conversations.postMessage("conv-1", "hello there");

    expect(result).toEqual({ messageId: "user-msg-1" });
    expect(turnCalls).toEqual([
      {
        conversationId: "conv-1",
        content: [{ type: "text", text: "hello there" }],
      },
    ]);
    expect(watchdogCalls).toHaveLength(1);
    expect(watchdogCalls[0].detail).toEqual({
      surface: "custom_route",
      api: "context.conversations.postMessage",
      replacement: "plugin-api:runConversationTurn",
      route_path: "route-post",
    });
  });

  test("records the deprecation signal once per route + api (dedup)", async () => {
    const ctx = buildDeprecatedRouteContext("route-dedup");

    await ctx.assistantEventHub.publish({} as never);
    await ctx.assistantEventHub.publish({} as never);
    await ctx.assistantEventHub.publish({} as never);

    // Three calls, but only the first records a telemetry signal.
    expect(publishCalls).toHaveLength(3);
    expect(watchdogCalls).toHaveLength(1);
  });

  test("the context and its members are frozen", () => {
    const ctx = buildDeprecatedRouteContext("route-frozen");
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.assistantEventHub)).toBe(true);
    expect(Object.isFrozen(ctx.conversations)).toBe(true);
  });
});
