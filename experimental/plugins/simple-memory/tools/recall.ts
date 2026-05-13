/**
 * `simple_memory_recall` — case-insensitive substring search across every
 * simple-memory entry, regardless of which conversation wrote it.
 *
 * Phase 0 keeps ranking trivial: results are filtered by substring then
 * ordered by `createdAt` descending so the most recent matches surface
 * first. Real ranking (recency × score, embedding-based, etc.) lands
 * when the backing store moves off in-process JSONL.
 *
 * Convention: default export is the tool object the harness registers.
 */

import type { ToolContext, ToolExecutionResult } from "@vellumai/plugin-api";

import { searchEntries } from "../src/state.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export default {
  name: "simple_memory_recall",
  description:
    "Search every simple-memory entry (across all conversations) for a substring match. Use when you need to surface something the user told you to remember, including from previous conversations.",
  category: "plugin",
  defaultRiskLevel: "low" as const,
  getDefinition() {
    return {
      name: "simple_memory_recall",
      description:
        "Search every simple-memory entry (across all conversations) for a substring match on its text.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Substring to search for. Case-insensitive. Matched against each entry's text.",
          },
          limit: {
            type: "number",
            description: `Maximum number of matches to return. Default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`,
          },
        },
        required: ["query"],
      },
    };
  },
  async execute(
    input: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const query = String((input as { query?: unknown }).query ?? "").trim();
    if (query.length === 0) {
      return { content: "error: query must be non-empty", isError: true };
    }
    const requestedLimit = Number((input as { limit?: unknown }).limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(requestedLimit)))
      : DEFAULT_LIMIT;

    const matches = searchEntries(query, limit);
    if (matches.length === 0) {
      return { content: `no matches for: ${query}`, isError: false };
    }
    const body = matches
      .map(
        (e) =>
          `${e.id}\t${new Date(e.createdAt).toISOString()}\t${e.conversationId}\t${e.text}`,
      )
      .join("\n");
    return { content: body, isError: false };
  },
};
