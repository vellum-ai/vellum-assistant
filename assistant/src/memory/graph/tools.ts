// ---------------------------------------------------------------------------
// Memory Tool definitions for agentic recall and remember.
// ---------------------------------------------------------------------------

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../../config/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import {
  ALL_RECALL_SOURCES,
  MAX_RECALL_MAX_RESULTS,
  MIN_RECALL_MAX_RESULTS,
} from "../context-search/limits.js";

const RECALL_DEPTHS = ["fast", "standard", "deep"] as const;

/**
 * Explicit local information search across memory, conversations, and
 * workspace files.
 */
export const graphRecallDefinition: ToolDefinition = {
  name: "recall",
  description:
    'Search local information the moment you feel uncertain. Use recall for memory, past conversations, and workspace files — before you guess, before you ask, before you hedge. Auto-injection is incomplete by design; it surfaces patterns, not the specifics you need to answer well. If you catch yourself reaching for "I think", "I believe", "if I remember", "didn\'t we", "last time" — that\'s the signal. Recall. If the user references someone, a place, a decision, a document, or prior work you should be able to find locally — recall. Call it multiple times per conversation if the turn warrants it. Be specific in your query for best results.',
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
};

/**
 * Default (high-pressure) `remember` tool description. Used when the
 * `memory-retrospective` feature flag is OFF. The volume-shaming language
 * ("almost every turn", "most frequently used tool") drives aggressive
 * in-conversation capture for users who don't have the retrospective
 * backstop enabled.
 */
const REMEMBER_DESCRIPTION_DEFAULT =
  "Remember anything concrete: facts, preferences, corrections, plans, felt moments, names, dates, decisions. Default to remembering. Never wait until end of conversation. Corrections are highest priority — call remember the same turn the correction lands. **CRITICAL:** You should be calling remember on almost every turn. This should be your most frequently used tool.";

/**
 * Relaxed `remember` tool description used when `memory-retrospective` is
 * ON. The retrospective pass catches what isn't captured in the moment, so
 * the in-conversation pressure eases to a judgment framing: pause when
 * something feels worth marking, not because the volume is required.
 */
const REMEMBER_DESCRIPTION_RELAXED =
  "Remember anything concrete the user shared: corrections, plans, decisions, felt moments, names, dates, commitments, preferences. Corrections are the highest priority — call `remember` the same turn the correction lands. You don't have to call this on every turn; a retrospective pass reviews the conversation after each message-count / time interval and saves what you didn't capture. Use judgment: pause and remember when something feels worth marking, not because the volume is required.";

/**
 * Return the description that should appear in the `remember` tool
 * registration for the current config. The variant is selected by the
 * `memory-retrospective` assistant feature flag. Exposed as a function so
 * the tool registrar can compute the value at registration time without
 * importing config layers into the static definition.
 */
export function getRememberDescription(config: AssistantConfig): string {
  return isAssistantFeatureFlagEnabled("memory-retrospective", config)
    ? REMEMBER_DESCRIPTION_RELAXED
    : REMEMBER_DESCRIPTION_DEFAULT;
}

/**
 * Save a fact to the assistant's knowledge base. The fact is appended to
 * `buffer.md` (immediately available in the next conversation) and the daily
 * archive (permanent date-indexed record). When `memory.v2.enabled` is true,
 * writes go under `memory/`; otherwise they go under `pkb/`. Consolidation
 * of the buffer into longer-form storage runs as a separate periodic job in
 * both modes.
 *
 * The static `description` field carries the default (high-pressure) text
 * so any direct importer that doesn't go through `getRememberDescription`
 * still gets a valid tool definition. The registered `RememberTool` in
 * `tools/memory/register.ts` overrides this at registration time with the
 * flag-aware variant.
 */
export const graphRememberDefinition: ToolDefinition = {
  name: "remember",
  description: REMEMBER_DESCRIPTION_DEFAULT,
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
          "When you have nothing else to say and want to hand control back to the user you MUST set this to true. When true, your turn ends after this tool call. It's critical that you do this in order to avoid unnecessary LLM calls.",
      },
    },
    required: ["content"],
  },
};
