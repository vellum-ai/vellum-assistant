// ---------------------------------------------------------------------------
// Memory Graph — Tool definitions for recall and remember
//
// These replace memory_recall and memory_manage from the old system.
// ---------------------------------------------------------------------------

import type { ToolDefinition } from "../../providers/types.js";

/**
 * Explicit memory search across the living graph or raw archive.
 *
 * Auto-injected context covers common cases, but the assistant should
 * proactively recall when uncertain — search first, ask second.
 */
export const graphRecallDefinition: ToolDefinition = {
  name: "recall",
  description:
    "Search your memory for specific information. Use this proactively — if you're uncertain about something, look it up before asking. Auto-injected context covers common cases, but actively recall when: you're about to ask a question that memory might answer, the user references something you should already know, you need details about a past conversation or event, or you want to search by a specific feeling, time period, or person. When in doubt, search first, ask second. Be specific in your query for best results.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What you're looking for — be specific and descriptive. Can be a topic, feeling, time period, or person.",
      },
      num_results: {
        type: "integer",
        description:
          "Maximum number of results to return (default 20, max 50).",
      },
      mode: {
        type: "string",
        enum: ["memory", "archive"],
        description:
          '"memory" searches the living memory graph using semantic similarity (default). "archive" searches raw conversation transcripts using keyword matching. Supports FTS5 syntax: use "quoted phrases" for exact matching, AND/OR for boolean logic, NEAR(word1 word2, N) for proximity. Without operators, all keywords must appear (implicit AND). Short words like "I" and "a" are ignored. Prefer "memory" for conceptual/emotional queries, "archive" for finding specific wording.',
      },
      filters: {
        type: "object",
        description: "Optional filters to narrow results",
        properties: {
          types: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "episodic",
                "semantic",
                "procedural",
                "emotional",
                "prospective",
                "behavioral",
                "narrative",
                "shared",
              ],
            },
            description: "Only return memories of these types",
          },
          after: {
            type: "string",
            description:
              "Only return memories created after this date (ISO 8601)",
          },
          before: {
            type: "string",
            description:
              "Only return memories created before this date (ISO 8601)",
          },
        },
      },
    },
    required: ["query"],
  },
};

/**
 * Save a fact to the personal knowledge base. The fact is appended to
 * buffer.md (immediately available in the next conversation) and the
 * daily archive (permanent date-indexed record). Filing into topic
 * files happens during the periodic filing job.
 */
export const graphRememberDefinition: ToolDefinition = {
  name: "remember",
  description:
    "Save a fact to your knowledge base. Call this AGGRESSIVELY — capture anything concrete about their life: preferences, locations, names, dates, habits, opinions, health details, plans, relationship facts, routines, commitments. Default to remembering; only skip obvious noise (small talk, hypotheticals, things they're just musing about). Don't judge importance — filing decides that later. Examples: 'Prefers UberEats over DoorDash', 'Lives in NYC, from Texas', 'Takes 45mg nicotine daily, tapering', 'Girlfriend Yen is in Texas', 'Watches vampire show Saturday nights', 'NYU Summit April 10-11'. Call this multiple times per conversation — it's cheap (one line appended to a file). Don't wait until the end. Don't batch. Every new fact, immediately. Remembering too much is infinitely better than forgetting something that mattered. CORRECTIONS are the highest priority — when the user corrects a fact you had wrong, `remember` the correction immediately. The wrong version is already propagated in your prior turns and memory graph; skipping a correction means future-you keeps operating on the old value. Never skip a correction even if you'd skip the equivalent fresh fact.",
  input_schema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "The fact to remember. Write naturally — a preference, a detail, a commitment, a plan. No need to categorize.",
      },
      finish_turn: {
        type: "boolean",
        description:
          "Set to true ONLY on the final `remember` call when you have nothing else to say and want to hand control back to the user. When true, the assistant turn ends after this tool call and no further LLM call is made. Do NOT set true on intermediate `remember` calls. Default: false.",
      },
    },
    required: ["content"],
  },
};
