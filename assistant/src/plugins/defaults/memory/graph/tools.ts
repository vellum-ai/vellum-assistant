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
    'Search local information the moment you feel uncertain. Use recall for memory, past conversations, and workspace files — before you guess, before you ask, before you hedge. Auto-injection is incomplete by design; it surfaces patterns, not the specifics you need to answer well. If you catch yourself reaching for "I think", "I believe", "if I remember", "didn\'t we", "last time" — that\'s the signal. Recall. If a turn references someone, a place, a decision, a document, or prior work you should be able to find locally — recall. Call it multiple times per conversation if the turn warrants it. Be specific in your query for best results. Results reflect what was true when the memory was written — do not use recall alone to answer questions about current system state (account connections, watchers, service health); verify those with live checks.',
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

const REMEMBER_CONTENT_DESCRIPTION =
  "The fact(s) to remember. Pass a single string for one fact, or an array of strings to record several independent facts in one call. When a turn surfaces multiple unrelated facts, pass them all as an array in one call rather than calling `remember` once per fact. Write naturally — a preference, a detail, a commitment, a plan. No need to categorize.";

/**
 * Appended to the `content` description only under the wiki memory model
 * (memory v2/v3), where the v2/v3 consolidation prompts treat `[[slug]]`
 * hints as read-first candidates when filing buffer entries. v1/PKB
 * workspaces have no wiki pages for the hints to reference, and the pkb
 * filing job has no instruction to interpret or strip the markup, so it
 * would persist as literal buffer text there.
 */
export const REMEMBER_PAGE_HINT_GUIDANCE =
  "When a fact relates to memory pages already in your context, reference the most specific ones inline as [[slug]] wikilinks — consolidation reads hinted pages first when filing the fact, which matters most for corrections (the hint names the page carrying the outdated fact). Hint only pages you have actually seen, and prefer specific pages over broad hubs.";

/**
 * Build the `remember` input schema. `pageHints` reflects the wiki-memory
 * (`memory.v2.enabled`) state and appends
 * {@link REMEMBER_PAGE_HINT_GUIDANCE} to the `content` description. It is a
 * thunk re-resolved on every read of that description: the registry's
 * finalized tool shares the returned schema object by reference, so a
 * runtime config edit is reflected on the next schema serialization without
 * re-registering the tool.
 */
export function buildRememberInputSchema(options: {
  pageHints: () => boolean;
}) {
  return {
    type: "object",
    properties: {
      content: {
        anyOf: [
          { type: "string" },
          { type: "array", items: { type: "string" }, minItems: 1 },
        ],
        get description(): string {
          return options.pageHints()
            ? `${REMEMBER_CONTENT_DESCRIPTION} ${REMEMBER_PAGE_HINT_GUIDANCE}`
            : REMEMBER_CONTENT_DESCRIPTION;
        },
      },
      finish_turn: {
        type: "boolean",
        description:
          "When you have nothing else to say and want to yield the turn you MUST set this to true. When true, your turn ends after this tool call. It's critical that you do this in order to avoid unnecessary LLM calls.",
      },
    },
    required: ["content"],
  };
}

/**
 * Save a fact to the assistant's knowledge base. The fact is appended to
 * `buffer.md` (immediately available in the next conversation) and the daily
 * archive (permanent date-indexed record). When `memory.v2.enabled` is true,
 * writes go under `memory/`; otherwise they go under `pkb/`. Consolidation
 * of the buffer into longer-form storage runs as a separate periodic job in
 * both modes. This base definition carries the mode-neutral schema; the
 * registered tool appends the page-hint guidance on wiki-memory installs via
 * {@link buildRememberInputSchema}.
 */
export const graphRememberDefinition = {
  name: "remember",
  description: REMEMBER_DESCRIPTION,
  input_schema: buildRememberInputSchema({ pageHints: () => false }),
} satisfies ToolDefinition;
