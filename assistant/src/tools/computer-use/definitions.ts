/**
 * Computer-use tool definitions.
 *
 * These tools mirror the macOS client's ToolDefinitions.swift schemas, prefixed
 * with `computer_use_` to avoid collisions with existing daemon tools.  They are all
 * proxy tools - execution is forwarded to a connected macOS client and never
 * handled locally by the daemon.
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
        content: `No proxy resolver configured for proxy tool "${toolName}". This tool requires an external resolver (e.g. a connected macOS client for computer-use tools).`,
        isError: true,
      };
    }
    return context.proxyToolResolver(toolName, input);
  };
}

// ---------------------------------------------------------------------------
// click (unified - click_type selects single / double / right)
// ---------------------------------------------------------------------------

export const computerUseClickTool = {
  name: "computer_use_click",
  description:
    "Click an element on screen. Prefer element_id (from the accessibility tree) over x/y coordinates.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      click_type: {
        type: "string",
        enum: ["single", "double", "right"],
        description: 'Type of click to perform (default: "single")',
      },
      element_id: {
        type: "integer",
        description:
          "The [ID] number of the element from the accessibility tree (preferred)",
      },
      x: {
        type: "integer",
        description: "X coordinate on screen (fallback when no element_id)",
      },
      y: {
        type: "integer",
        description: "Y coordinate on screen (fallback when no element_id)",
      },
      reasoning: {
        type: "string",
        description:
          "Explanation of what you see and why you are clicking here",
      },
      target_client_id: {
        type: "string",
        description:
          "ID of the specific client to target. Required when multiple clients support host_cu; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_cu`.",
      },
    },
    required: ["reasoning"],
  },

  execute: proxyExecute("computer_use_click"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// type_text
// ---------------------------------------------------------------------------

export const computerUseTypeTextTool = {
  name: "computer_use_type_text",
  description:
    "Type text at the current cursor position. First click a text field (by element_id) to focus it, then call this tool. If a field shows 'FOCUSED', skip the click.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text to type",
      },
      reasoning: {
        type: "string",
        description: "Explanation of what you are typing and why",
      },
      target_client_id: {
        type: "string",
        description:
          "ID of the specific client to target. Required when multiple clients support host_cu; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_cu`.",
      },
    },
    required: ["text", "reasoning"],
  },

  execute: proxyExecute("computer_use_type_text"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// key
// ---------------------------------------------------------------------------

export const computerUseKeyTool = {
  name: "computer_use_key",
  description:
    "Press a key or keyboard shortcut. Supported: enter, tab, escape, backspace, delete, up, down, left, right, space, cmd+a, cmd+c, cmd+v, cmd+z, cmd+tab, cmd+w, shift+tab, option+tab",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Key or shortcut to press (e.g. enter, tab, cmd+c, cmd+v)",
      },
      reasoning: {
        type: "string",
        description: "Explanation of why you are pressing this key",
      },
      target_client_id: {
        type: "string",
        description:
          "ID of the specific client to target. Required when multiple clients support host_cu; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_cu`.",
      },
    },
    required: ["key", "reasoning"],
  },

  execute: proxyExecute("computer_use_key"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// scroll
// ---------------------------------------------------------------------------

export const computerUseScrollTool = {
  name: "computer_use_scroll",
  description:
    "Scroll within an element by its [ID], or at raw screen coordinates as fallback.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      element_id: {
        type: "integer",
        description:
          "The [ID] number of the element to scroll within (preferred)",
      },
      x: {
        type: "integer",
        description: "X coordinate on screen (fallback when no element_id)",
      },
      y: {
        type: "integer",
        description: "Y coordinate on screen (fallback when no element_id)",
      },
      direction: {
        type: "string",
        enum: ["up", "down", "left", "right"],
        description: "Scroll direction",
      },
      amount: {
        type: "integer",
        description: "Scroll amount (1-10)",
      },
      reasoning: {
        type: "string",
        description: "Explanation of why you are scrolling",
      },
      target_client_id: {
        type: "string",
        description:
          "ID of the specific client to target. Required when multiple clients support host_cu; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_cu`.",
      },
    },
    required: ["direction", "amount", "reasoning"],
  },

  execute: proxyExecute("computer_use_scroll"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// drag
// ---------------------------------------------------------------------------

export const computerUseDragTool = {
  name: "computer_use_drag",
  description:
    "Drag from one element or position to another. Use for moving files, resizing windows, rearranging items, or adjusting sliders.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      element_id: {
        type: "integer",
        description: "The [ID] of the source element to drag from (preferred)",
      },
      x: {
        type: "integer",
        description: "Source X coordinate (fallback when no element_id)",
      },
      y: {
        type: "integer",
        description: "Source Y coordinate (fallback when no element_id)",
      },
      to_element_id: {
        type: "integer",
        description:
          "The [ID] of the destination element to drag to (preferred)",
      },
      to_x: {
        type: "integer",
        description:
          "Destination X coordinate (fallback when no to_element_id)",
      },
      to_y: {
        type: "integer",
        description:
          "Destination Y coordinate (fallback when no to_element_id)",
      },
      reasoning: {
        type: "string",
        description: "Explanation of what you are dragging and why",
      },
      target_client_id: {
        type: "string",
        description:
          "ID of the specific client to target. Required when multiple clients support host_cu; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_cu`.",
      },
    },
    required: ["reasoning"],
  },

  execute: proxyExecute("computer_use_drag"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// wait
// ---------------------------------------------------------------------------

export const computerUseWaitTool = {
  name: "computer_use_wait",
  description: "Wait for the UI to update",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      duration_ms: {
        type: "integer",
        description: "Milliseconds to wait",
      },
      reasoning: {
        type: "string",
        description: "Explanation of what you are waiting for",
      },
      target_client_id: {
        type: "string",
        description:
          "ID of the specific client to target. Required when multiple clients support host_cu; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_cu`.",
      },
    },
    required: ["duration_ms", "reasoning"],
  },

  execute: proxyExecute("computer_use_wait"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// open_app
// ---------------------------------------------------------------------------

export const computerUseOpenAppTool = {
  name: "computer_use_open_app",
  description:
    "Open or switch to a macOS application by name. Preferred over cmd+tab for switching apps - more reliable and explicit.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      app_name: {
        type: "string",
        description:
          'The name of the application to open (e.g. "Slack", "Safari", "Google Chrome", "VS Code")',
      },
      reasoning: {
        type: "string",
        description:
          "Explanation of why you need to open or switch to this app",
      },
      target_client_id: {
        type: "string",
        description:
          "ID of the specific client to target. Required when multiple clients support host_cu; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_cu`.",
      },
    },
    required: ["app_name", "reasoning"],
  },

  execute: proxyExecute("computer_use_open_app"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// run_applescript
// ---------------------------------------------------------------------------

export const computerUseRunAppleScriptTool = {
  name: "computer_use_run_applescript",
  description:
    "Run an AppleScript command. Prefer this over click/type when possible - it doesn't move the cursor or interrupt foreground activity. Never use 'do shell script' inside AppleScript (blocked for security).",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description: "The AppleScript source code to execute",
      },
      reasoning: {
        type: "string",
        description:
          "Explanation of what this script does and why AppleScript is better than UI interaction for this step",
      },
      target_client_id: {
        type: "string",
        description:
          "ID of the specific client to target. Required when multiple clients support host_cu; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_cu`.",
      },
    },
    required: ["script", "reasoning"],
  },

  execute: proxyExecute("computer_use_run_applescript"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// done
// ---------------------------------------------------------------------------

export const computerUseDoneTool = {
  name: "computer_use_done",
  description:
    "Signal that the computer use task is complete. Provide a summary of what was accomplished. This ends the computer use session.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Human-readable summary of what was accomplished",
      },
    },
    required: ["summary"],
  },

  execute: proxyExecute("computer_use_done"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// respond
// ---------------------------------------------------------------------------

export const computerUseRespondTool = {
  name: "computer_use_respond",
  description:
    "Reply with a text answer instead of performing computer actions. Use this when you can answer directly without interacting with the screen.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      answer: {
        type: "string",
        description: "The text answer to display",
      },
      reasoning: {
        type: "string",
        description: "Explanation of how you determined the answer",
      },
    },
    required: ["answer", "reasoning"],
  },

  execute: proxyExecute("computer_use_respond"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------

export const computerUseObserveTool = {
  name: "computer_use_observe",
  description:
    "Capture the current screen state. Returns the accessibility tree with [ID] element references and optionally a screenshot.\n\nThe accessibility tree shows interactive elements like [3] AXButton 'Save' or [17] AXTextField 'Search'. Use element_id to target these elements in subsequent actions - this is much more reliable than pixel coordinates.\n\nCall this before your first computer use action, or to check screen state without acting.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      target_client_id: {
        type: "string",
        description:
          "ID of the specific client to target. Required when multiple clients support host_cu; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_cu`.",
      },
    },
    required: [],
  },

  execute: proxyExecute("computer_use_observe"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// All tools exported as array for convenience
// ---------------------------------------------------------------------------

export const allComputerUseTools: ToolDefinition[] = [
  computerUseObserveTool,
  computerUseClickTool,
  computerUseTypeTextTool,
  computerUseKeyTool,
  computerUseScrollTool,
  computerUseDragTool,
  computerUseWaitTool,
  computerUseOpenAppTool,
  computerUseRunAppleScriptTool,
  computerUseDoneTool,
  computerUseRespondTool,
];
