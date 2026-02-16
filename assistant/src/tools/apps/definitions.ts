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
            description: 'HTML definition for rendering the app (main index.html page)',
          },
          pages: {
            type: 'object',
            description:
              'Optional additional pages as a mapping of filename to HTML content ' +
              '(e.g. {"settings.html": "<html>...</html>"}). Navigate between pages ' +
              'with <a href="settings.html">. Do not include index.html here — use the html parameter instead.',
            additionalProperties: { type: 'string' },
          },
          type: {
            type: 'string',
            enum: ['app', 'site'],
            description: "Type of creation: 'app' for interactive apps with data/state, 'site' for presentational content (portfolios, landing pages, blogs)",
          },
          auto_open: {
            type: 'boolean',
            description:
              'Automatically open the app after creation. Defaults to true. ' +
              'When true, the app is immediately displayed in a dynamic_page surface ' +
              'without needing a separate app_open call.',
          },
          preview: {
            type: 'object',
            description:
              'Optional inline preview card shown in chat. ' +
              'Provides a compact summary so the user sees what was built without opening the app.',
            properties: {
              title: { type: 'string', description: 'Preview card title' },
              subtitle: { type: 'string', description: 'Optional subtitle' },
              description: { type: 'string', description: 'Optional short description' },
              icon: { type: 'string', description: 'Optional emoji icon' },
              metrics: {
                type: 'array',
                description: 'Optional key-value metrics',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    value: { type: 'string' },
                  },
                  required: ['label', 'value'],
                },
              },
            },
            required: ['title'],
          },
        },
        required: ['name', 'html'],
      },
    };
  },

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const name = input.name as string;
    const description = input.description as string | undefined;
    const schemaJson = (input.schema_json as string | undefined) ?? '{}';
    const htmlDefinition = input.html as string;
    const pages = input.pages as Record<string, string> | undefined;
    const autoOpen = input.auto_open !== false; // default true
    const preview = input.preview as Record<string, unknown> | undefined;
    const appType = (input.type as string | undefined) === 'site' ? 'site' as const : 'app' as const;

    const app = appStore.createApp({ name, description, schemaJson, htmlDefinition, pages, appType });

    // Auto-open the app via the proxy resolver if available
    if (autoOpen && context.proxyToolResolver) {
      try {
        const openResult = await context.proxyToolResolver('app_open', { app_id: app.id, preview });
        return {
          content: JSON.stringify({
            ...app,
            auto_opened: true,
            open_result: openResult.content,
          }),
          isError: false,
        };
      } catch {
        // App was created successfully but auto-open failed; return creation result with a note
        return {
          content: JSON.stringify({
            ...app,
            auto_opened: false,
            auto_open_error: 'Failed to auto-open app. Use app_open to open it manually.',
          }),
          isError: false,
        };
      }
    }

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
          pages: {
            type: 'object',
            description:
              'Updated additional pages as a mapping of filename to HTML content.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['app_id'],
      },
    };
  },

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const appId = input.app_id as string;
    const updates: Partial<Pick<appStore.AppDefinition, 'name' | 'description' | 'schemaJson' | 'htmlDefinition' | 'pages'>> = {};
    if (typeof input.name === 'string') updates.name = input.name;
    if (typeof input.description === 'string') updates.description = input.description;
    if (typeof input.schema_json === 'string') updates.schemaJson = input.schema_json;
    if (typeof input.html === 'string') updates.htmlDefinition = input.html;
    if (input.pages && typeof input.pages === 'object') updates.pages = input.pages as Record<string, string>;

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
// app_file_list
// ---------------------------------------------------------------------------

export const appFileListTool: Tool = {
  name: 'app_file_list',
  description: 'List all files in an app. Returns a JSON array of file paths.',
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
            description: 'The ID of the app',
          },
        },
        required: ['app_id'],
      },
    };
  },

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const appId = input.app_id as string;
    const files = appStore.listAppFiles(appId);
    return { content: JSON.stringify(files), isError: false };
  },
};

// ---------------------------------------------------------------------------
// app_file_read
// ---------------------------------------------------------------------------

export const appFileReadTool: Tool = {
  name: 'app_file_read',
  description:
    'Read the contents of a file in an app. Returns content with line numbers in cat -n format.',
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
            description: 'The ID of the app',
          },
          path: {
            type: 'string',
            description: 'Relative file path within the app',
          },
          offset: {
            type: 'number',
            description: '1-based line number to start reading from (default: 1)',
          },
          limit: {
            type: 'number',
            description: 'Number of lines to return (default: all)',
          },
        },
        required: ['app_id', 'path'],
      },
    };
  },

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const appId = input.app_id as string;
    const path = input.path as string;
    const offset = (input.offset as number | undefined) ?? 1;
    const limit = input.limit as number | undefined;

    const raw = appStore.readAppFile(appId, path);
    const allLines = raw.split('\n');
    const startIndex = Math.max(0, offset - 1);
    const sliced = limit != null ? allLines.slice(startIndex, startIndex + limit) : allLines.slice(startIndex);

    const formatted = sliced
      .map((line, i) => {
        const lineNum = startIndex + i + 1;
        return `${String(lineNum).padStart(6)}\t${line}`;
      })
      .join('\n');

    return { content: formatted, isError: false };
  },
};

// ---------------------------------------------------------------------------
// app_file_edit
// ---------------------------------------------------------------------------

export const appFileEditTool: Tool = {
  name: 'app_file_edit',
  description:
    'Edit a file in an app by replacing a string. Uses exact match-and-replace.',
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
            description: 'The ID of the app',
          },
          path: {
            type: 'string',
            description: 'Relative file path within the app',
          },
          old_string: {
            type: 'string',
            description: 'The exact string to find and replace',
          },
          new_string: {
            type: 'string',
            description: 'The replacement string',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences instead of just the first (default: false)',
          },
          status: {
            type: 'string',
            description:
              "Optional short human-readable progress message shown to the user (e.g. 'adding dark mode styles')",
          },
        },
        required: ['app_id', 'path', 'old_string', 'new_string'],
      },
    };
  },

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const appId = input.app_id as string;
    const path = input.path as string;
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean | undefined) ?? false;

    const result = appStore.editAppFile(appId, path, oldString, newString, replaceAll);
    return { content: JSON.stringify(result), isError: false };
  },
};

// ---------------------------------------------------------------------------
// app_file_write
// ---------------------------------------------------------------------------

export const appFileWriteTool: Tool = {
  name: 'app_file_write',
  description: 'Write (create or overwrite) a file in an app.',
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
            description: 'The ID of the app',
          },
          path: {
            type: 'string',
            description: 'Relative file path within the app',
          },
          content: {
            type: 'string',
            description: 'The content to write to the file',
          },
          status: {
            type: 'string',
            description:
              "Optional short human-readable progress message shown to the user (e.g. 'adding dark mode styles')",
          },
        },
        required: ['app_id', 'path', 'content'],
      },
    };
  },

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const appId = input.app_id as string;
    const path = input.path as string;
    const content = input.content as string;

    appStore.writeAppFile(appId, path, content);
    return { content: JSON.stringify({ written: true, path }), isError: false };
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
  appFileListTool,
  appFileReadTool,
  appFileEditTool,
  appFileWriteTool,
];
