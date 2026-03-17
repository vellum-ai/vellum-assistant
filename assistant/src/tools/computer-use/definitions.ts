/**
 * Computer-use tool definitions.
 *
 * These tools mirror the macOS client's ToolDefinitions.swift schemas, prefixed
 * with `computer_use_` to avoid collisions with existing daemon tools.  They are all
 * proxy tools - execution is forwarded to a connected macOS client and never
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

const reasonProperty = {
  type: "string" as const,
  description:
    "Brief non-technical explanation of why this tool is being called",
};

// ---------------------------------------------------------------------------
// click (unified - click_type selects single / double / right)
// ---------------------------------------------------------------------------

export const computerUseClickTool: Tool = {
  name: "computer_use_click",
  description:
    "Click an element on screen. Prefer element_id (from the accessibility tree) over x/y coordinates.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
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
          reason: reasonProperty,
        },
        required: ["reasoning"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// type_text
// ---------------------------------------------------------------------------

export const computerUseTypeTextTool: Tool = {
  name: "computer_use_type_text",
  description:
    "Type text at the current cursor position. First click a text field (by element_id) to focus it, then call this tool. If a field shows 'FOCUSED', skip the click.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
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
          reason: reasonProperty,
        },
        required: ["text", "reasoning"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// key
// ---------------------------------------------------------------------------

export const computerUseKeyTool: Tool = {
  name: "computer_use_key",
  description:
    "Press a key or keyboard shortcut. Supported: enter, tab, escape, backspace, delete, up, down, left, right, space, cmd+a, cmd+c, cmd+v, cmd+z, cmd+tab, cmd+w, shift+tab, option+tab",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "Key or shortcut to press (e.g. enter, tab, cmd+c, cmd+v)",
          },
          reasoning: {
            type: "string",
            description: "Explanation of why you are pressing this key",
          },
          reason: reasonProperty,
        },
        required: ["key", "reasoning"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// scroll
// ---------------------------------------------------------------------------

export const computerUseScrollTool: Tool = {
  name: "computer_use_scroll",
  description:
    "Scroll within an element by its [ID], or at raw screen coordinates as fallback.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
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
          reason: reasonProperty,
        },
        required: ["direction", "amount", "reasoning"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// drag
// ---------------------------------------------------------------------------

export const computerUseDragTool: Tool = {
  name: "computer_use_drag",
  description:
    "Drag from one element or position to another. Use for moving files, resizing windows, rearranging items, or adjusting sliders.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          element_id: {
            type: "integer",
            description:
              "The [ID] of the source element to drag from (preferred)",
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
          reason: reasonProperty,
        },
        required: ["reasoning"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// wait
// ---------------------------------------------------------------------------

export const computerUseWaitTool: Tool = {
  name: "computer_use_wait",
  description: "Wait for the UI to update",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
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
          reason: reasonProperty,
        },
        required: ["duration_ms", "reasoning"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// open_app
// ---------------------------------------------------------------------------

export const computerUseOpenAppTool: Tool = {
  name: "computer_use_open_app",
  description:
    "Open or switch to a macOS application by name. Preferred over cmd+tab for switching apps - more reliable and explicit.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
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
          reason: reasonProperty,
        },
        required: ["app_name", "reasoning"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// run_applescript
// ---------------------------------------------------------------------------

export const computerUseRunAppleScriptTool: Tool = {
  name: "computer_use_run_applescript",
  description:
    "Run an AppleScript command. Prefer this over click/type when possible - it doesn't move the cursor or interrupt the user. Never use 'do shell script' inside AppleScript (blocked for security).",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
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
          reason: reasonProperty,
        },
        required: ["script", "reasoning"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// done
// ---------------------------------------------------------------------------

export const computerUseDoneTool: Tool = {
  name: "computer_use_done",
  description:
    "Signal that the computer use task is complete. Provide a summary of what was accomplished. This ends the computer use session.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Human-readable summary of what was accomplished",
          },
          reason: reasonProperty,
        },
        required: ["summary"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// respond
// ---------------------------------------------------------------------------

export const computerUseRespondTool: Tool = {
  name: "computer_use_respond",
  description:
    "Respond to the user with a text answer instead of performing computer actions. Use this when you can answer directly without interacting with the screen.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          answer: {
            type: "string",
            description: "The text answer to display to the user",
          },
          reasoning: {
            type: "string",
            description: "Explanation of how you determined the answer",
          },
          reason: reasonProperty,
        },
        required: ["answer", "reasoning"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------

export const computerUseObserveTool: Tool = {
  name: "computer_use_observe",
  description:
    "Capture the current screen state. Returns the accessibility tree with [ID] element references and optionally a screenshot.\n\nThe accessibility tree shows interactive elements like [3] AXButton 'Save' or [17] AXTextField 'Search'. Use element_id to target these elements in subsequent actions - this is much more reliable than pixel coordinates.\n\nCall this before your first computer use action, or to check screen state without acting.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          reason: reasonProperty,
        },
        required: ["reason"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// All tools exported as array for convenience
// ---------------------------------------------------------------------------

export const allComputerUseTools: Tool[] = [
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
