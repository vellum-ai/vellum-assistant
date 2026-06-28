/**
 * `recall` tool for the memory-reference plugin.
 *
 * The model calls this to retrieve relevant memories: the query is embedded via
 * `host.embeddings`, searched against `host.vectorStore`, and the matching rows
 * are hydrated from `host.store`. The loader derives the model-visible tool name
 * from this filename (`recall`).
 *
 * Imports ONLY `@vellumai/plugin-api`.
 */

import type { ToolContext, ToolExecutionResult } from "@vellumai/plugin-api";

import { DEFAULT_RECALL_LIMIT, getRuntime, recallFacts } from "../src/state.js";

interface RecallInput {
  /** What to search long-term memory for. */
  query?: unknown;
  /** Max memories to return (defaults to DEFAULT_RECALL_LIMIT). */
  limit?: unknown;
}

export default {
  description:
    "Search long-term memory for facts relevant to a query. Returns the most similar stored memories, best match first.",

  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to look up in long-term memory.",
      },
      limit: {
        type: "integer",
        description: `Max memories to return (default ${DEFAULT_RECALL_LIMIT}).`,
        minimum: 1,
        maximum: 50,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },

  async execute(
    input: RecallInput,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const query = typeof input.query === "string" ? input.query : "";
    if (query.trim().length === 0) {
      return { content: "recall: `query` is required.", isError: true };
    }
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(50, Math.trunc(input.limit)))
        : DEFAULT_RECALL_LIMIT;
    try {
      const rt = getRuntime();
      const rows = await recallFacts(rt, query, limit, ctx.signal);
      if (rows.length === 0) {
        return { content: "No relevant memories found.", isError: false };
      }
      const body = rows.map((r) => `- ${r.text}`).join("\n");
      return { content: `Relevant memories:\n${body}`, isError: false };
    } catch (err) {
      return {
        content: `recall failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
