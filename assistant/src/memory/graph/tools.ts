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
          '"memory" searches the living memory graph (default). "archive" searches raw conversation transcripts for exact words and full context.',
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
          min_confidence: {
            type: "number",
            description: "Minimum confidence threshold (0-1)",
          },
        },
      },
    },
    required: ["query"],
  },
};

/**
 * Explicitly save, update, or delete a memory. Writes are immediate —
 * the node is available in the graph right away.
 *
 * This replaces both memory_manage AND NOW.md. When the assistant
 * learns something worth remembering mid-conversation, it calls this
 * tool rather than waiting for end-of-conversation extraction.
 */
export const graphRememberDefinition: ToolDefinition = {
  name: "remember",
  description:
    "Save, update, or delete a memory. Writes take effect immediately. Use this when you learn something important mid-conversation that you want to remember — don't wait for automatic extraction. Use 'save' for new information, 'update' to correct or refine an existing memory, 'delete' to remove something no longer true. When the user says 'remember this', save immediately. Be proactive: if you learn something important, save it now.",
  input_schema: {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: ["save", "update", "delete"],
        description: "The operation to perform",
      },
      memory_id: {
        type: "string",
        description: "ID of existing memory (required for update/delete)",
      },
      content: {
        type: "string",
        description:
          "First-person prose — how you naturally remember this (required for save/update). Write as yourself, not as a database entry.",
      },
      type: {
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
        description: "Category of memory (required for save)",
      },
      significance: {
        type: "number",
        description:
          "How important is this? 0-1. Mundane: 0.2-0.4, important: 0.5-0.7, life events: 0.8-1.0 (optional, defaults to 0.5)",
      },
      emotional_charge: {
        type: "object",
        description: "Emotional context (optional)",
        properties: {
          valence: {
            type: "number",
            description: "Positive vs negative (-1 to 1)",
          },
          intensity: {
            type: "number",
            description: "How strong the feeling (0 to 1)",
          },
        },
      },
    },
    required: ["op"],
  },
};
