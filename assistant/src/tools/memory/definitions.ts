import type { ToolDefinition } from '../../providers/types.js';

export const memorySearchDefinition: ToolDefinition = {
  name: 'memory_search',
  description: 'Search your memory for previously saved facts, preferences, decisions, and other information. Use this when you need to recall something from past conversations.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language search query describing what you want to recall',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 5)',
      },
    },
    required: ['query'],
  },
};

export const memorySaveDefinition: ToolDefinition = {
  name: 'memory_save',
  description: 'Save a fact, preference, decision, or other noteworthy information to memory for future recall. Use this when the user shares something worth remembering.',
  input_schema: {
    type: 'object',
    properties: {
      statement: {
        type: 'string',
        description: 'The fact or preference to remember (1-2 sentences)',
      },
      kind: {
        type: 'string',
        enum: ['preference', 'fact', 'decision', 'profile', 'relationship', 'event', 'opinion', 'instruction'],
        description: 'Category of the memory item',
      },
      subject: {
        type: 'string',
        description: 'Short subject/topic label (2-8 words)',
      },
    },
    required: ['statement', 'kind'],
  },
};

export const memoryUpdateDefinition: ToolDefinition = {
  name: 'memory_update',
  description: 'Update or correct an existing memory item. Use this when previously saved information needs to be changed.',
  input_schema: {
    type: 'object',
    properties: {
      memory_id: {
        type: 'string',
        description: 'ID of the memory item to update (from memory_search results)',
      },
      statement: {
        type: 'string',
        description: 'The updated statement to replace the existing one',
      },
    },
    required: ['memory_id', 'statement'],
  },
};

export const memoryToolDefinitions: ToolDefinition[] = [
  memorySearchDefinition,
  memorySaveDefinition,
  memoryUpdateDefinition,
];
