/**
 * `remember` tool for the memory-reference plugin.
 *
 * The model calls this to commit a durable fact: the text is embedded via
 * `host.embeddings`, the row is written via `host.store`, and the vector is
 * upserted into `host.vectorStore` — all through the runtime the `init` hook
 * captured from the public {@link PluginHost}. The loader derives the
 * model-visible tool name from this filename (`remember`).
 *
 * Imports ONLY `@vellumai/plugin-api`.
 */

import type { ToolContext, ToolExecutionResult } from "@vellumai/plugin-api";

import { getRuntime, rememberFact } from "../src/state.js";

interface RememberInput {
  /** The fact to store in long-term memory. */
  text?: unknown;
}

export default {
  description:
    "Store a durable long-term memory (a fact about the user, a preference, a decision). Embedded and retrievable later via recall.",

  input_schema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The fact to remember. One concise statement.",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },

  async execute(
    input: RememberInput,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const text = typeof input.text === "string" ? input.text : "";
    if (text.trim().length === 0) {
      return { content: "remember: `text` is required.", isError: true };
    }
    try {
      const rt = getRuntime();
      const id = await rememberFact(rt, ctx.conversationId, text, ctx.signal);
      return { content: `Remembered (id ${id}).`, isError: false };
    } catch (err) {
      return {
        content: `remember failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
