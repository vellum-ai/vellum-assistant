/**
 * Unit tests for the `host.memory.*` skill IPC routes.
 *
 * Every daemon delegate is mocked with `mock.module` so the test exercises
 * only the route layer — param parsing, delegate call shape, return shape.
 * Deep behavioral coverage for `addMessage` / `wakeAgentForOpportunity`
 * lives in their own modules.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module-level stubs — installed before importing the module under test
// ---------------------------------------------------------------------------

const addMessageSpy = mock(
  async (
    _conversationId: string,
    _role: string,
    _content: string,
    _metadata?: Record<string, unknown>,
    _opts?: { skipIndexing?: boolean },
  ) => ({ id: "msg-xyz", createdAt: 123 }),
);
mock.module("../../../memory/conversation-crud.js", () => ({
  addMessage: addMessageSpy,
}));

const wakeAgentSpy = mock(
  async (_opts: { conversationId: string; hint: string; source: string }) => ({
    invoked: true,
    producedToolCalls: false,
  }),
);
mock.module("../../../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: wakeAgentSpy,
}));

// ---------------------------------------------------------------------------
// Module under test — imported after every stub is in place
// ---------------------------------------------------------------------------

import {
  memoryAddMessageRoute,
  memorySkillRoutes,
  memoryWakeAgentForOpportunityRoute,
} from "../memory.js";

beforeEach(() => {
  addMessageSpy.mockClear();
  wakeAgentSpy.mockClear();
});

describe("memorySkillRoutes registry", () => {
  test("exposes both canonical method names", () => {
    const methods = memorySkillRoutes.map((r) => r.method).sort();
    expect(methods).toEqual([
      "host.memory.addMessage",
      "host.memory.wakeAgentForOpportunity",
    ]);
  });
});

describe("host.memory.addMessage", () => {
  test("forwards all positional args to addMessage and returns its result", async () => {
    const result = await memoryAddMessageRoute.handler({
      conversationId: "conv-1",
      role: "user",
      content: "hello",
      metadata: { foo: "bar" },
      opts: { skipIndexing: true },
    });

    expect(addMessageSpy).toHaveBeenCalledTimes(1);
    const call = addMessageSpy.mock.calls[0];
    expect(call[0]).toBe("conv-1");
    expect(call[1]).toBe("user");
    expect(call[2]).toBe("hello");
    expect(call[3]).toEqual({ foo: "bar" });
    expect(call[4]).toEqual({ skipIndexing: true });
    expect(result).toEqual({ id: "msg-xyz", createdAt: 123 });
  });

  test("accepts omitted metadata + opts", async () => {
    await memoryAddMessageRoute.handler({
      conversationId: "conv-2",
      role: "assistant",
      content: "ack",
    });

    expect(addMessageSpy).toHaveBeenCalledTimes(1);
    const call = addMessageSpy.mock.calls[0];
    expect(call[3]).toBeUndefined();
    expect(call[4]).toBeUndefined();
  });

  test("rejects missing conversationId", async () => {
    await expect(
      memoryAddMessageRoute.handler({ role: "user", content: "x" }),
    ).rejects.toThrow();
  });

  test("rejects empty conversationId", async () => {
    await expect(
      memoryAddMessageRoute.handler({
        conversationId: "",
        role: "user",
        content: "x",
      }),
    ).rejects.toThrow();
  });

  test("rejects missing role", async () => {
    await expect(
      memoryAddMessageRoute.handler({
        conversationId: "c",
        content: "x",
      }),
    ).rejects.toThrow();
  });

  test("rejects missing content", async () => {
    await expect(
      memoryAddMessageRoute.handler({
        conversationId: "c",
        role: "user",
      }),
    ).rejects.toThrow();
  });
});

describe("host.memory.wakeAgentForOpportunity", () => {
  test("forwards WakeOptions and returns void (drops WakeResult)", async () => {
    const result = await memoryWakeAgentForOpportunityRoute.handler({
      conversationId: "conv-1",
      hint: "new email arrived",
      source: "skill-test",
    });

    expect(wakeAgentSpy).toHaveBeenCalledTimes(1);
    expect(wakeAgentSpy.mock.calls[0]?.[0]).toEqual({
      conversationId: "conv-1",
      hint: "new email arrived",
      source: "skill-test",
    });
    // Contract is `void` — daemon's WakeResult is discarded on purpose.
    expect(result).toBeUndefined();
  });

  test("rejects missing conversationId", async () => {
    await expect(
      memoryWakeAgentForOpportunityRoute.handler({
        hint: "h",
        source: "s",
      }),
    ).rejects.toThrow();
  });

  test("rejects empty hint", async () => {
    await expect(
      memoryWakeAgentForOpportunityRoute.handler({
        conversationId: "c",
        hint: "",
        source: "s",
      }),
    ).rejects.toThrow();
  });

  test("rejects empty source", async () => {
    await expect(
      memoryWakeAgentForOpportunityRoute.handler({
        conversationId: "c",
        hint: "h",
        source: "",
      }),
    ).rejects.toThrow();
  });
});
