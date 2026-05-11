/**
 * `simple_memory_recall` — return every simple-memory entry for the current conversation.
 */

import { entriesFor } from "../src/state.js";

interface ToolContext {
  conversationId: string;
}

interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

export const recallTool = {
  name: "simple_memory_recall",
  description:
    "Return every simple-memory entry written for the current conversation. Use when you need to recall what was remembered earlier in this conversation.",
  category: "plugin",
  defaultRiskLevel: "low" as const,
  getDefinition() {
    return {
      name: "simple_memory_recall",
      description:
        "Return every simple-memory entry for the current conversation.",
      input_schema: { type: "object", properties: {}, required: [] },
    };
  },
  async execute(
    _input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const ours = entriesFor(ctx.conversationId);
    if (ours.length === 0) {
      return { content: "no entries", isError: false };
    }
    const body = ours
      .map((e) => `${e.id}\t${new Date(e.createdAt).toISOString()}\t${e.text}`)
      .join("\n");
    return { content: body, isError: false };
  },
};
