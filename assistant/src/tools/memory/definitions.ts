import type { ToolDefinition } from "../../providers/types.js";

export const memoryRecallDefinition: ToolDefinition = {
  name: "memory_recall",
  description:
    "Deep search across all memory sources (semantic, lexical, entity graph, recency) for specific information. Use this when you need to recall details about past conversations, decisions, preferences, project context, or any prior knowledge. Returns formatted memory context with item IDs for use with memory_manage.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query — be specific and descriptive",
      },
      max_results: {
        type: "number",
        description: "Maximum number of memory items to return (default: 10)",
      },
      scope: {
        type: "string",
        enum: ["default", "conversation"],
        description:
          'Scope to search — "default" searches all memory, "conversation" restricts to current thread',
      },
    },
    required: ["query"],
  },
};

const memoryManageProperties = {
  op: {
    type: "string" as const,
    enum: ["save", "update", "delete"],
    description: "The operation to perform",
  },
  memory_id: {
    type: "string" as const,
    description: "ID of existing memory item (required for update/delete)",
  },
  statement: {
    type: "string" as const,
    description:
      "The fact or preference to remember (required for save/update, 1-2 sentences)",
  },
  kind: {
    type: "string" as const,
    enum: [
      "identity",
      "preference",
      "project",
      "decision",
      "constraint",
      "event",
    ],
    description: "Category of the memory item (required for save)",
  },
  subject: {
    type: "string" as const,
    description: "Short subject/topic label, 2-8 words (optional, save only)",
  },
};

export const memoryManageDefinition: ToolDefinition = {
  name: "memory_manage",
  description:
    "Save, update, or delete memory items. Use 'save' for new information worth remembering, 'update' to correct existing items, 'delete' to remove outdated items.",
  input_schema: {
    type: "object",
    properties: memoryManageProperties,
    required: ["op"],
  },
};
