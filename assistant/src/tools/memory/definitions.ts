import type { ToolDefinition } from "../../providers/types.js";

export const memoryRecallDefinition: ToolDefinition = {
  name: "memory_recall",
  description:
    "Hybrid search across memory (semantic and recency) for specific information. Relevant memories are auto-injected each turn, so only call this when the auto-injected context doesn't contain what you need - e.g. the user references a past session, or you need deeper recall. Be specific in your query for best results. Returns formatted memory context with item IDs for use with memory_manage.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query - be specific and descriptive",
      },
      scope: {
        type: "string",
        enum: ["default", "conversation"],
        description:
          'Scope to search - "default" searches all memory, "conversation" restricts to current conversation',
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
    description:
      'Category of the memory item (required for save). Use "constraint" for mistakes, gotchas, discoveries, and working solutions - write as advice to your future self.',
  },
  subject: {
    type: "string" as const,
    description: "Short subject/topic label, 2-8 words (optional, save only)",
  },
};

export const memoryManageDefinition: ToolDefinition = {
  name: "memory_manage",
  description:
    "Save, update, or delete memory items. If you want to remember something, save it now. Use 'save' for new information worth remembering (facts, preferences, mistakes, discoveries, gotchas), 'update' to correct existing items, 'delete' to remove outdated items. When a user says 'remember this', save immediately. Be proactive: if you learn something important that may be useful in the future, always call this tool — don't just say or hope you'll remember it. This is not a substitute for updating workspace files when relevant - do both.",
  input_schema: {
    type: "object",
    properties: memoryManageProperties,
    required: ["op"],
  },
};
