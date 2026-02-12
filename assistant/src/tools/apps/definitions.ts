/**
 * App tool definitions.
 *
 * These tools allow the model to create, list, update, open, query, and delete
 * persistent user-defined apps.  Most are local tools that call functions in
 * the app-store data layer; `app_open` is a proxy tool forwarded to the
 * connected macOS client (same pattern as ui_show).
 */

import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolExecutionResult, ToolContext } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import * as appStore from '../../memory/app-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function proxyExecute(): Promise<ToolExecutionResult> {
  throw new Error('Proxy tool: execution must be forwarded to the connected client');
}

// ---------------------------------------------------------------------------
// app_create
// ---------------------------------------------------------------------------

export const appCreateTool: Tool = {
  name: 'app_create',
  description:
    'Create a persistent app with a name, optional description, JSON schema, and HTML definition.',
  category: 'apps',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'local',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the app',
          },
          description: {
            type: 'string',
            description: 'Optional description of the app',
          },
          schema_json: {
            type: 'string',
            description: 'JSON schema defining the app data structure',
          },
          html: {
            type: 'string',
            description: 'HTML definition for rendering the app',
          },
        },
        required: ['name', 'schema_json', 'html'],
      },
    };
  },

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const name = input.name as string;
    const description = input.description as string | undefined;
    const schemaJson = input.schema_json as string;
    const htmlDefinition = input.html as string;

    const app = appStore.createApp({ name, description, schemaJson, htmlDefinition });
    return { content: JSON.stringify(app), isError: false };
  },
};

// ---------------------------------------------------------------------------
// app_open
// ---------------------------------------------------------------------------

export const appOpenTool: Tool = {
  name: 'app_open',
  description:
    'Open a persistent app in a dynamic_page surface on the connected client.',
  category: 'apps',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'proxy',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          app_id: {
            type: 'string',
            description: 'The ID of the app to open',
          },
        },
        required: ['app_id'],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// app_list
// ---------------------------------------------------------------------------

export const appListTool: Tool = {
  name: 'app_list',
  description: 'List all persistent apps. Returns an array of {id, name, description, updatedAt}.',
  category: 'apps',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'local',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {},
      },
    };
  },

  async execute(_input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const apps = appStore.listApps().map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      updatedAt: a.updatedAt,
    }));
    return { content: JSON.stringify(apps), isError: false };
  },
};

// ---------------------------------------------------------------------------
// app_query
// ---------------------------------------------------------------------------

export const appQueryTool: Tool = {
  name: 'app_query',
  description: 'Query all records for a persistent app. Returns an array of records.',
  category: 'apps',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'local',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          app_id: {
            type: 'string',
            description: 'The ID of the app to query records for',
          },
        },
        required: ['app_id'],
      },
    };
  },

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const appId = input.app_id as string;
    const records = appStore.queryAppRecords(appId);
    return { content: JSON.stringify(records), isError: false };
  },
};

// ---------------------------------------------------------------------------
// app_update
// ---------------------------------------------------------------------------

export const appUpdateTool: Tool = {
  name: 'app_update',
  description:
    'Update a persistent app definition. Provide the app_id and any fields to update (name, description, schema_json, html).',
  category: 'apps',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'local',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          app_id: {
            type: 'string',
            description: 'The ID of the app to update',
          },
          name: {
            type: 'string',
            description: 'Updated name for the app',
          },
          description: {
            type: 'string',
            description: 'Updated description for the app',
          },
          schema_json: {
            type: 'string',
            description: 'Updated JSON schema',
          },
          html: {
            type: 'string',
            description: 'Updated HTML definition',
          },
        },
        required: ['app_id'],
      },
    };
  },

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const appId = input.app_id as string;
    const updates: Partial<Pick<appStore.AppDefinition, 'name' | 'description' | 'schemaJson' | 'htmlDefinition'>> = {};
    if (typeof input.name === 'string') updates.name = input.name;
    if (typeof input.description === 'string') updates.description = input.description;
    if (typeof input.schema_json === 'string') updates.schemaJson = input.schema_json;
    if (typeof input.html === 'string') updates.htmlDefinition = input.html;

    const app = appStore.updateApp(appId, updates);
    return { content: JSON.stringify(app), isError: false };
  },
};

// ---------------------------------------------------------------------------
// app_delete
// ---------------------------------------------------------------------------

export const appDeleteTool: Tool = {
  name: 'app_delete',
  description: 'Delete a persistent app and all its records.',
  category: 'apps',
  defaultRiskLevel: RiskLevel.Low,
  executionMode: 'local',

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          app_id: {
            type: 'string',
            description: 'The ID of the app to delete',
          },
        },
        required: ['app_id'],
      },
    };
  },

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const appId = input.app_id as string;
    appStore.deleteApp(appId);
    return { content: JSON.stringify({ deleted: true, appId }), isError: false };
  },
};

// ---------------------------------------------------------------------------
// All tools exported as array for convenience
// ---------------------------------------------------------------------------

export const allAppTools: Tool[] = [
  appCreateTool,
  appOpenTool,
  appListTool,
  appQueryTool,
  appUpdateTool,
  appDeleteTool,
];
