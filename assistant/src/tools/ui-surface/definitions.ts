/**
 * UI surface tool definitions.
 *
 * These tools allow the model to show, update, and dismiss just-in-time UI
 * surfaces (cards, forms, lists, confirmations) on a connected macOS client.
 * They are proxy tools -- execution is forwarded to the client and never
 * handled locally by the daemon.
 */

import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import type { Tool, ToolExecutionResult } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function proxyExecute(): Promise<ToolExecutionResult> {
  throw new Error(
    "Proxy tool: execution must be forwarded to the connected client",
  );
}

// ---------------------------------------------------------------------------
// ui_show
// ---------------------------------------------------------------------------

export const uiShowTool: Tool = {
  name: "ui_show",
  description:
    'Show structured data or UI to the user. Use for displaying weather, flights, stock prices, quick tables, cards, lists, forms, or any temporary data visualization. Use display: "inline" (default) to embed in chat, or "panel" for a floating window. For long-form writing use the document skill instead; for interactive apps use the app-builder skill instead.\n\n' +
    "Supported surface types:\n" +
    "- card: Informational card with title, subtitle, body text, and optional metadata key-value pairs. " +
    "Cards support an optional template field for specialized native rendering. " +
    "data shape: { title: string, subtitle?: string, body: string, metadata?: Array<{ label: string, value: string }>, template?: string, templateData?: object }\n" +
    '  Template "weather_forecast": renders an Apple Weather-style forecast widget. ' +
    'templateData shape: { location: string, currentTemp: number, feelsLike: number, unit: "F"|"C", condition: string, humidity: number, windSpeed: number, windDirection: string, ' +
    "hourly: Array<{ time: string, icon: string (SF Symbol name), temp: number }>, " +
    "forecast: Array<{ day: string, icon: string (SF Symbol name), low: number, high: number, precip: number|null, condition: string }> }\n" +
    '  Template "task_progress": renders a live-updating task progress widget showing structured step-by-step progress. ' +
    'templateData shape: { title: string, status: "in_progress"|"completed"|"failed", ' +
    'steps: Array<{ label: string, status: "pending"|"in_progress"|"completed"|"failed", detail?: string }> }\n' +
    "- table: Data table with columns, selectable rows, and action buttons. " +
    'data shape: { columns: Array<{ id: string, label: string, width?: number }>, rows: Array<{ id: string, cells: Record<string, string | { text: string, icon?: string, iconColor?: "success"|"warning"|"error"|"muted" }>, selectable?: boolean, selected?: boolean }>, selectionMode?: "none"|"single"|"multiple", caption?: string }. ' +
    "Cell values can be plain strings or rich objects with icon (SF Symbol name) and iconColor. " +
    "Column width is in points - use it for narrow columns (e.g. counts, short labels) so flexible columns get more space. Omit width for columns that should expand.\n" +
    "- form: Input form with typed fields. " +
    'data shape: { description?: string, fields: Array<{ id: string, type: "text"|"textarea"|"select"|"toggle"|"number"|"password", label: string, placeholder?: string, required?: boolean, defaultValue?: string|number|boolean, options?: Array<{ label: string, value: string }> }>, submitLabel?: string }. ' +
    "For multi-page forms, use pages array instead of top-level fields: { pages: [{ id: string, title: string, description?: string, fields: [...] }], pageLabels?: { next?: string, back?: string, submit?: string }, submitLabel?: string }\n" +
    "- list: Selectable list of items. " +
    'data shape: { items: Array<{ id: string, title: string, subtitle?: string, icon?: string, selected?: boolean }>, selectionMode: "single"|"multiple"|"none" }\n' +
    "- confirmation: Yes/no confirmation dialog. " +
    "data shape: { message: string, detail?: string, confirmLabel?: string, confirmedLabel?: string, cancelLabel?: string, destructive?: boolean }\n" +
    "- dynamic_page: Custom HTML page rendered in a sandboxed container. " +
    "data shape: { html: string, width?: number, height?: number, preview?: { title: string, subtitle?: string, description?: string, icon?: string (emoji), metrics?: Array<{ label: string, value: string }> } }. " +
    'When preview is provided, a compact preview card is shown inline in chat with the title, subtitle, description, metric pills, and a "View Output" button that opens the full page.\n' +
    "- file_upload: File upload dialog where the user can drag-and-drop or browse for files. " +
    "data shape: { prompt: string, acceptedTypes?: string[], maxFiles?: number }\n\n" +
    "Action payload conventions:\n" +
    "- Multi-select tables: use `window.vellum.sendAction(actionId, { selectedIds: [...] })` to send selected row IDs\n" +
    "- Bulk actions: include `selectedRows` array with full row data for context\n\n" +
    "Presenting choices: When the user needs to make a choice or provide structured input, prefer interactive surfaces over plain text. " +
    "Use list (2-8 options, single select), form (structured input with typed fields), confirmation (destructive/important actions), or table (data review with selectable rows).\n\n" +
    "Tool chaining: After gathering data via tools (web search, browser, APIs), synthesize results into a visual output.\n\n" +
    'Task progress for multi-step workflows: Create a card with template "task_progress" and templateData containing steps. ' +
    "As each step completes, call ui_update to patch data.templateData (not top-level fields). " +
    'Set templateData.status to "completed" or "failed" when done.',
  category: "ui-surface",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          surface_type: {
            type: "string",
            enum: [
              "card",
              "form",
              "list",
              "table",
              "confirmation",
              "dynamic_page",
              "file_upload",
            ],
            description: "The type of surface to display",
          },
          title: {
            type: "string",
            description: "Optional title for the surface window",
          },
          data: {
            type: "object",
            description:
              "Surface data; structure depends on surface_type (see tool description)",
          },
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Unique action identifier" },
                label: { type: "string", description: "Button label text" },
                style: {
                  type: "string",
                  enum: ["primary", "secondary", "destructive"],
                  description: "Visual style of the button",
                },
              },
              required: ["id", "label"],
            },
            description: "Optional action buttons to display on the surface",
          },
          display: {
            type: "string",
            enum: ["inline", "panel"],
            description:
              'Where to render the surface. "inline" embeds it in the chat message. "panel" shows a floating window. Defaults to "inline".',
          },
          await_action: {
            type: "boolean",
            description:
              "Whether to block until the user interacts with an action. Defaults to true when actions are provided.",
          },
        },
        required: ["surface_type", "data"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// ui_update
// ---------------------------------------------------------------------------

export const uiUpdateTool: Tool = {
  name: "ui_update",
  description:
    "Update an existing surface's data. The provided data object is merged into the surface's current data.\n" +
    "For card templates (for example `task_progress`), update nested fields under `data.templateData` rather than sending template fields at the top level.",
  category: "ui-surface",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          surface_id: {
            type: "string",
            description: "The ID of the surface to update",
          },
          data: {
            type: "object",
            description: "Partial data to merge into the existing surface data",
          },
        },
        required: ["surface_id", "data"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// ui_dismiss
// ---------------------------------------------------------------------------

export const uiDismissTool: Tool = {
  name: "ui_dismiss",
  description: "Dismiss a currently displayed surface.",
  category: "ui-surface",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          surface_id: {
            type: "string",
            description: "The ID of the surface to dismiss",
          },
        },
        required: ["surface_id"],
      },
    };
  },

  execute: proxyExecute,
};

export const allUiSurfaceTools: Tool[] = [
  uiShowTool,
  uiUpdateTool,
  uiDismissTool,
];
