import type { ToolDefinition } from "../../providers/types.js";

export const memorySearchDefinition: ToolDefinition = {
  name: "memory_search",
  description:
    "Search your memory for previously saved facts, preferences, decisions, and other information. Use this when you need to recall something from past conversations.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Natural language search query describing what you want to recall",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 5)",
      },
      reason: {
        type: "string",
        description:
          "Brief non-technical explanation of what you are looking up and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
      },
    },
    required: ["query"],
  },
};

export const memoryRecallDefinition: ToolDefinition = {
  name: "memory_recall",
  description:
    "Deep search across all memory sources (semantic, lexical, entity graph, recency) for specific information. Use this when you need to recall details about past conversations, decisions, preferences, project context, or any prior knowledge. Returns formatted memory context. Prefer this over memory_search for richer, multi-source retrieval.",
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

export const memorySaveDefinition: ToolDefinition = {
  name: "memory_save",
  description:
    "Save a fact, preference, decision, or other noteworthy information to memory for future recall. Use this when the user shares something worth remembering.",
  input_schema: {
    type: "object",
    properties: {
      statement: {
        type: "string",
        description: "The fact or preference to remember (1-2 sentences)",
      },
      kind: {
        type: "string",
        enum: [
          "preference",
          "fact",
          "decision",
          "profile",
          "relationship",
          "event",
          "opinion",
          "instruction",
          "style",
          "playbook",
          "learning",
        ],
        description: "Category of the memory item",
      },
      subject: {
        type: "string",
        description: "Short subject/topic label (2-8 words)",
      },
      reason: {
        type: "string",
        description:
          "Brief non-technical explanation of what you are saving and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
      },
    },
    required: ["statement", "kind"],
  },
};

export const memoryUpdateDefinition: ToolDefinition = {
  name: "memory_update",
  description:
    "Update or correct an existing memory item. Use this when previously saved information needs to be changed.",
  input_schema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description:
          "ID of the memory item to update (from memory_search results)",
      },
      statement: {
        type: "string",
        description: "The updated statement to replace the existing one",
      },
      reason: {
        type: "string",
        description:
          "Brief non-technical explanation of what you are updating and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
      },
    },
    required: ["memory_id", "statement"],
  },
};

export const memoryDeleteDefinition: ToolDefinition = {
  name: "memory_delete",
  description:
    "Delete a previously saved memory item. Use this when information is no longer relevant, was saved in error, or the user asks to forget something.",
  input_schema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description:
          "ID of the memory item to delete (from memory_search results)",
      },
      reason: {
        type: "string",
        description:
          "Brief non-technical explanation of what you are deleting and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
      },
    },
    required: ["memory_id"],
  },
};
