/**
 * Verifies the agent loop coalesces `tool_use` blocks by call id before it
 * dispatches them: a provider that emits the same call twice under one id gets
 * one execution, one `tool_use` block in history, and one correlated
 * `tool_result`. Distinct ids for the same tool name still run independently.
 * Drives the REAL loop, mocking only the provider boundary.
 */
import { describe, expect, test } from "bun:test";

import { createMockProvider } from "../__tests__/helpers/mock-provider.js";
import type { ContentBlock, ProviderResponse } from "../providers/types.js";
import { AgentLoop } from "./loop.js";

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

function blocksOfType<T extends ContentBlock["type"]>(
  history: Array<{ content: ContentBlock[] }>,
  type: T,
): Array<Extract<ContentBlock, { type: T }>> {
  return history
    .flatMap((m) => m.content)
    .filter((b): b is Extract<ContentBlock, { type: T }> => b.type === type);
}

function buildLoop(
  provider: ReturnType<typeof createMockProvider>["provider"],
  conversationId: string,
  executed: string[],
) {
  return new AgentLoop({
    provider,
    systemPrompt: "sys",
    conversationId,
    tools: [
      { name: "read_file", description: "", input_schema: { type: "object" } },
    ],
    toolExecutor: async (name) => {
      executed.push(name);
      return { content: `ran ${name}`, isError: false };
    },
  });
}

const baseRun = {
  requestId: "req-dedup",
  onEvent: () => {},
  callSite: "mainAgent" as const,
  trust: { sourceChannel: "vellum" as const, trustClass: "unknown" as const },
  messages: [
    { role: "user" as const, content: [{ type: "text" as const, text: "go" }] },
  ],
};

describe("AgentLoop: duplicate tool_use ids", () => {
  /** A call the provider emits twice under one id runs a single time. */
  test("executes a call id once when the provider emits it twice", async () => {
    // GIVEN a provider turn carrying the same tool_use id twice
    const { provider } = createMockProvider([
      toolUseTurn([
        { id: "call-dup", name: "read_file" },
        { id: "call-dup", name: "read_file" },
      ]),
      endTurn("done"),
    ]);

    // WHEN the loop runs the turn
    const executed: string[] = [];
    const toolUseEventIds: string[] = [];
    const { history } = await buildLoop(provider, "dedup-1", executed).run({
      ...baseRun,
      onEvent: (event) => {
        if (event.type === "tool_use") {
          toolUseEventIds.push(event.id);
        }
      },
    });

    // THEN the tool runs once and the client sees one tool_use
    expect(executed).toEqual(["read_file"]);
    expect(toolUseEventIds).toEqual(["call-dup"]);

    // AND history stays well-formed: providers require one tool_result per
    // tool_use id, so the coalesced copy must not survive into history.
    const toolUses = blocksOfType(history, "tool_use");
    expect(toolUses.map((b) => b.id)).toEqual(["call-dup"]);
    const results = blocksOfType(history, "tool_result");
    expect(results.map((b) => b.tool_use_id)).toEqual(["call-dup"]);
    expect(results[0]!.content).toBe("ran read_file");
    expect(results[0]!.is_error).toBe(false);
  });

  /** Two independent calls of one tool are not collapsed by name. */
  test("runs repeat calls of one tool when their ids differ", async () => {
    // GIVEN a provider turn calling one tool twice under distinct ids
    const { provider } = createMockProvider([
      toolUseTurn([
        { id: "call-a", name: "read_file" },
        { id: "call-b", name: "read_file" },
      ]),
      endTurn("done"),
    ]);

    // WHEN the loop runs the turn
    const executed: string[] = [];
    const { history } = await buildLoop(provider, "dedup-2", executed).run(
      baseRun,
    );

    // THEN both calls execute and each gets its own result
    expect(executed).toEqual(["read_file", "read_file"]);
    expect(
      blocksOfType(history, "tool_result").map((b) => b.tool_use_id),
    ).toEqual(["call-a", "call-b"]);
  });

  /** An id-less call still executes, under a generated id. */
  test("assigns a call id when the provider emits a tool_use without one", async () => {
    // GIVEN a provider turn whose tool_use block carries no id
    const { provider } = createMockProvider([
      toolUseTurn([{ id: "", name: "read_file" }]),
      endTurn("done"),
    ]);

    // WHEN the loop runs the turn
    const executed: string[] = [];
    const { history } = await buildLoop(provider, "dedup-3", executed).run(
      baseRun,
    );

    // THEN the call executes under a generated id its result correlates to
    expect(executed).toEqual(["read_file"]);
    const toolUses = blocksOfType(history, "tool_use");
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]!.id.length).toBeGreaterThan(0);
    expect(
      blocksOfType(history, "tool_result").map((b) => b.tool_use_id),
    ).toEqual([toolUses[0]!.id]);
  });
});
