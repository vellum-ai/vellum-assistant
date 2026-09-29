import { beforeEach, describe, expect, test } from "bun:test";

import { createMockProvider } from "../__tests__/helpers/mock-provider.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import type {
  ContentBlock,
  Message,
  ProviderResponse,
} from "../providers/types.js";
import { wrapUnparseableToolArgs } from "../providers/unparseable-tool-args.js";
import { type AgentEvent, AgentLoop } from "./loop.js";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "Write the file" }],
};

function malformedToolResponse(
  id: string,
  raw: string,
  options: { name?: string; text?: string } = {},
): ProviderResponse {
  return {
    content: [
      ...(options.text ? [{ type: "text" as const, text: options.text }] : []),
      {
        type: "tool_use",
        id,
        name: options.name ?? "file_write",
        input: wrapUnparseableToolArgs(raw),
      },
    ],
    model: "mock-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "tool_use",
  };
}

function toolBlocks(
  history: Message[],
  type: "tool_use" | "tool_result",
): ContentBlock[] {
  return history
    .flatMap((message) => message.content)
    .filter((block) => {
      return block.type === type;
    });
}

describe("AgentLoop: unparseable tool retries", () => {
  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
  });

  test("bounds persisted input and stops after three consecutive malformed turns", async () => {
    const raw =
      '{"path":"/workspace/file.md","content":"' + "x".repeat(2_000_000);
    const { provider, calls } = createMockProvider([
      malformedToolResponse("bad-1", raw),
      malformedToolResponse("bad-2", raw),
      malformedToolResponse("bad-3", raw, { text: "Still trying." }),
      malformedToolResponse("bad-4", raw),
    ]);
    const executionInputs: Record<string, unknown>[] = [];
    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "conversation-123",
      tools: [
        {
          name: "file_write",
          description: "",
          input_schema: { type: "object" },
        },
      ],
      toolExecutor: async (_name, input) => {
        executionInputs.push(input);
        return { content: "invalid JSON", isError: true };
      },
    });

    const result = await loop.run({
      requestId: "request-123",
      messages: [userMessage],
      onEvent: (event) => {
        events.push(event);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(3);
    expect(executionInputs).toHaveLength(2);
    expect(executionInputs[0]).toEqual(wrapUnparseableToolArgs(raw));
    expect(toolBlocks(result.history, "tool_use")).toHaveLength(2);
    expect(toolBlocks(result.history, "tool_result")).toHaveLength(2);

    const serializedHistory = JSON.stringify(result.history);
    expect(serializedHistory.length).toBeLessThan(5_000);
    expect(serializedHistory).not.toContain("x".repeat(1_000));
    expect(result.history.at(-1)?.content).toEqual([
      { type: "text", text: "Still trying." },
      {
        type: "text",
        text: "\n\nI stopped after repeated malformed tool calls to keep this conversation from growing indefinitely. Please try again, or switch models if the problem continues.",
      },
    ]);
    expect(events.filter((event) => event.type === "tool_use")).toHaveLength(2);
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.text)
        .join(""),
    ).toEndWith(
      "Still trying.\n\nI stopped after repeated malformed tool calls to keep this conversation from growing indefinitely. Please try again, or switch models if the problem continues.",
    );
  });

  test("surfaces only the stop notice when assistant text is tool-gated", async () => {
    const raw = "{" + "x".repeat(1_000);
    const { provider } = createMockProvider([
      malformedToolResponse("bad-1", raw, { text: "Private notes one." }),
      malformedToolResponse("bad-2", raw, { text: "Private notes two." }),
      malformedToolResponse("bad-3", raw, { text: "Private notes three." }),
    ]);
    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "conversation-gated",
      tools: [
        {
          name: "file_write",
          description: "",
          input_schema: { type: "object" },
        },
      ],
      toolExecutor: async () => ({ content: "invalid JSON", isError: true }),
    });

    const result = await loop.run({
      requestId: "request-gated",
      messages: [userMessage],
      onEvent: (event) => {
        events.push(event);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      suppressAssistantText: true,
    });

    expect(result.history.at(-1)?.content).toEqual([
      {
        type: "text",
        text: "I stopped after repeated malformed tool calls to keep this conversation from growing indefinitely. Please try again, or switch models if the problem continues.",
      },
    ]);
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.text)
        .join(""),
    ).toBe(
      "I stopped after repeated malformed tool calls to keep this conversation from growing indefinitely. Please try again, or switch models if the problem continues.",
    );
    const finalMessage = events
      .filter((event) => event.type === "message_complete")
      .at(-1);
    expect(finalMessage?.assistantTextVisibility).toBe("visible");
  });

  test("does not count skill_execute envelopes recovered from valid outer JSON", async () => {
    const recoverableRaw = JSON.stringify({
      tool: "document_update",
      input: "body",
      activity: "Updating the document",
    });
    const malformedRaw = "{" + "x".repeat(1_000);
    const done: ProviderResponse = {
      content: [{ type: "text", text: "Done" }],
      model: "mock-model",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
    const { provider, calls } = createMockProvider([
      malformedToolResponse("recover-1", recoverableRaw, {
        name: "skill_execute",
      }),
      malformedToolResponse("bad-1", malformedRaw),
      malformedToolResponse("recover-2", recoverableRaw, {
        name: "skill_execute",
      }),
      malformedToolResponse("bad-2", malformedRaw),
      done,
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "conversation-789",
      tools: [
        {
          name: "skill_execute",
          description: "",
          input_schema: { type: "object" },
        },
        {
          name: "file_write",
          description: "",
          input_schema: { type: "object" },
        },
      ],
      toolExecutor: async () => ({ content: "result", isError: false }),
    });

    const result = await loop.run({
      requestId: "request-789",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(5);
    expect(result.history.at(-1)?.content).toEqual([
      { type: "text", text: "Done" },
    ]);
  });

  test("resets the streak after a well-formed tool turn", async () => {
    const raw = "{" + "x".repeat(1_000);
    const valid: ProviderResponse = {
      content: [
        {
          type: "tool_use",
          id: "valid",
          name: "file_write",
          input: { path: "/workspace/file.md", content: "ok" },
        },
      ],
      model: "mock-model",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "tool_use",
    };
    const done: ProviderResponse = {
      content: [{ type: "text", text: "Done" }],
      model: "mock-model",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
    const { provider, calls } = createMockProvider([
      malformedToolResponse("bad-1", raw),
      malformedToolResponse("bad-2", raw),
      valid,
      malformedToolResponse("bad-3", raw),
      malformedToolResponse("bad-4", raw),
      done,
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "conversation-456",
      tools: [
        {
          name: "file_write",
          description: "",
          input_schema: { type: "object" },
        },
      ],
      toolExecutor: async () => ({ content: "result", isError: false }),
    });

    const result = await loop.run({
      requestId: "request-456",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(6);
    expect(result.history.at(-1)?.content).toEqual([
      { type: "text", text: "Done" },
    ]);
  });
});
