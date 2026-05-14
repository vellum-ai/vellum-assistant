/**
 * `simple_memory_remember` — append a freeform note for the current conversation.
 *
 * Convention: default export is the tool object the harness registers.
 */

import type { ToolContext, ToolExecutionResult } from "@vellumai/plugin-api";

import { appendEntry, type MemoryEntry, newEntryId } from "../src/state.js";

export default {
  name: "simple_memory_remember",
  description:
    "Append a freeform note to simple-memory for the current conversation. Use when the user states a stable preference, a fact about themselves, or a decision worth carrying across turns.",
  category: "plugin",
  defaultRiskLevel: "low" as const,
  getDefinition() {
    return {
      name: "simple_memory_remember",
      description:
        "Append a freeform note to simple-memory for the current conversation.",
      input_schema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "The note to remember. One sentence, written naturally.",
          },
        },
        required: ["text"],
      },
    };
  },
  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const text = String((input as { text?: unknown }).text ?? "").trim();
    if (text.length === 0) {
      return { content: "error: text must be non-empty", isError: true };
    }
    const entry: MemoryEntry = {
      id: newEntryId(),
      conversationId: ctx.conversationId,
      text,
      createdAt: Date.now(),
    };
    appendEntry(entry);
    return { content: `remembered (${entry.id})`, isError: false };
  },
};
