// ---------------------------------------------------------------------------
// Memory Tool definitions for agentic recall and remember.
// ---------------------------------------------------------------------------

import type { ToolDefinition } from "../../providers/types.js";
import {
  ALL_RECALL_SOURCES,
  MAX_RECALL_MAX_RESULTS,
  MIN_RECALL_MAX_RESULTS,
} from "../context-search/limits.js";

const RECALL_DEPTHS = ["fast", "standard", "deep"] as const;

/**
 * Explicit local information search across memory, PKB, conversations, and
 * workspace files.
 */
export const graphRecallDefinition: ToolDefinition = {
  name: "recall",
  description:
    'Search local information the moment you feel uncertain. Use recall for memory, the personal knowledge base, past conversations, and workspace files — before you guess, before you ask, before you hedge. Auto-injection is incomplete by design; it surfaces patterns, not the specifics you need to answer well. If you catch yourself reaching for "I think", "I believe", "if I remember", "didn\'t we", "last time" — that\'s the signal. Recall. If the user references someone, a place, a decision, a document, or prior work you should be able to find locally — recall. Call it multiple times per conversation if the turn warrants it. Be specific in your query for best results.',
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
          "Optional local sources to search. Omit to search memory, PKB, conversations, and workspace files.",
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
    "Save a fact to your knowledge base. Call this AGGRESSIVELY — capture anything concrete about their life: preferences, locations, names, dates, habits, opinions, health details, plans, relationship facts, routines, commitments. Default to remembering; only skip obvious noise (small talk, hypotheticals, things they're just musing about). Don't judge importance — filing decides that later. Examples: 'Prefers UberEats over DoorDash', 'Lives in NYC, from Texas', 'Takes daily medication, tapering dose', 'Partner Alex lives in Austin', 'Watches a weekly show on Saturday nights', 'Conference in May'. Call this multiple times per conversation — it's cheap (one line appended to a file). Don't wait until the end. Don't batch. Every new fact, immediately. Remembering too much is infinitely better than forgetting something that mattered. CORRECTIONS are the highest priority — when the user corrects a fact you had wrong, `remember` the correction immediately. The wrong version is already propagated in your prior turns and memory graph; skipping a correction means future-you keeps operating on the old value. Never skip a correction even if you'd skip the equivalent fresh fact.",
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
