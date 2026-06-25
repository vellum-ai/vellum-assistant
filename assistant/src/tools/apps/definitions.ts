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
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Forward execution to the connected macOS client via the request-bound
 * `proxyToolResolver`. Returns a structured error when no resolver is
 * configured (e.g. no client connected) so callers see a normal tool
 * failure rather than an unhandled throw.
 */
function proxyExecute(toolName: string) {
  return async (
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> => {
    if (!context.proxyToolResolver) {
      return {
        content: `No proxy resolver configured for proxy tool "${toolName}". This tool requires an external resolver (e.g. a connected macOS client).`,
        isError: true,
      };
    }
    return context.proxyToolResolver(toolName, input);
  };
}

// ---------------------------------------------------------------------------
// app_open
// ---------------------------------------------------------------------------

const appOpenTool = {
  name: "app_open",
  description:
    "Open a persistent app in a dynamic_page surface on the connected client.",
  category: "apps",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

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

  execute: proxyExecute("app_open"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// Proxy-only tools registered in the core daemon registry
// ---------------------------------------------------------------------------

export const coreAppProxyTools: ToolDefinition[] = [appOpenTool];
