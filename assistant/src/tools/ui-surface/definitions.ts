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
    "Show structured data or UI to the user. For long-form writing use the document skill; for interactive apps use the app-builder skill.\n\n" +
    "Surface types (data shapes):\n" +
    '- card: { title, subtitle?, body, metadata?: [{ label, value }], template?, templateData? }. Templates: "weather_forecast" (native weather widget), "task_progress" (live step tracker - update via ui_update on data.templateData; shape: { title, status: "in_progress"|"completed"|"failed", steps: [{ label, status: "pending"|"in_progress"|"completed"|"failed", detail? }] })\n' +
    '- table: { columns: [{ id, label }], rows: [{ id, cells: Record<id, string | { text, icon?, iconColor?: "success"|"warning"|"error"|"muted" }>, selectable?, selected? }], selectionMode?: "none"|"single"|"multiple", caption? }\n' +
    '- form: { description?, fields: [{ id, type: "text"|"textarea"|"select"|"toggle"|"number"|"password", label, placeholder?, required?, defaultValue?, options?: [{ label, value }] }], submitLabel? }. Multi-page: { pages: [{ id, title, description?, fields }], pageLabels?: { next?, back?, submit? }, submitLabel? }\n' +
    '- list: { items: [{ id, title, subtitle?, icon?, selected? }], selectionMode: "single"|"multiple"|"none" }\n' +
    "- confirmation: { message, detail?, confirmLabel?, confirmedLabel?, cancelLabel?, destructive? }\n" +
    "- dynamic_page: { html, width?, height?, preview?: { title, subtitle?, description?, icon?, metrics?: [{ label, value }] } }\n" +
    "- file_upload: { prompt, acceptedTypes?, maxFiles? }",
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
              'Where to render the surface. "inline" embeds it in the chat message. "panel" shows a floating window. Defaults to "inline". Prefer inline — only use panel when the user explicitly asks for a separate window.',
          },
          await_action: {
            type: "boolean",
            description:
              "Whether to block until the user interacts with an action. Defaults to true when actions are provided.",
          },
          persistent: {
            type: "boolean",
            description:
              "When true, clicking an action does not dismiss the surface — the card stays visible and only the clicked action is marked as spent. Use for launcher or menu-style cards where the user may click multiple buttons. Defaults to false.",
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
