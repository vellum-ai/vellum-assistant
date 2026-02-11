/**
 * UI surface tool definitions.
 *
 * These tools allow the model to show, update, and dismiss just-in-time UI
 * surfaces (cards, forms, lists, confirmations) on a connected macOS client.
 * They are proxy tools -- execution is forwarded to the client and never
 * handled locally by the daemon.
 */

import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function proxyExecute(): Promise<ToolExecutionResult> {
  throw new Error('Proxy tool: execution must be forwarded to the connected client');
}

// ---------------------------------------------------------------------------
// ui_show
// ---------------------------------------------------------------------------

export const uiShowTool: Tool = {
  name: 'ui_show',
  description:
    'Show a UI surface to the user. Supported surface types:\n' +
    '- card: Informational card with title, subtitle, body text, and optional metadata key-value pairs. ' +
    'data shape: { title: string, subtitle?: string, body: string, metadata?: Array<{ label: string, value: string }> }\n' +
    '- form: Input form with typed fields. ' +
    'data shape: { description?: string, fields: Array<{ id: string, type: "text"|"textarea"|"select"|"toggle"|"number", label: string, placeholder?: string, required?: boolean, defaultValue?: string|number|boolean, options?: Array<{ label: string, value: string }> }>, submitLabel?: string }\n' +
    '- list: Selectable list of items. ' +
    'data shape: { items: Array<{ id: string, title: string, subtitle?: string, icon?: string, selected?: boolean }>, selectionMode: "single"|"multiple"|"none" }\n' +
    '- confirmation: Yes/no confirmation dialog. ' +
    'data shape: { message: string, detail?: string, confirmLabel?: string, cancelLabel?: string, destructive?: boolean }\n' +
    '- dynamic_page: Custom HTML page rendered in a sandboxed container. ' +
    'data shape: { html: string, width?: number, height?: number }',
  category: 'ui-surface',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'proxy',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          surface_type: {
            type: 'string',
            enum: ['card', 'form', 'list', 'confirmation', 'dynamic_page'],
            description: 'The type of surface to display',
          },
          title: {
            type: 'string',
            description: 'Optional title for the surface window',
          },
          data: {
            type: 'object',
            description: 'Surface data; structure depends on surface_type (see tool description)',
          },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique action identifier' },
                label: { type: 'string', description: 'Button label text' },
                style: {
                  type: 'string',
                  enum: ['primary', 'secondary', 'destructive'],
                  description: 'Visual style of the button',
                },
              },
              required: ['id', 'label'],
            },
            description: 'Optional action buttons to display on the surface',
          },
          await_action: {
            type: 'boolean',
            description: 'Whether to block until the user interacts with an action. Defaults to true when actions are provided.',
          },
        },
        required: ['surface_type', 'data'],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// ui_update
// ---------------------------------------------------------------------------

export const uiUpdateTool: Tool = {
  name: 'ui_update',
  description: "Update an existing surface's data. The provided data object is merged into the surface's current data.",
  category: 'ui-surface',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'proxy',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          surface_id: {
            type: 'string',
            description: 'The ID of the surface to update',
          },
          data: {
            type: 'object',
            description: 'Partial data to merge into the existing surface data',
          },
        },
        required: ['surface_id', 'data'],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// ui_dismiss
// ---------------------------------------------------------------------------

export const uiDismissTool: Tool = {
  name: 'ui_dismiss',
  description: 'Dismiss a currently displayed surface.',
  category: 'ui-surface',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'proxy',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          surface_id: {
            type: 'string',
            description: 'The ID of the surface to dismiss',
          },
        },
        required: ['surface_id'],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// All tools exported as array for convenience
// ---------------------------------------------------------------------------

export const allUiSurfaceTools: Tool[] = [
  uiShowTool,
  uiUpdateTool,
  uiDismissTool,
];
