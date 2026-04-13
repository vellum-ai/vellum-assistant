/**
 * Guards the observability contract for the fire-and-forget regenerate path.
 *
 * /regenerate no longer awaits runAgentLoop — any error that escapes the
 * agent loop (e.g. a throw from its `finally` block) would otherwise be
 * swallowed by the `.catch()` without the structured `request_error` trace
 * event that the prior handler-level try/catch used to emit.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

let dbMessages: Array<{
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
  metadata: string | null;
}> = [];

mock.module("../memory/conversation-crud.js", () => ({
  getMessages: (conversationId: string) =>
    dbMessages.filter((m) => m.conversationId === conversationId),
  deleteMessageById: (messageId: string) => {
    dbMessages = dbMessages.filter((m) => m.id !== messageId);
    return { segmentIds: [], deletedSummaryIds: [] };
  },
  updateMessageContent: () => {},
  relinkAttachments: () => 0,
  deleteLastExchange: () => 0,
}));

mock.module("../memory/conversation-queries.js", () => ({
  isLastUserMessageToolResult: () => false,
}));

mock.module("../memory/jobs-store.js", () => ({
  enqueueMemoryJob: () => {},
}));

mock.module("../memory/llm-request-log-store.js", () => ({
  relinkLlmRequestLogs: () => {},
}));

mock.module("../memory/qdrant-circuit-breaker.js", () => ({
  withQdrantBreaker: async (fn: () => Promise<unknown>) => fn(),
}));

mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => {
    throw new Error("Qdrant not initialized");
  },
}));

import {
  type HistoryConversationContext,
  regenerate,
} from "../daemon/conversation-history.js";
import type { Message } from "../providers/types.js";

type TraceEvent = {
  event: string;
  body: string;
  options: { requestId?: string; attributes?: Record<string, unknown> };
};

function buildContext(
  overrides: Partial<{
    runAgentLoop: HistoryConversationContext["runAgentLoop"];
    messages: Message[];
    traceEvents: TraceEvent[];
  }> = {},
): HistoryConversationContext {
  const conversationId = "conv-regen-trace";

  const messages: Message[] = overrides.messages ?? [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ];

  dbMessages = [
    {
      id: "msg-u1",
      conversationId,
      role: "user",
      content: JSON.stringify([{ type: "text", text: "hello" }]),
      createdAt: 1000,
      metadata: null,
    },
    {
      id: "msg-a1",
      conversationId,
      role: "assistant",
      content: JSON.stringify([{ type: "text", text: "hi" }]),
      createdAt: 2000,
      metadata: null,
    },
  ];

  const traceEvents = overrides.traceEvents ?? [];

  const runAgentLoop: HistoryConversationContext["runAgentLoop"] =
    overrides.runAgentLoop ??
    (async () => {
      throw new Error("boom");
    });

  return {
    conversationId,
    traceEmitter: {
      emit: (event: string, body: string, options: TraceEvent["options"]) => {
        traceEvents.push({ event, body, options });
      },
    } as unknown as HistoryConversationContext["traceEmitter"],
    messages,
    processing: false,
    abortController: null,
    runAgentLoop,
  };
}

describe("regenerate fire-and-forget error path", () => {
  beforeEach(() => {
    dbMessages = [];
  });

  test("emits request_error trace when runAgentLoop rejects asynchronously", async () => {
    const traceEvents: TraceEvent[] = [];

    const session = buildContext({
      traceEvents,
      runAgentLoop: async () => {
        throw new Error("agent loop blew up in finally");
      },
    });

    await regenerate(session, () => {}, "req-123");

    // Give the fire-and-forget .catch() a tick to run.
    await new Promise((resolve) => setImmediate(resolve));

    const errorEvents = traceEvents.filter((e) => e.event === "request_error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].body).toBe("agent loop blew up in finally");
    expect(errorEvents[0].options.requestId).toBe("req-123");
    expect(errorEvents[0].options.attributes?.errorClass).toBe("Error");
    expect(errorEvents[0].options.attributes?.source).toBe(
      "regenerate_fire_and_forget",
    );
    expect(errorEvents[0].options.attributes?.message).toBe(
      "agent loop blew up in finally",
    );
  });

  test("uses generated requestId when caller did not pass one", async () => {
    const traceEvents: TraceEvent[] = [];

    const session = buildContext({
      traceEvents,
      runAgentLoop: async () => {
        throw new Error("boom");
      },
    });

    await regenerate(session, () => {});

    await new Promise((resolve) => setImmediate(resolve));

    const errorEvents = traceEvents.filter((e) => e.event === "request_error");
    expect(errorEvents).toHaveLength(1);
    expect(typeof errorEvents[0].options.requestId).toBe("string");
    expect((errorEvents[0].options.requestId ?? "").length).toBeGreaterThan(0);
  });

  test("does not emit request_error when runAgentLoop succeeds", async () => {
    const traceEvents: TraceEvent[] = [];

    const session = buildContext({
      traceEvents,
      runAgentLoop: async () => {},
    });

    await regenerate(session, () => {}, "req-ok");

    await new Promise((resolve) => setImmediate(resolve));

    const errorEvents = traceEvents.filter((e) => e.event === "request_error");
    expect(errorEvents).toHaveLength(0);
  });
});
