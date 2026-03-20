import type { ToolDefinition } from "../../providers/types.js";

export const memoryRecallDefinition: ToolDefinition = {
  name: "memory_recall",
  description:
    "Search across memory (keyword-based) for specific information. Relevant memories are auto-injected each turn, so only call this when the auto-injected context doesn't contain what you need - e.g. the user references a past session, or you need deeper recall. Be specific in your query for best results.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query - be specific and descriptive",
      },
    },
    required: ["query"],
  },
};

export const memoryManageDefinition: ToolDefinition = {
  name: "memory_manage",
  description:
    "Save observations to memory. Memory does not survive session restarts - if you want to remember something, save it now. Use 'save' for new information worth remembering (facts, preferences, mistakes, discoveries, gotchas). When a user says 'remember this', save immediately. For user profile or personality changes, update workspace files (USER.md, SOUL.md) instead.",
  input_schema: {
    type: "object",
    properties: {
      op: {
        type: "string" as const,
        enum: ["save"],
        description: "The operation to perform",
      },
      statement: {
        type: "string" as const,
        description:
          "The fact or preference to remember (required, 1-2 sentences)",
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
          'Category of the memory observation (required). Use "constraint" for mistakes, gotchas, discoveries, and working solutions - write as advice to your future self.',
      },
      subject: {
        type: "string" as const,
        description: "Short subject/topic label, 2-8 words (optional)",
      },
    },
    required: ["op", "statement", "kind"],
  },
};
