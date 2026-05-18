/**
 * `simple_memory_recall` — regex search across every simple-memory entry,
 * regardless of which conversation wrote it.
 *
 * The query is compiled as a case-insensitive JavaScript regular
 * expression and tested against each entry's text. Results are ordered
 * by `createdAt` descending (newest first) and capped at `limit`. Each
 * line's scope column reads `current` for matches written by the active
 * conversation, otherwise the source conversation id — so the model can
 * tell same-thread context from cross-thread context.
 *
 * Convention: default export is the tool object the harness registers.
 */

import type { ToolContext, ToolExecutionResult } from "@vellumai/plugin-api";

import { searchEntries } from "../src/state.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export default {
  description:
    "Search every simple-memory entry (across all conversations) with a regex match. Use when you need to surface something the user told you to remember, including from previous conversations.",
  defaultRiskLevel: "low" as const,
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "JavaScript regular-expression pattern. Always case-insensitive. A plain string (e.g. `vargas`) works as a literal substring; metacharacters like `.`, `\\b`, alternation, or character classes are honored.",
      },
      limit: {
        type: "number",
        description: `Maximum number of matches to return. Default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`,
      },
    },
    required: ["query"],
  },
  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const query = String((input as { query?: unknown }).query ?? "").trim();
    if (query.length === 0) {
      return { content: "error: query must be non-empty", isError: true };
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(query, "i");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `error: invalid regex: ${message}`,
        isError: true,
      };
    }
    const requestedLimit = Number((input as { limit?: unknown }).limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(requestedLimit)))
      : DEFAULT_LIMIT;

    const matches = searchEntries(pattern, limit);
    if (matches.length === 0) {
      return { content: `no matches for: ${query}`, isError: false };
    }
    const body = matches
      .map((e) => {
        const scope =
          e.conversationId === ctx.conversationId
            ? "current"
            : e.conversationId;
        return `${e.id}\t${new Date(e.createdAt).toISOString()}\t${scope}\t${e.text}`;
      })
      .join("\n");
    return { content: body, isError: false };
  },
};
