/**
 * Computer-use tool definitions.
 *
 * These tools mirror the desktop client's computer-use schemas, prefixed
 * with `computer_use_` to avoid collisions with existing daemon tools.  They are all
 * proxy tools. Execution is forwarded to a connected desktop client and never
 * handled locally by the daemon.
 */

import { RiskLevel } from "../../permissions/types.js";
import { formatDesktopAppRequired } from "../capability-offer.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Forward execution to the connected desktop client via the request-bound
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
        content: formatDesktopAppRequired("screen"),
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
    "Press a key or keyboard shortcut. Supported: enter, tab, escape, backspace, delete, up, down, left, right, space, cmd+a, cmd+c, cmd+v, cmd+z, cmd+tab, cmd+w, shift+tab, option+tab. On Windows use ctrl/alt in place of cmd/option.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description:
          "Key or shortcut to press (e.g. enter, tab, ctrl+c, cmd+c)",
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
  supportedClientOs: ["macos", "windows"],

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
    "Open or switch to a desktop application by name. Preferred over cmd+tab / alt+tab for switching apps - more reliable and explicit.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",
  supportedClientOs: ["macos", "windows"],

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
  supportedClientOs: ["macos"],

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
// sequence
// ---------------------------------------------------------------------------

export const computerUseSequenceTool = {
  name: "computer_use_sequence",
  description:
    "Run several computer-use actions you already know, in order, in one step, for example open an app, press cmd+n, type a URL and press enter. Use it when no action depends on seeing the result of the one before; otherwise act one step at a time. Element IDs refer to the latest observation, so use them only for actions that act before the screen changes. Stops at the first action that is refused or fails and reports which one. Returns one observation after the last action.",
  category: "computer-use",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",
  supportedClientOs: ["macos"],

  input_schema: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        description: "The actions to run, in order",
        items: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "key",
                "type_text",
                "type",
                "click",
                "double_click",
                "right_click",
                "scroll",
                "wait",
                "open_app",
              ],
              description: "The action to run",
            },
            key: {
              type: "string",
              description:
                "key: key or shortcut to press (e.g. enter, tab, cmd+n)",
            },
            text: {
              type: "string",
              description: "type_text (or type): the text to type",
            },
            element_id: {
              type: "integer",
              description:
                "click, double_click, right_click, scroll: the [ID] of the element from the latest accessibility tree (preferred)",
            },
            x: {
              type: "integer",
              description:
                "click, double_click, right_click, scroll: X coordinate on screen (fallback when no element_id)",
            },
            y: {
              type: "integer",
              description:
                "click, double_click, right_click, scroll: Y coordinate on screen (fallback when no element_id)",
            },
            direction: {
              type: "string",
              enum: ["up", "down", "left", "right"],
              description: "scroll: scroll direction",
            },
            amount: {
              type: "integer",
              description: "scroll: scroll amount (1-10)",
            },
            duration_ms: {
              type: "integer",
              description: "wait: milliseconds to wait",
            },
            app_name: {
              type: "string",
              description:
                'open_app: the name of the application to open (e.g. "Google Chrome")',
            },
            reasoning: {
              type: "string",
              description: "Optional: why this action",
            },
          },
          required: ["action"],
        },
      },
      reasoning: {
        type: "string",
        description:
          "Optional: what these actions do together. Reasoning on each action works too",
      },
      target_client_id: {
        type: "string",
        description:
          "ID of the specific client to target. Required when multiple clients support host_cu; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_cu`.",
      },
    },
    required: ["actions"],
  },

  execute: proxyExecute("computer_use_sequence"),
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
      capture_window_id: {
        type: "integer",
        minimum: 1,
        maximum: 4294967295,
        description:
          "macOS only: capture this native CGWindowID instead of the desktop, including only its accessibility tree. Obtain a current native window ID first; do not guess or use a browser tab ID. Applies to this observation only, not subsequent actions. Requires a desktop helper with window-capture support. Screenshot coordinates are window-relative; use accessibility element IDs for later actions, not desktop scaling.",
      },
      include_screenshot: {
        type: "boolean",
        description:
          "Force a screenshot with this observation. The accessibility tree is returned every step; ask for pixels whenever the tree is not enough to act on, such as a canvas, a game, a custom-drawn view, a window with few or unlabeled controls, or a question about layout.",
      },
      full_tree: {
        type: "boolean",
        description:
          "Walk the accessibility tree to full depth. Observations list the tree to a limited depth and say when it was cut off; pass this when the element you need is not in the tree.",
      },
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
  computerUseSequenceTool,
  computerUseDoneTool,
  computerUseRespondTool,
];
