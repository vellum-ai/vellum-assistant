/**
 * Core app proxy tool definitions.
 *
 * Only the `app_open` proxy tool remains here -- it is forwarded to the
 * connected macOS client (same pattern as ui_show).  All non-proxy data
 * tools (create, list, query, update, delete, file ops) are now provided
 * by the bundled app-builder skill via its TOOLS.json manifest and
 * executor scripts.
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
// app_open
// ---------------------------------------------------------------------------

const appOpenTool: Tool = {
  name: "app_open",
  description:
    "Open a persistent app in a dynamic_page surface on the connected client.",
  category: "apps",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          app_id: {
            type: "string",
            description: "The ID of the app to open",
          },
          open_mode: {
            type: "string",
            enum: ["preview", "workspace"],
            description:
              "Display mode. 'preview' shows an inline preview card in chat. 'workspace' opens the full app in a workspace panel. Defaults to 'workspace'.",
          },
        },
        required: ["app_id"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// Proxy-only tools registered in the core daemon registry
// ---------------------------------------------------------------------------

export const coreAppProxyTools: Tool[] = [appOpenTool];
