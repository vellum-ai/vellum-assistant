/**
 * Verifies the agent loop's exclusive-tool dispatch: when a tool the registry
 * marks exclusive appears in a multi-call turn, only that tool runs and the
 * siblings are deferred un-run with a benign result — so the model incorporates
 * the exclusive tool's output before acting on anything else. Drives the REAL
 * loop, mocking only the provider boundary.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import { createMockProvider } from "../__tests__/helpers/mock-provider.js";
import { RiskLevel } from "../permissions/types.js";
import type { ContentBlock, ProviderResponse } from "../providers/types.js";
import { registerTool } from "../tools/registry.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { AgentLoop } from "./loop.js";

// The loop reads exclusivity straight from the registry (`getTool(name)
// ?.exclusive`), so seed a registered tool the loop can look up. Other tool
// names in these turns are absent from the registry, so they read as
// non-exclusive — exactly the mixed state the deferral logic branches on.
beforeAll(() => {
  registerTool({
    name: "exclusive_tool",
    description: "Exclusive test tool",
    category: "test",
    defaultRiskLevel: RiskLevel.Low,
    executionTarget: "sandbox",
    exclusive: true,
    input_schema: { type: "object", properties: {}, required: [] },
    async execute(
      _input: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolExecutionResult> {
      return { content: "ok", isError: false };
    },
  });
});

const endTurn = (text: string): ProviderResponse => ({
  content: [{ type: "text", text }],
  model: "mock-model",
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: "end_turn",
});

const toolUseTurn = (
  blocks: Array<{ id: string; name: string }>,
): ProviderResponse => ({
  content: [
    { type: "text", text: "working" },
    ...blocks.map((b) => ({
      type: "tool_use" as const,
      id: b.id,
      name: b.name,
      input: {},
    })),
  ],
  model: "mock-model",
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: "tool_use",
});

function toolResults(history: { content: ContentBlock[] }[]) {
  return history
    .flatMap((m) => m.content)
    .filter(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result",
    );
}

const baseRun = {
  requestId: "req-excl",
  onEvent: () => {},
  callSite: "mainAgent" as const,
  trust: { sourceChannel: "vellum" as const, trustClass: "unknown" as const },
};

describe("AgentLoop — exclusive tool deferral", () => {
  test("runs the exclusive tool alone and defers sibling calls un-run", async () => {
    const { provider } = createMockProvider([
      toolUseTurn([
        { id: "call-exclusive", name: "exclusive_tool" },
        { id: "call-edit", name: "write_file" },
      ]),
      endTurn("done"),
    ]);

    const executed: string[] = [];
    const loop = new AgentLoop({
      provider,
      systemPrompt: "sys",
      conversationId: "excl-1",
      tools: [
        {
          name: "exclusive_tool",
          description: "",
          input_schema: { type: "object" },
        },
        {
          name: "write_file",
          description: "",
          input_schema: { type: "object" },
        },
      ],
      toolExecutor: async (name) => {
        executed.push(name);
        return { content: `ran ${name}`, isError: false };
      },
    });

    const { history } = await loop.run({
      ...baseRun,
      messages: [{ role: "user", content: [{ type: "text", text: "do it" }] }],
    });

    // Only the exclusive tool actually executed.
    expect(executed).toEqual(["exclusive_tool"]);

    const results = toolResults(history);
    const exclusiveResult = results.find(
      (b) => b.tool_use_id === "call-exclusive",
    )!;
    const editResult = results.find((b) => b.tool_use_id === "call-edit")!;

    // The exclusive tool ran; the sibling came back un-run (not an error) so the
    // model can re-issue it after reading the guidance.
    expect(exclusiveResult.content).toBe("ran exclusive_tool");
    expect(editResult.content).toContain("not run");
    expect(editResult.content).toContain("exclusive_tool");
    expect(editResult.is_error).toBe(false);
  });

  test("runs sibling tools normally when no exclusive tool is present", async () => {
    const { provider } = createMockProvider([
      toolUseTurn([
        { id: "call-read", name: "read_file" },
        { id: "call-write", name: "write_file" },
      ]),
      endTurn("done"),
    ]);

    const executed: string[] = [];
    const loop = new AgentLoop({
      provider,
      systemPrompt: "sys",
      conversationId: "excl-2",
      tools: [
        {
          name: "read_file",
          description: "",
          input_schema: { type: "object" },
        },
        {
          name: "write_file",
          description: "",
          input_schema: { type: "object" },
        },
      ],
      toolExecutor: async (name) => {
        executed.push(name);
        return { content: `ran ${name}`, isError: false };
      },
    });

    const { history } = await loop.run({
      ...baseRun,
      messages: [{ role: "user", content: [{ type: "text", text: "do it" }] }],
    });

    // Both non-exclusive tools ran; nothing was deferred.
    expect(executed.sort()).toEqual(["read_file", "write_file"]);
    for (const result of toolResults(history)) {
      expect(result.content).not.toContain("not run");
    }
  });
});
