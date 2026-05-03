/**
 * App-control tool definitions.
 *
 * These tools target a specific application (by bundle ID or process name) on
 * the desktop client (host machine). Each tool is a proxy: execution is
 * forwarded to the connected client and never handled locally by the daemon.
 *
 * The eight tools mirror the input wire types declared in
 * `daemon/message-types/host-app-control.ts`:
 *   start | observe | press | combo | type | click | drag | stop
 *
 * Distinct from the system-wide `computer_use_*` proxy tools — app-control
 * scopes input/observation to a single targeted app window.
 */

import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import type { Tool, ToolExecutionResult } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function proxyExecute(): Promise<ToolExecutionResult> {
  throw new Error("app-control tool must be forwarded to the connected client");
}

const activityProperty = {
  type: "string" as const,
  description:
    "Brief non-technical explanation of why this tool is being called",
};

const appProperty = {
  type: "string" as const,
  description:
    "Bundle ID (preferred, e.g. 'com.apple.Safari') or process name of the target application",
};

const buttonEnum = ["left", "right", "middle"] as const;

// ---------------------------------------------------------------------------
// start — launch (or focus) the target app, optionally with CLI args
// ---------------------------------------------------------------------------

export const appControlStartTool: Tool = {
  name: "app_control_start",
  description:
    "Start (launch or focus) the target application. Optionally pass command-line arguments. Begins an app-control session targeting this app.",
  category: "app-control",
  defaultRiskLevel: RiskLevel.Medium,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          app: appProperty,
          args: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional command-line arguments to launch the app with",
          },
          reasoning: {
            type: "string",
            description: "Explanation of why you are starting this app",
          },
          activity: activityProperty,
        },
        required: ["app", "reasoning"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// observe — capture window state of the target app
// ---------------------------------------------------------------------------

export const appControlObserveTool: Tool = {
  name: "app_control_observe",
  description:
    "Capture the current window state of the target application — returns lifecycle state (running/missing/minimized/occluded), an optional screenshot, and window bounds. Use this before issuing input actions, or to check progress without acting.",
  category: "app-control",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          app: appProperty,
          activity: activityProperty,
        },
        required: ["app", "activity"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// press — single key with optional modifiers and hold duration
// ---------------------------------------------------------------------------

export const appControlPressTool: Tool = {
  name: "app_control_press",
  description:
    "Press a single key in the target application, with optional modifiers (cmd/shift/option/ctrl) and a hold duration in milliseconds.",
  category: "app-control",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          app: appProperty,
          key: {
            type: "string",
            description: 'Key identifier, e.g. "return", "a", "f12"',
          },
          modifiers: {
            type: "array",
            items: { type: "string" },
            description:
              'Modifier list, e.g. ["cmd", "shift"]. Omit for no modifiers.',
          },
          duration_ms: {
            type: "integer",
            description: "Hold duration in milliseconds",
          },
          reasoning: {
            type: "string",
            description: "Explanation of why you are pressing this key",
          },
          activity: activityProperty,
        },
        required: ["app", "key", "reasoning"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// combo — multiple keys pressed simultaneously
// ---------------------------------------------------------------------------

export const appControlComboTool: Tool = {
  name: "app_control_combo",
  description:
    "Press multiple keys simultaneously in the target application (e.g. cmd+shift+4). Use for keyboard shortcuts where every key is held at once.",
  category: "app-control",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          app: appProperty,
          keys: {
            type: "array",
            items: { type: "string" },
            description:
              'Sequence of keys pressed simultaneously, e.g. ["cmd", "shift", "4"]',
          },
          duration_ms: {
            type: "integer",
            description: "Hold duration in milliseconds",
          },
          reasoning: {
            type: "string",
            description: "Explanation of why you are pressing this combo",
          },
          activity: activityProperty,
        },
        required: ["app", "keys", "reasoning"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// type — type literal text into the target app
// ---------------------------------------------------------------------------

export const appControlTypeTool: Tool = {
  name: "app_control_type",
  description:
    "Type literal text into the target application at the current focus. Ensure the intended field is focused before calling.",
  category: "app-control",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          app: appProperty,
          text: {
            type: "string",
            description: "The text to type",
          },
          reasoning: {
            type: "string",
            description: "Explanation of what you are typing and why",
          },
          activity: activityProperty,
        },
        required: ["app", "text", "reasoning"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// click — click at window-relative (x, y) coordinates
// ---------------------------------------------------------------------------

export const appControlClickTool: Tool = {
  name: "app_control_click",
  description:
    "Click at the given (x, y) coordinates inside the target application's window. Defaults to a single left-click; pass `button` and/or `double` to vary.",
  category: "app-control",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          app: appProperty,
          x: {
            type: "integer",
            description: "X coordinate (window-relative)",
          },
          y: {
            type: "integer",
            description: "Y coordinate (window-relative)",
          },
          button: {
            type: "string",
            enum: [...buttonEnum],
            description: 'Mouse button (default: "left")',
          },
          double: {
            type: "boolean",
            description: "When true, performs a double-click",
          },
          reasoning: {
            type: "string",
            description:
              "Explanation of what you see and why you are clicking here",
          },
          activity: activityProperty,
        },
        required: ["app", "x", "y", "reasoning"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// drag — drag from one coord to another inside the target app
// ---------------------------------------------------------------------------

export const appControlDragTool: Tool = {
  name: "app_control_drag",
  description:
    "Drag from (from_x, from_y) to (to_x, to_y) inside the target application's window. Defaults to left button.",
  category: "app-control",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          app: appProperty,
          from_x: {
            type: "integer",
            description: "Source X coordinate (window-relative)",
          },
          from_y: {
            type: "integer",
            description: "Source Y coordinate (window-relative)",
          },
          to_x: {
            type: "integer",
            description: "Destination X coordinate (window-relative)",
          },
          to_y: {
            type: "integer",
            description: "Destination Y coordinate (window-relative)",
          },
          button: {
            type: "string",
            enum: [...buttonEnum],
            description: 'Mouse button (default: "left")',
          },
          reasoning: {
            type: "string",
            description: "Explanation of what you are dragging and why",
          },
          activity: activityProperty,
        },
        required: ["app", "from_x", "from_y", "to_x", "to_y", "reasoning"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// stop — terminal: end the app-control session
// ---------------------------------------------------------------------------

export const appControlStopTool: Tool = {
  name: "app_control_stop",
  description:
    "Stop the current app-control session. When `app` is omitted, stops whichever app currently holds the session. This is the terminal action for an app-control flow.",
  category: "app-control",
  defaultRiskLevel: RiskLevel.Low,
  executionMode: "proxy",

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description:
              "Optional bundle ID or process name. When omitted, stops whichever app currently holds the session.",
          },
          reason: {
            type: "string",
            description: "Free-form reason, surfaced for logging",
          },
          activity: activityProperty,
        },
        required: ["activity"],
      },
    };
  },

  execute: proxyExecute,
};

// ---------------------------------------------------------------------------
// All tools exported as array for convenience
// ---------------------------------------------------------------------------

export const appControlTools: Tool[] = [
  appControlStartTool,
  appControlObserveTool,
  appControlPressTool,
  appControlComboTool,
  appControlTypeTool,
  appControlClickTool,
  appControlDragTool,
  appControlStopTool,
];
