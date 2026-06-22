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
    _options?: {
      metadata?: Record<string, unknown>;
      skipIndexing?: boolean;
      clientMessageId?: string;
    },
  ) => ({ id: "msg-xyz", createdAt: 123 }),
);
mock.module("../../../memory/conversation-crud.js", () => ({
  addMessage: addMessageSpy,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
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
  test("forwards all fields to addMessage as options object and returns its result", async () => {
    const result = await memoryAddMessageRoute.handler({
      conversationId: "conv-1",
      role: "user",
      content: "hello",
      metadata: { foo: "bar" },
      skipIndexing: true,
    });

    expect(addMessageSpy).toHaveBeenCalledTimes(1);
    const call = addMessageSpy.mock.calls[0];
    expect(call[0]).toBe("conv-1");
    expect(call[1]).toBe("user");
    expect(call[2]).toBe("hello");
    expect(call[3]).toEqual({
      metadata: { foo: "bar" },
      skipIndexing: true,
      clientMessageId: undefined,
    });
    expect(result).toEqual({ id: "msg-xyz", createdAt: 123 });
  });

  test("accepts omitted optional fields", async () => {
    await memoryAddMessageRoute.handler({
      conversationId: "conv-2",
      role: "assistant",
      content: "ack",
    });

    expect(addMessageSpy).toHaveBeenCalledTimes(1);
    const call = addMessageSpy.mock.calls[0];
    expect(call[3]).toEqual({
      metadata: undefined,
      skipIndexing: undefined,
      clientMessageId: undefined,
    });
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

  test("rejects the non-renderable system role", async () => {
    // GIVEN the messages store is UI-facing (ConversationMessage), so only
    // renderable turns may be persisted via this facet
    // WHEN a skill attempts to add a system row
    // THEN the route rejects it instead of persisting agent-context scaffolding
    await expect(
      memoryAddMessageRoute.handler({
        conversationId: "c",
        role: "system",
        content: "agent-context scaffolding",
      }),
    ).rejects.toThrow();
    expect(addMessageSpy).not.toHaveBeenCalled();
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
