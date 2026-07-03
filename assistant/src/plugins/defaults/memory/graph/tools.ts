// ---------------------------------------------------------------------------
// Memory Tool definitions for agentic recall and remember.
// ---------------------------------------------------------------------------

import {
  ALL_RECALL_SOURCES,
  MAX_RECALL_MAX_RESULTS,
  MIN_RECALL_MAX_RESULTS,
} from "../context-search/limits.js";
import type { ToolDefinition } from "../llm-helpers.js";

const RECALL_DEPTHS = ["fast", "standard", "deep"] as const;

/**
 * Explicit local information search across memory, conversations, and
 * workspace files.
 */
export const graphRecallDefinition = {
  name: "recall",
  description:
    'Search local information the moment you feel uncertain. Use recall for memory, past conversations, and workspace files — before you guess, before you ask, before you hedge. Auto-injection is incomplete by design; it surfaces patterns, not the specifics you need to answer well. If you catch yourself reaching for "I think", "I believe", "if I remember", "didn\'t we", "last time" — that\'s the signal. Recall. If a turn references someone, a place, a decision, a document, or prior work you should be able to find locally — recall. Call it multiple times per conversation if the turn warrants it. Be specific in your query for best results.',
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What you're looking for. Be specific and descriptive: include the topic, person, project, decision, time period, or file clues when known.",
      },
      sources: {
        type: "array",
        items: {
          type: "string",
          enum: [...ALL_RECALL_SOURCES],
        },
        description:
          "Optional local sources to search. Omit to search memory, conversations, and workspace files.",
      },
      max_results: {
        type: "integer",
        minimum: MIN_RECALL_MAX_RESULTS,
        maximum: MAX_RECALL_MAX_RESULTS,
        description: "Maximum number of evidence items to return.",
      },
      depth: {
        type: "string",
        enum: [...RECALL_DEPTHS],
        description:
          "Search effort. Use fast for quick lookups, standard by default, and deep when the answer may require multiple local searches.",
      },
    },
    required: ["query"],
  },
} satisfies ToolDefinition;

/**
 * `remember` tool description. The retrospective pass catches what isn't
 * captured in the moment, so the in-conversation pressure stays at a
 * judgment framing: pause when something feels worth marking, not because
 * the volume is required.
 */
const REMEMBER_DESCRIPTION =
  "Remember anything concrete shared in conversation: corrections, plans, decisions, felt moments, names, dates, commitments, preferences. Corrections are the highest priority — call `remember` the same turn the correction lands. You don't have to call this on every turn; a retrospective pass reviews the conversation after each message-count / time interval and saves what you didn't capture. Use judgment: pause and remember when something feels worth marking, not because the volume is required.";

/**
 * Delete a memory node by matching its content.
 */
export const graphDeleteMemoryDefinition: ToolDefinition = {
  name: "delete_memory",
  description:
    "Remove an incorrect, outdated, or unwanted memory. Use recall first to confirm the exact content, then pass it here. Only use this when explicitly asked to forget something, or when correcting a fact that requires removing the old version entirely. Prefer update_memory when the fact is being corrected rather than fully discarded.",
  input_schema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "The content of the memory to delete, as returned by recall. Must closely match the stored text.",
      },
      finish_turn: {
        type: "boolean",
        description:
          "When you have nothing else to say and want to yield the turn you MUST set this to true.",
      },
    },
    required: ["content"],
  },
};

/**
 * Update (correct) an existing memory node in place.
 */
export const graphUpdateMemoryDefinition: ToolDefinition = {
  name: "update_memory",
  description:
    "Correct or update an existing memory. Use recall first to find the exact current content, then supply the old text and the replacement. Prefer this over delete_memory + remember when the fact is being corrected, not discarded — it preserves earned trust scores and the full edit history.",
  input_schema: {
    type: "object",
    properties: {
      old_content: {
        type: "string",
        description:
          "The current memory content to replace, as returned by recall.",
      },
      new_content: {
        type: "string",
        description: "The corrected or updated memory content.",
      },
      finish_turn: {
        type: "boolean",
        description:
          "When you have nothing else to say and want to yield the turn you MUST set this to true.",
      },
    },
    required: ["old_content", "new_content"],
  },
};

/**
 * Save a fact to the assistant's knowledge base. The fact is appended to
 * `buffer.md` (immediately available in the next conversation) and the daily
 * archive (permanent date-indexed record). When `memory.v2.enabled` is true,
 * writes go under `memory/`; otherwise they go under `pkb/`. Consolidation
 * of the buffer into longer-form storage runs as a separate periodic job in
 * both modes.
 */
export const graphRememberDefinition = {
  name: "remember",
  description: REMEMBER_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      content: {
        anyOf: [
          { type: "string" },
          { type: "array", items: { type: "string" }, minItems: 1 },
        ],
        description:
          "The fact(s) to remember. Pass a single string for one fact, or an array of strings to record several independent facts in one call. When a turn surfaces multiple unrelated facts, pass them all as an array in one call rather than calling `remember` once per fact. Write naturally — a preference, a detail, a commitment, a plan. No need to categorize.",
      },
      finish_turn: {
        type: "boolean",
        description:
          "When you have nothing else to say and want to yield the turn you MUST set this to true. When true, your turn ends after this tool call. It's critical that you do this in order to avoid unnecessary LLM calls.",
      },
    },
    required: ["content"],
  },
} satisfies ToolDefinition;
